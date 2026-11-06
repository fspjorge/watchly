import { diffLines, type DiffChunk } from './diff.ts';
import { extractTextFromHtml, normalizeText } from './extract.ts';
import { fetchPage, ScrapeError, validateMonitorUrl } from './scrape.ts';

/** SHA-256 do conteúdo normalizado, em hexadecimal. */
export async function sha256Hex(content: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** Intervalo mínimo entre verificações, para evitar pedidos duplicados acidentais. */
const MIN_CHECK_INTERVAL_MS = 2000;

export type MonitorStatus = 'pending' | 'unchanged' | 'changed' | 'error';

export type MonitorRow = {
	id: string;
	name: string;
	url: string;
	created_at: string;
	last_checked_at: string | null;
	last_status: MonitorStatus;
	last_error: string | null;
};

export type MonitorCheckResult =
	| { outcome: 'initial'; message: string }
	| { outcome: 'unchanged'; message: string }
	| { outcome: 'changed'; message: string }
	| { outcome: 'error'; message: string };

export type SnapshotRow = {
	id: number;
	monitor_id: string;
	content: string;
	content_hash: string;
	captured_at: string;
};

export class ApiError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export async function listMonitors(db: D1Database): Promise<MonitorRow[]> {
	const { results } = await db
		.prepare(
			`SELECT id, name, url, created_at, last_checked_at, last_status, last_error
			 FROM monitors ORDER BY created_at DESC`,
		)
		.all<MonitorRow>();
	return results;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createMonitor(
	db: D1Database,
	input: { name?: unknown; url?: unknown },
): Promise<MonitorRow> {
	const name = typeof input.name === 'string' ? input.name.trim() : '';
	const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';

	if (name.length === 0) {
		throw new ApiError(400, 'Indica o nome da monitorização.');
	}
	if (name.length > 120) {
		throw new ApiError(400, 'O nome é demasiado longo (máximo 120 caracteres).');
	}
	if (rawUrl.length === 0) {
		throw new ApiError(400, 'Indica o URL da página.');
	}

	let url: string;
	try {
		url = validateMonitorUrl(rawUrl);
	} catch (error) {
		throw new ApiError(400, error instanceof Error ? error.message : 'URL inválido.');
	}

	const id = crypto.randomUUID();

	await db
		.prepare(
			`INSERT INTO monitors (id, name, url, last_status)
			 VALUES (?, ?, ?, 'pending')`,
		)
		.bind(id, name, url)
		.run();

	const created = await getMonitor(db, id);
	if (!created) {
		throw new ApiError(500, 'Não foi possível criar a monitorização.');
	}
	return created;
}

async function getMonitor(db: D1Database, id: string): Promise<MonitorRow | null> {
	if (!UUID_RE.test(id)) return null;
	return db
		.prepare(
			`SELECT id, name, url, created_at, last_checked_at, last_status, last_error
			 FROM monitors WHERE id = ?`,
		)
		.bind(id)
		.first<MonitorRow>();
}

async function getLatestSnapshot(
	db: D1Database,
	monitorId: string,
): Promise<SnapshotRow | null> {
	return db
		.prepare(
			`SELECT id, monitor_id, content, content_hash, captured_at
			 FROM snapshots WHERE monitor_id = ?
			 ORDER BY captured_at DESC, id DESC LIMIT 1`,
		)
		.bind(monitorId)
		.first<SnapshotRow>();
}

async function markError(db: D1Database, id: string, message: string): Promise<void> {
	await db
		.prepare(
			`UPDATE monitors
			 SET last_checked_at = CURRENT_TIMESTAMP, last_status = 'error', last_error = ?
			 WHERE id = ?`,
		)
		.bind(message.slice(0, 500), id)
		.run();
}

/**
 * Verifica uma monitorização: recolhe a página, compara com a última versão
 * e grava um novo snapshot apenas quando o conteúdo mudou.
 */
export async function checkMonitor(
	db: D1Database,
	id: string,
): Promise<MonitorCheckResult> {
	const monitor = await getMonitor(db, id);
	if (!monitor) {
		throw new ApiError(404, 'Monitorização não encontrada.');
	}

	if (
		monitor.last_checked_at &&
		Date.now() - Date.parse(monitor.last_checked_at) < MIN_CHECK_INTERVAL_MS
	) {
		throw new ApiError(429, 'A verificação acabou de ser efectuada. Aguarda uns instantes.');
	}

	let normalized: string;
	try {
		const page = await fetchPage(monitor.url);
		normalized = normalizeText(extractTextFromHtml(page.text));
		if (normalized.length === 0) {
			throw new ScrapeError('A página não devolveu texto utilizável.');
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Falha ao recolher a página.';
		await markError(db, id, message);
		return { outcome: 'error', message };
	}

	const contentHash = await sha256Hex(normalized);
	const latest = await getLatestSnapshot(db, id);

	if (!latest) {
		await db
			.prepare(
				`INSERT INTO snapshots (monitor_id, content, content_hash, captured_at)
				 VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
			)
			.bind(id, normalized, contentHash)
			.run();
		await db
			.prepare(
				`UPDATE monitors
				 SET last_checked_at = CURRENT_TIMESTAMP, last_status = 'unchanged', last_error = NULL
				 WHERE id = ?`,
			)
			.bind(id)
			.run();
		return { outcome: 'initial', message: 'Referência inicial criada.' };
	}

	if (latest.content_hash === contentHash) {
		// Sem alterações: não se cria um novo snapshot.
		await db
			.prepare(
				`UPDATE monitors
				 SET last_checked_at = CURRENT_TIMESTAMP, last_status = 'unchanged', last_error = NULL
				 WHERE id = ?`,
			)
			.bind(id)
			.run();
		return { outcome: 'unchanged', message: 'Sem alterações.' };
	}

	await db
		.prepare(
			`INSERT INTO snapshots (monitor_id, content, content_hash, captured_at)
			 VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
		)
		.bind(id, normalized, contentHash)
		.run();
	await db
		.prepare(
			`UPDATE monitors
			 SET last_checked_at = CURRENT_TIMESTAMP, last_status = 'changed', last_error = NULL
			 WHERE id = ?`,
		)
		.bind(id)
		.run();
	return { outcome: 'changed', message: 'Alterações detectadas.' };
}

export type MonitorDiff = {
	monitor: MonitorRow;
	before: { id: number; captured_at: string };
	after: { id: number; captured_at: string };
	chunks: DiffChunk[];
	addedCount: number;
	removedCount: number;
};

/**
 * Compara os dois últimos snapshots de uma monitorização.
 * Devolve null quando ainda não há duas versões para comparar.
 */
export async function getMonitorDiff(
	db: D1Database,
	id: string,
): Promise<MonitorDiff | null> {
	const monitor = await getMonitor(db, id);
	if (!monitor) {
		throw new ApiError(404, 'Monitorização não encontrada.');
	}

	const { results } = await db
		.prepare(
			`SELECT id, monitor_id, content, content_hash, captured_at
			 FROM snapshots WHERE monitor_id = ?
			 ORDER BY captured_at DESC, id DESC LIMIT 2`,
		)
		.bind(id)
		.all<SnapshotRow>();
	const snapshots = results;

	if (snapshots.length < 2) return null;

	const [after, before] = snapshots;
	const chunks = diffLines(before.content.split('\n'), after.content.split('\n'));

	return {
		monitor,
		before: { id: before.id, captured_at: before.captured_at },
		after: { id: after.id, captured_at: after.captured_at },
		chunks,
		addedCount: chunks
			.filter((chunk) => chunk.type === 'added')
			.reduce((accumulator, chunk) => accumulator + chunk.lines.length, 0),
		removedCount: chunks
			.filter((chunk) => chunk.type === 'removed')
			.reduce((accumulator, chunk) => accumulator + chunk.lines.length, 0),
	};
}

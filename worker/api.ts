import { diffLines, type DiffChunk } from './diff.ts';
import { extractTextFromHtml, normalizeText } from './extract.ts';
import { fetchPage, ScrapeError, validateMonitorUrl } from './scrape.ts';
import type { Queryable } from './db.ts';
import type { UserRecord } from './auth.ts';

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
	user_id: string | null;
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
	source_url: string;
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

/**
 * Lista as monitorizações do utilizador autenticado.
 * Registos com user_id IS NULL (antigos, ainda por associar) ficam invisíveis.
 */
export async function listMonitors(db: Queryable, user: UserRecord): Promise<MonitorRow[]> {
	return db.all<MonitorRow>(
		`SELECT id, name, url, user_id, created_at, last_checked_at, last_status, last_error
		 FROM monitors WHERE user_id = ? ORDER BY created_at DESC`,
		[user.id],
	);
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateName(input: unknown): string {
	const name = typeof input === 'string' ? input.trim() : '';
	if (name.length === 0) {
		throw new ApiError(400, 'Indica o nome da monitorização.');
	}
	if (name.length > 120) {
		throw new ApiError(400, 'O nome é demasiado longo (máximo 120 caracteres).');
	}
	return name;
}

function validateUrlOr400(raw: unknown): string {
	const text = typeof raw === 'string' ? raw.trim() : '';
	if (text.length === 0) {
		throw new ApiError(400, 'Indica o URL da página.');
	}
	try {
		return validateMonitorUrl(text);
	} catch (error) {
		throw new ApiError(400, error instanceof Error ? error.message : 'URL inválido.');
	}
}

export async function createMonitor(
	db: Queryable,
	user: UserRecord,
	input: { name?: unknown; url?: unknown },
): Promise<MonitorRow> {
	const name = validateName(input.name);
	const url = validateUrlOr400(input.url);
	const id = crypto.randomUUID();

	await db
		.run(
			`INSERT INTO monitors (id, name, url, user_id, last_status)
			 VALUES (?, ?, ?, ?, 'pending')`,
			[id, name, url, user.id],
		);

	const created = await getOwnedMonitor(db, user, id);
	if (!created) {
		throw new ApiError(500, 'Não foi possível criar a monitorização.');
	}
	return created;
}

/** Localiza uma monitorização por id E proprietário; sem propriedade → 404. */
async function getOwnedMonitor(
	db: Queryable,
	user: UserRecord,
	id: string,
): Promise<MonitorRow | null> {
	if (!UUID_RE.test(id)) return null;
	return db.one<MonitorRow>(
		`SELECT id, name, url, user_id, created_at, last_checked_at, last_status, last_error
		 FROM monitors WHERE id = ? AND user_id = ?`,
		[id, user.id],
	);
}

async function requireOwnedMonitor(db: Queryable, user: UserRecord, id: string): Promise<MonitorRow> {
	const monitor = await getOwnedMonitor(db, user, id);
	if (!monitor) {
		// 404: não revela a existência de recursos de outros utilizadores.
		throw new ApiError(404, 'Monitorização não encontrada.');
	}
	return monitor;
}

/**
 * Edita nome e/ou URL. Ao alterar o URL:
 *  - os snapshots antigos são preservados com o seu source_url;
 *  - o estado passa a 'pending' e a primeira verificação do novo URL cria
 *    uma referência nova, sem comparação com o conteúdo do URL anterior.
 */
export async function updateMonitor(
	db: Queryable,
	user: UserRecord,
	id: string,
	input: { name?: unknown; url?: unknown },
): Promise<MonitorRow> {
	const monitor = await requireOwnedMonitor(db, user, id);

	const hasName = input.name !== undefined;
	const hasUrl = input.url !== undefined;
	if (!hasName && !hasUrl) {
		throw new ApiError(400, 'Indica pelo menos o nome ou o URL a actualizar.');
	}

	const name = hasName ? validateName(input.name) : monitor.name;
	let url = monitor.url;
	let urlChanged = false;
	if (hasUrl) {
		const newUrl = validateUrlOr400(input.url);
		urlChanged = newUrl !== monitor.url;
		url = newUrl;
	}

	await db.run(
		urlChanged
			? `UPDATE monitors
				 SET name = ?, url = ?, last_status = 'pending', last_checked_at = NULL, last_error = NULL
				 WHERE id = ? AND user_id = ?`
			: `UPDATE monitors SET name = ? WHERE id = ? AND user_id = ?`,
		urlChanged ? [name, url, id, user.id] : [name, id, user.id],
	);

	const updated = await getOwnedMonitor(db, user, id);
	if (!updated) {
		throw new ApiError(500, 'Não foi possível actualizar a monitorização.');
	}
	return updated;
}

/** Apaga a monitorização do utilizador e os respectivos snapshots. */
export async function deleteMonitor(db: Queryable, user: UserRecord, id: string): Promise<void> {
	await requireOwnedMonitor(db, user, id);
	if (!UUID_RE.test(id)) return;
	// Instrução única: os snapshots são apagados por ON DELETE CASCADE
	// (FK de snapshots.monitor_id, declarada em 0001 e activa em D1 e nos
	// testes). Elimina a janela de inconsistência entre dois statements.
	await db.run('DELETE FROM monitors WHERE id = ? AND user_id = ?', [id, user.id]);
}

async function getLatestSnapshot(
	db: Queryable,
	monitor: MonitorRow,
): Promise<SnapshotRow | null> {
	return db.one<SnapshotRow>(
		`SELECT id, monitor_id, source_url, content, content_hash, captured_at
		 FROM snapshots WHERE monitor_id = ? AND source_url = ?
		 ORDER BY captured_at DESC, id DESC LIMIT 1`,
		[monitor.id, monitor.url],
	);
}

async function markError(db: Queryable, id: string, message: string): Promise<void> {
	await db.run(
		`UPDATE monitors
		 SET last_checked_at = CURRENT_TIMESTAMP, last_status = 'error', last_error = ?
		 WHERE id = ?`,
		[message.slice(0, 500), id],
	);
}

/**
 * Verifica uma monitorização: recolhe a página, compara com a última versão
 * do MESMO URL e grava um novo snapshot apenas quando o conteúdo mudou.
 * A propriedade é confirmada antes de qualquer recolha.
 */
export async function checkMonitor(
	db: Queryable,
	user: UserRecord,
	id: string,
): Promise<MonitorCheckResult> {
	const monitor = await requireOwnedMonitor(db, user, id);

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
	const latest = await getLatestSnapshot(db, monitor);

	if (!latest) {
		await db.run(
			`INSERT INTO snapshots (monitor_id, source_url, content, content_hash, captured_at)
			 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
			[id, monitor.url, normalized, contentHash],
		);
		await db.run(
			`UPDATE monitors
			 SET last_checked_at = CURRENT_TIMESTAMP, last_status = 'unchanged', last_error = NULL
			 WHERE id = ?`,
			[id],
		);
		return { outcome: 'initial', message: 'Referência inicial criada.' };
	}

	if (latest.content_hash === contentHash) {
		// Sem alterações: não se cria um novo snapshot.
		await db.run(
			`UPDATE monitors
			 SET last_checked_at = CURRENT_TIMESTAMP, last_status = 'unchanged', last_error = NULL
			 WHERE id = ?`,
			[id],
		);
		return { outcome: 'unchanged', message: 'Sem alterações.' };
	}

	await db.run(
		`INSERT INTO snapshots (monitor_id, source_url, content, content_hash, captured_at)
		 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
		[id, monitor.url, normalized, contentHash],
	);
	await db.run(
		`UPDATE monitors
		 SET last_checked_at = CURRENT_TIMESTAMP, last_status = 'changed', last_error = NULL
		 WHERE id = ?`,
		[id],
	);
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
 * Compara os dois últimos snapshots da monitorização e do URL ACTUAL.
 * Nunca compara versões de URLs diferentes.
 */
export async function getMonitorDiff(
	db: Queryable,
	user: UserRecord,
	id: string,
): Promise<MonitorDiff | null> {
	const monitor = await requireOwnedMonitor(db, user, id);

	const snapshots = await db.all<SnapshotRow>(
		`SELECT id, monitor_id, source_url, content, content_hash, captured_at
		 FROM snapshots WHERE monitor_id = ? AND source_url = ?
		 ORDER BY captured_at DESC, id DESC LIMIT 2`,
		[monitor.id, monitor.url],
	);

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

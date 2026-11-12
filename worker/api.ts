import { diffLines, type DiffChunk } from './diff.ts';
import { extractTextFromHtml } from './extract.ts';
import { fetchPage, ScrapeError, validateMonitorUrl } from './scrape.ts';
import type { Queryable } from './db.ts';
import type { UserRecord } from './auth.ts';
import { claimOwnedMonitor, finaliseCheck, isFrequencyValid, releaseLease } from './scheduling.ts';
import { configuredCheckEngine, prepareGoogleCheck, type CheckEngineEnv } from './googleCheck.ts';
import { GoogleDailyLimitReachedError, GoogleQuotaStorageError, parseGoogleDailyLimit, reserveGoogleDailyRequest } from './googleQuota.ts';

/** SHA-256 do conteúdo normalizado, em hexadecimal. */
export async function sha256Hex(content: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
	const bytes = new Uint8Array(digest);
	const hex = '0123456789abcdef';
	let encoded = '';
	for (const byte of bytes) {
		encoded += hex[byte >>> 4] + hex[byte & 0x0f];
	}
	return encoded;
}

/** Intervalo mínimo entre verificações, para evitar pedidos duplicados acidentais. */
const MIN_CHECK_INTERVAL_MS = 2000;
const INVALID_FREQUENCY_MESSAGE =
	'Frequência inválida. Valores aceites: manual (null), 15, 30, 60, 360, 720 ou 1440 minutos.';

/** Partilha entre criação e PATCH a regra de início/reinício do agendamento. */
function nextCheckAtAfterConfigChange(
	previousFrequency: number | null,
	previousNextCheckAt: number | null,
	nextFrequency: number | null,
	urlChanged: boolean,
	nowSeconds: number,
): number | null {
	if (nextFrequency === null) {
		return previousFrequency !== null || urlChanged ? null : previousNextCheckAt;
	}
	if (urlChanged) return nowSeconds + nextFrequency * 60;
	if (previousFrequency === nextFrequency) return previousNextCheckAt;
	return previousFrequency === null ? nowSeconds : nowSeconds + nextFrequency * 60;
}

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
	frequency_minutes: number | null;
	next_check_at: number | null;
};

/** Colunas lidas em qualquer SELECT de monitorizações. */
const MONITOR_COLUMNS =
	'id, name, url, user_id, created_at, last_checked_at, last_status, last_error, ' +
	'frequency_minutes, next_check_at';

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
		`SELECT ${MONITOR_COLUMNS}
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
	input: { name?: unknown; url?: unknown; frequency_minutes?: unknown },
): Promise<MonitorRow> {
	const name = validateName(input.name);
	const url = validateUrlOr400(input.url);
	const requestedFrequency = input.frequency_minutes;
	let frequency: number | null = null;
	if (requestedFrequency !== undefined) {
		if (!isFrequencyValid(requestedFrequency)) {
			throw new ApiError(400, INVALID_FREQUENCY_MESSAGE);
		}
		frequency = requestedFrequency;
	}
	const nowSeconds = Math.floor(Date.now() / 1000);
	const nextCheckAt = nextCheckAtAfterConfigChange(null, null, frequency, false, nowSeconds);
	const id = crypto.randomUUID();

	await db
		.run(
			`INSERT INTO monitors
			   (id, name, url, user_id, last_status, frequency_minutes, next_check_at)
			 VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
			[id, name, url, user.id, frequency, nextCheckAt],
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
		`SELECT ${MONITOR_COLUMNS}
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
 * Edita nome, URL e/ou frequência. Ao alterar o URL:
 *  - os snapshots antigos são preservados com o seu source_url;
 *  - o estado passa a 'pending' e a primeira verificação do novo URL cria
 *    uma referência nova, sem comparação com o conteúdo do URL anterior;
 *  - o agendamento reinicia: próxima verificação = agora + frequência
 *    (se activa; NULL se manual).
 * Ao alterar a frequência:
 *  - activar (número) agenda a primeira verificação para já;
 *  - desactivar (NULL) esvazia o agendamento.
 */
export async function updateMonitor(
	db: Queryable,
	user: UserRecord,
	id: string,
	input: { name?: unknown; url?: unknown; frequency_minutes?: unknown },
): Promise<MonitorRow> {
	const monitor = await requireOwnedMonitor(db, user, id);

	const hasName = input.name !== undefined;
	const hasUrl = input.url !== undefined;
	const hasFrequency = input.frequency_minutes !== undefined;
	if (!hasName && !hasUrl && !hasFrequency) {
		throw new ApiError(400, 'Indica pelo menos o nome, o URL ou a frequência a actualizar.');
	}

	const name = hasName ? validateName(input.name) : monitor.name;
	let url = monitor.url;
	let urlChanged = false;
	if (hasUrl) {
		const newUrl = validateUrlOr400(input.url);
		urlChanged = newUrl !== monitor.url;
		url = newUrl;
	}

	let frequency = monitor.frequency_minutes;
	let frequencyChanged = false;
	if (hasFrequency) {
		if (!isFrequencyValid(input.frequency_minutes)) {
			throw new ApiError(400, INVALID_FREQUENCY_MESSAGE);
		}
		frequency = input.frequency_minutes;
		frequencyChanged =
			frequency !== monitor.frequency_minutes;
	}

	const nowSeconds = Math.floor(Date.now() / 1000);
	// Renomear sem alterar URL/frequência preserva next_check_at; a criação e
	// a activação manual → agendada partilham a mesma regra de início imediato.
	const nextCheckAt = nextCheckAtAfterConfigChange(
		monitor.frequency_minutes,
		monitor.next_check_at,
		frequency,
		urlChanged,
		nowSeconds,
	);

	const assignments: string[] = [];
	const params: unknown[] = [];
	if (hasName || hasUrl) {
		assignments.push('name = ?');
		params.push(name);
		if (urlChanged) {
			assignments.push(
				'url = ?',
				"last_status = 'pending'",
				'last_checked_at = NULL',
				'last_error = NULL',
			);
			params.push(url);
		}
	}
	if (frequencyChanged) {
		assignments.push('frequency_minutes = ?');
		params.push(frequency);
	}
	// next_check_at escreve-se apenas quando muda (evita UPDATE redundante).
	if (nextCheckAt !== monitor.next_check_at) {
		assignments.push('next_check_at = ?');
		params.push(nextCheckAt);
	}

	if (assignments.length > 0) {
		await db.run(
			`UPDATE monitors
			 SET ${assignments.join(', ')}
			 WHERE id = ? AND user_id = ?`,
			[...params, id, user.id],
		);
	}

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

export type PersistCheckInput = {
	id: string;
	expectedUrl: string;
	leaseToken: string;
	leaseNow?: number;
	status: MonitorStatus;
	lastError?: string | null;
	snapshot?: { sourceUrl: string; content: string; contentHash: string };
	notification?: {
		id: string;
		appUrl?: string;
		senderEmail?: string;
		senderName?: string;
		previousSnapshotId?: number | null;
	};
	errorNotification?: {
		id: string;
		sourceUrl: string;
		httpStatus?: number;
		description: string;
		appUrl?: string;
		senderEmail?: string;
		senderName?: string;
	};
};

/** Persiste o resultado apenas se o lease continuar válido; D1 batch torna
 * inseparáveis a inserção do snapshot e a actualização do estado. */
export async function persistCheckResults(db: Queryable, input: PersistCheckInput): Promise<boolean> {
	const guard = `id = ? AND url = ? AND lease_token = ? AND
		lease_expires_at > COALESCE(?, (julianday('now') - 2440587.5) * 86400)`;
	const operations = [{
		// Renova apenas um lease que ainda pertence ao executor e não expirou.
		// O batch mantém a linha bloqueada até snapshot + estado serem gravados.
		sql: `UPDATE monitors
			SET lease_expires_at = MAX(lease_expires_at,
			    COALESCE(?, (julianday('now') - 2440587.5) * 86400) + 180)
			WHERE ${guard}`,
		params: [input.leaseNow ?? null, input.id, input.expectedUrl, input.leaseToken, input.leaseNow ?? null],
	}];
	if (input.snapshot) {
		operations.push({
			sql: `INSERT INTO snapshots (monitor_id, source_url, content, content_hash, captured_at)
				SELECT ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now')
				WHERE EXISTS (SELECT 1 FROM monitors WHERE ${guard})`,
			params: [
				input.id,
				input.snapshot.sourceUrl,
				input.snapshot.content,
				input.snapshot.contentHash,
				input.id,
				input.expectedUrl,
				input.leaseToken,
				input.leaseNow ?? null,
			],
		});
	}
	if (input.snapshot && input.notification) {
		operations.push({
			sql: `INSERT OR IGNORE INTO email_notification_outbox
				(id, event_key, notification_type, monitor_id, user_id, snapshot_id,
				 previous_snapshot_id, source_url, recipient_email, monitor_name,
				 snapshot_captured_at, app_url, from_email, from_name)
				SELECT ?, ?, 'change', m.id, m.user_id, s.id, ?, m.url, u.email, m.name,
				       s.captured_at, ?, ?, ?
				FROM monitors m
				JOIN users u ON u.id = m.user_id
				JOIN snapshots s ON s.id = (
					SELECT id FROM snapshots WHERE monitor_id = m.id ORDER BY id DESC LIMIT 1
				)
				WHERE m.id = ? AND m.url = ? AND m.lease_token = ? AND
					m.lease_expires_at > COALESCE(?, (julianday('now') - 2440587.5) * 86400)
				  AND u.email_notifications_enabled = 1`,
			params: [
				input.notification.id,
				input.notification.id,
				input.notification.previousSnapshotId ?? null,
				input.notification.appUrl ?? null,
				input.notification.senderEmail ?? null,
				input.notification.senderName ?? null,
				input.id,
				input.expectedUrl,
				input.leaseToken,
				input.leaseNow ?? null,
			],
		});
	}
	if (input.errorNotification) {
		operations.push({
			sql: `INSERT OR IGNORE INTO email_notification_outbox
				(id, event_key, notification_type, monitor_id, user_id, snapshot_id,
				 source_url, recipient_email, monitor_name, snapshot_captured_at,
				 http_status, error_description, app_url, from_email, from_name)
				SELECT ?, ?, 'error', m.id, m.user_id, NULL, m.url, u.email, m.name,
				       strftime('%Y-%m-%d %H:%M:%f', 'now'), ?, ?, ?, ?, ?
			FROM monitors m JOIN users u ON u.id = m.user_id
			WHERE m.id = ? AND m.url = ? AND m.lease_token = ?
			  AND m.lease_expires_at > COALESCE(?, (julianday('now') - 2440587.5) * 86400)
			  AND m.last_status != 'error' AND u.email_notifications_enabled = 1`,
			params: [
				input.errorNotification.id,
				input.errorNotification.id,
				input.errorNotification.httpStatus ?? null,
				input.errorNotification.description.slice(0, 1000),
				input.errorNotification.appUrl ?? null,
				input.errorNotification.senderEmail ?? null,
				input.errorNotification.senderName ?? null,
				input.id,
				input.expectedUrl,
				input.leaseToken,
				input.leaseNow ?? null,
			],
		});
	}
	operations.push({
		sql: `UPDATE monitors
			SET last_checked_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
			    last_status = ?, last_error = ?
			WHERE ${guard}`,
		params: [
			input.status,
			input.lastError?.slice(0, 500) ?? null,
			input.id,
			input.expectedUrl,
			input.leaseToken,
			input.leaseNow ?? null,
		],
	});
	const changes = await db.batch(operations);
	const requiredChanges = [changes[0], ...(input.snapshot ? [changes[1]] : []), changes.at(-1)];
	return requiredChanges.every((count) => count === 1);
}

export class LeaseLostError extends Error {
	constructor() {
		super('A reserva da verificação expirou ou foi substituída.');
	}
}

/**
 * Núcleo de recolha: pede a página, normaliza e grava o snapshot quando
 * aplicável. Sem propriedade (isso é do chamador), sem guard de intervalo
 * e SEM agendamento — compartilhado pelo endpoint manual e pelo cron.
 * Erros de recolha (ScrapeError) são registados e transformados em outcome
 * 'error' (a tentativa conta como concluída). Erros inesperados propagam.
 */
export async function performCheck(
	db: Queryable,
	id: string,
	leaseToken: string,
	env: CheckEngineEnv = {},
): Promise<MonitorCheckResult> {
	const monitor = await db.one<MonitorRow>(`SELECT ${MONITOR_COLUMNS} FROM monitors WHERE id = ?`, [id]);
	if (!monitor) {
		return { outcome: 'error', message: 'Monitorização não encontrada.' };
	}

	let normalized: string;
	let contentHash: string | undefined;
	try {
		if (configuredCheckEngine(env) === 'google') {
			const sendGoogleCheck = await prepareGoogleCheck(monitor.url, env);
			const dailyLimit = parseGoogleDailyLimit(env.GOOGLE_DAILY_LIMIT);
			let reserved: boolean;
			try {
				reserved = await reserveGoogleDailyRequest(db, dailyLimit);
			} catch {
				throw new GoogleQuotaStorageError();
			}
			if (!reserved) {
				throw new GoogleDailyLimitReachedError();
			}
			const result = await sendGoogleCheck();
			normalized = result.content;
			contentHash = result.contentHash;
		} else {
			const page = await fetchPage(monitor.url);
			normalized = extractTextFromHtml(page.text);
		}
		if (normalized.length === 0) {
			throw new ScrapeError('A página não devolveu texto utilizável.');
		}
	} catch (error) {
		if (error instanceof GoogleDailyLimitReachedError || error instanceof GoogleQuotaStorageError) throw error;
		const message = error instanceof Error ? error.message : 'Falha ao recolher a página.';
		const persisted = await persistCheckResults(db, {
			id,
			expectedUrl: monitor.url,
			leaseToken,
			status: 'error',
			lastError: message,
			errorNotification: {
				id: crypto.randomUUID(),
				sourceUrl: monitor.url,
				httpStatus: error instanceof ScrapeError ? error.httpStatus : undefined,
				description: message,
				appUrl: env.WATCHLY_APP_URL,
				senderEmail: env.BREVO_SENDER_EMAIL,
				senderName: env.BREVO_SENDER_NAME,
			},
		});
		if (!persisted) throw new LeaseLostError();
		return { outcome: 'error', message };
	}

	contentHash ??= await sha256Hex(normalized);
	const latest = await getLatestSnapshot(db, monitor);

	if (!latest) {
		const persisted = await persistCheckResults(db, {
			id, expectedUrl: monitor.url, leaseToken, status: 'unchanged',
			snapshot: { sourceUrl: monitor.url, content: normalized, contentHash },
		});
		if (!persisted) throw new LeaseLostError();
		return { outcome: 'initial', message: 'Referência inicial criada.' };
	}

	if (latest.content_hash === contentHash) {
		// Sem alterações: não se cria um novo snapshot.
		const persisted = await persistCheckResults(db, {
			id, expectedUrl: monitor.url, leaseToken, status: 'unchanged',
		});
		if (!persisted) throw new LeaseLostError();
		return { outcome: 'unchanged', message: 'Sem alterações.' };
	}

	const persisted = await persistCheckResults(db, {
		id, expectedUrl: monitor.url, leaseToken, status: 'changed',
		snapshot: { sourceUrl: monitor.url, content: normalized, contentHash },
		notification: {
			id: crypto.randomUUID(),
			previousSnapshotId: latest.id,
			appUrl: env.WATCHLY_APP_URL,
			senderEmail: env.BREVO_SENDER_EMAIL,
			senderName: env.BREVO_SENDER_NAME,
		},
	});
	if (!persisted) throw new LeaseLostError();
	return { outcome: 'changed', message: 'Alterações detectadas.' };
}

/**
 * Verifica uma monitorização a pedido do utilizador (endpoint manual):
 * propriedade, guard de intervalo, reserva por token e Agendamento da
 * próxima verificação — reutilizando o núcleo performCheck.
 */
export async function checkMonitor(
	db: Queryable,
	user: UserRecord,
	id: string,
	env: CheckEngineEnv = {},
): Promise<MonitorCheckResult> {
	await requireOwnedMonitor(db, user, id);

	const leaseToken = crypto.randomUUID();
	const claim = await claimOwnedMonitor(
		db, user.id, id, leaseToken, Math.floor(Date.now() / 1000), MIN_CHECK_INTERVAL_MS,
	);
	if (claim !== 'claimed') {
		if (claim === 'too_recent') {
			throw new ApiError(429, 'A verificação acabou de ser efectuada. Aguarda uns instantes.');
		}
		if (claim === 'not_found') throw new ApiError(404, 'Monitorização não encontrada.');
		throw new ApiError(409, 'Verificação em curso.');
	}

	try {
		const result = await performCheck(db, id, leaseToken, env);
		// Tanto em sucesso como em erro de recolha: a tentativa foi concluída;
		// a próxima verificação é calculada com a frequência vigente agora.
		await finaliseCheck(db, id, leaseToken, Math.ceil(Date.now() / 1000));
		return result;
	} catch (error) {
		if (error instanceof GoogleDailyLimitReachedError) {
			await releaseLease(db, id, leaseToken, 'google_daily_limit_reached');
			throw new ApiError(429, 'GOOGLE_DAILY_LIMIT_REACHED');
		}
		// Erro inesperado (não de recolha): liberta a reserva mantendo o
		// agendamento como está e deixa o pipeline responder 500.
		await releaseLease(db, id, leaseToken, 'unchanged');
		throw error;
	}
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

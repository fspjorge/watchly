/**
 * Verificações automáticas: primitivas partilhadas pelo agendador (cron) e
 * pelo endpoint manual de verificação.
 *
 * Modelo de reserva (lease):
 *   - adquirir = UPDATE atómico protegido por "não tem lease válido"
 *     (expiração conta como livre), imediatamente antes de executar cada
 *     verificação; a re-leitura do token confirma a posse. O slot seguinte é
 *     reservado na mesma instrução, para que um 1102 não deixe o mesmo
 *     monitor vencido a bloquear a fila após o lease expirar;
 *   - finalizar = UPDATE protegido pelo token; a frequência é lida na
 *     própria instrução SQL, para que alterações feitas durante a
 *     verificação não sejam sobrescritas pela finalização;
 *   - libertar (erro inesperado / desistência) também exige token.
 *
 * Tempos por natureza local: agora/conclusão nunca são lidos aqui — são
 * parâmetros (epoch unix segundos, UTC).
 */

import type { Queryable } from './db.ts';

/** Frequências válidas em minutos; NULL (manual) é tratado à parte. */
export const FREQUENCY_MINUTES = [15, 30, 60, 360, 720, 1440] as const;

/** Valida uma frequência da API: número inteiro da lista, ou null (manual). */
export function isFrequencyValid(value: unknown): value is number | null {
	if (value === null) return true;
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		(FREQUENCY_MINUTES as readonly number[]).includes(value)
	);
}

/** TTL da reserva em segundos. Pior caso de recolha: 6 hops × 15 s de timeout ≈ 90 s; margem para leitura de corpo lenta. */
export const LEASE_TTL_SECONDS = 180;

/** Backoff aplicado quando um erro inesperado impede a verificação agendada. */
export const INTERNAL_ERROR_BACKOFF_SECONDS = 120;
/** Backoff exponencial para leases que expiraram sem finalização, até 24 h. */
export const EXPIRED_LEASE_INITIAL_BACKOFF_SECONDS = 120;
export const EXPIRED_LEASE_MAX_BACKOFF_SECONDS = 24 * 60 * 60;

/**
 * Recupera leases automáticos expirados sem depender de código da invocação
 * que foi terminada. A condição e a limpeza são uma única escrita SQL; uma
 * execução ainda válida nunca perde o token.
 */
export async function recoverExpiredLeases(
	db: Queryable,
	now: number,
	monitorId?: string,
): Promise<number> {
	const [changed = 0] = await db.batch([{
		sql: `UPDATE monitors
			SET consecutive_lease_failures = consecutive_lease_failures + 1,
			    next_check_at = ? + MIN(?, ? * (1 << MIN(consecutive_lease_failures, 10))),
			    lease_token = NULL,
			    lease_expires_at = NULL
			WHERE frequency_minutes IS NOT NULL
			  AND user_id IS NOT NULL
			  AND lease_token IS NOT NULL
			  AND lease_expires_at <= ?
			  AND (? IS NULL OR id = ?)`,
		params: [
			now,
			EXPIRED_LEASE_MAX_BACKOFF_SECONDS,
			EXPIRED_LEASE_INITIAL_BACKOFF_SECONDS,
			now,
			monitorId ?? null,
			monitorId ?? null,
		],
	}]);
	return changed;
}

/**
 * Apropria uma monitorização vencida para a executar já (uso do cron).
 * Devolve false se: outra execução tiver lease válido, a monitorização
 * deixar de estar vencida, ou a frequência ter sido removida entretanto.
 */
export async function claimMonitor(
	db: Queryable,
	id: string,
	leaseToken: string,
	now: number,
): Promise<boolean> {
	await db.run(
		`UPDATE monitors
		 SET lease_token = ?, lease_expires_at = ?,
		     next_check_at = ? + frequency_minutes * 60
		 WHERE id = ?
		   AND frequency_minutes IS NOT NULL
		   AND next_check_at <= ?
		   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
		[leaseToken, now + LEASE_TTL_SECONDS, now, id, now, now],
	);
	return readBackToken(db, id, leaseToken);
}

/**
 * Igual a claimMonitor, mas: exige propriedade (o utilizador autenticado
 * tem de ser o dono — endpoint manual POST /check) e não exige que a
 * monitorização esteja vencida (uma verificação manual cabe quando o
 * utilizador quiser). Exige apenas frequência presente? Não: uma
 * monitorização manual também pode ser verificada à mão.
 */
export async function claimOwnedMonitor(
	db: Queryable,
	userId: string,
	id: string,
	leaseToken: string,
	now: number,
	minIntervalMs = 2_000,
): Promise<'claimed' | 'busy' | 'too_recent' | 'not_found'> {
	// Um pedido manual pode chegar antes do Cron seguinte ao 1102. Recupera
	// apenas este monitor para aplicar o mesmo backoff antes de permitir retry.
	await recoverExpiredLeases(db, now, id);
	await db.run(
		`UPDATE monitors
		 SET lease_token = ?, lease_expires_at = ?
		 WHERE id = ? AND user_id = ?
		   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
		   AND (consecutive_lease_failures = 0 OR next_check_at IS NULL OR next_check_at <= ?)
		   AND (last_checked_at IS NULL OR
		        julianday(last_checked_at) <= julianday('now') - (? / 86400000.0))`,
		[leaseToken, now + LEASE_TTL_SECONDS, id, userId, now, now, minIntervalMs],
	);
	if (await readBackToken(db, id, leaseToken)) return 'claimed';
	const state = await db.one<{
		lease_expires_at: number | null;
		last_checked_at: string | null;
		next_check_at: number | null;
		consecutive_lease_failures: number;
	}>(
		'SELECT lease_expires_at, last_checked_at, next_check_at, consecutive_lease_failures FROM monitors WHERE id = ? AND user_id = ?',
		[id, userId],
	);
	if (!state) return 'not_found';
	if (state.lease_expires_at !== null && state.lease_expires_at > now) return 'busy';
	if (
		state.consecutive_lease_failures > 0 &&
		state.next_check_at !== null &&
		state.next_check_at > now
	) return 'too_recent';
	if (
		state.last_checked_at !== null &&
		Date.now() - Date.parse(state.last_checked_at) < minIntervalMs
	) return 'too_recent';
	return 'busy';
}

/** Confirma a posse da reserva lendo o token em vigor. */
async function readBackToken(db: Queryable, id: string, leaseToken: string): Promise<boolean> {
	const row = await db.one<{ lease_token: string | null }>(
		'SELECT lease_token FROM monitors WHERE id = ?',
		[id],
	);
	return row?.lease_token === leaseToken;
}

/**
 * Finaliza uma verificação concluída: liberta a reserva e agenda a próxima
 * com a frequência VIGENTE no momento da finalização (expressão SQL), a
 * partir da hora de conclusão. Monitorizações sem frequência (manual) ficam
 * com next_check_at = NULL. Um token que não seja o em vigor não altera nada
 * (execuções antigas não podem finalizar a execução de outra).
 */
export async function finaliseCheck(
	db: Queryable,
	id: string,
	leaseToken: string,
	completedAt: number,
	leaseNow?: number,
): Promise<void> {
	await db.run(
		`UPDATE monitors
		 SET lease_token = NULL,
		     lease_expires_at = NULL,
		     consecutive_lease_failures = 0,
		     last_checked_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
		     next_check_at = CASE
		         WHEN frequency_minutes IS NULL THEN NULL
		         ELSE ? + frequency_minutes * 60
		     END
		 WHERE id = ? AND lease_token = ?
		   AND lease_expires_at > COALESCE(?, (julianday('now') - 2440587.5) * 86400)`,
		[completedAt, id, leaseToken, leaseNow ?? null],
	);
}

/** Modo de libertação: 'unchanged' mantém o agendamento; `{ at }` re-agenda. */
export type ReleaseOptions = { at: number } | 'unchanged' | 'google_daily_limit_reached';

/**
 * Liberta a reserva associada a este token. Com `{ at }`, agenda uma nova
 * tentativa para esse instante (backoff de erro interno no cron); com
 * 'unchanged', deixa o agendamento como estiver (erro inesperado do
 * endpoint manual).
 */
export async function releaseLease(
	db: Queryable,
	id: string,
	leaseToken: string,
	options: ReleaseOptions = 'unchanged',
	leaseNow?: number,
): Promise<void> {
	if (options === 'google_daily_limit_reached') {
		await db.run(
			`UPDATE monitors
			 SET lease_token = NULL, lease_expires_at = NULL,
			     last_status = 'pending', last_error = 'GOOGLE_DAILY_LIMIT_REACHED'
			 WHERE id = ? AND lease_token = ?
			   AND lease_expires_at > COALESCE(?, (julianday('now') - 2440587.5) * 86400)`,
			[id, leaseToken, leaseNow ?? null],
		);
		return;
	}
	if (options === 'unchanged') {
		await db.run(
			`UPDATE monitors
			 SET lease_token = NULL, lease_expires_at = NULL
			 WHERE id = ? AND lease_token = ?
			   AND lease_expires_at > COALESCE(?, (julianday('now') - 2440587.5) * 86400)`,
			[id, leaseToken, leaseNow ?? null],
		);
		return;
	}
	await db.run(
		`UPDATE monitors
		 SET lease_token = NULL, lease_expires_at = NULL, next_check_at = ?
		 WHERE id = ? AND lease_token = ?
		   AND lease_expires_at > COALESCE(?, (julianday('now') - 2440587.5) * 86400)`,
		[options.at, id, leaseToken, leaseNow ?? null],
	);
}

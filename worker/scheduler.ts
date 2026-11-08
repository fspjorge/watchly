/**
 * Agendador de verificações automáticas: invocado por UM Cron Trigger
 * global de minuto a minuto (`* * * * *`).
 *
 * Execução por chamada:
 *   1. selecciona, na D1, no máximo MAX_CHECKS_PER_CRON monitorizações cuja
 *      próxima verificação venceu — EXCLUINDO leases ainda válidos e
 *      monitorizações sem dono; a mais vencida primeiro (sem starvation);
 *   2. PARA CADA uma, adquire a reserva atómica imediatamente antes de
 *      executar a verificação (reutiliz performCheck — sem duplicar lógica);
 *   3. em sucesso ou erro de recolha, finaliza e agenda a próxima com a
 *      frequência vigente; em erro inesperado, liberta a reserva por token
 *      e aplica backoff;
 *   4. grava uma linha JSON com wall-clock, checks e erros para permitir
 *      calibrar MAX_CHECKS_PER_CRON no futuro (Workers Free: 10 ms de CPU
 *      por invocação Cron).
 */

import { LeaseLostError, performCheck } from './api.ts';
import type { Queryable } from './db.ts';
import type { CheckEngineEnv } from './googleCheck.ts';
import { configuredCheckEngine } from './googleCheck.ts';
import { GoogleDailyLimitReachedError, isGoogleDailyLimitReached, parseGoogleDailyLimit } from './googleQuota.ts';
import {
	claimMonitor,
	finaliseCheck,
	releaseLease,
	recoverExpiredLeases,
	INTERNAL_ERROR_BACKOFF_SECONDS,
} from './scheduling.ts';

/** nº máx. de verificações por invocação do cron (cap inicial conservador). */
export const MAX_CHECKS_PER_CRON = 1;

export type SchedulerStats = {
	inspected: number;
	checked: number;
	errors: number;
	backoff: number;
	recoveredExpired: number;
	wallMs: number;
	quotaLimited?: boolean;
};

/** Selector exacto de vencidos, exportado para diagnóstico sem duplicar SQL. */
export async function selectDueMonitors(db: Queryable, now: number): Promise<{ id: string }[]> {
	return db.all<{ id: string }>(
		`SELECT id FROM monitors
		 WHERE frequency_minutes IS NOT NULL
		   AND user_id IS NOT NULL
		   AND next_check_at IS NOT NULL
		   AND next_check_at <= ?
		   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
		 ORDER BY next_check_at ASC, id ASC
		 LIMIT ?`,
		[now, now, MAX_CHECKS_PER_CRON],
	);
}

export async function runScheduler(
	db: Queryable,
	now?: number,
	env: CheckEngineEnv = {},
): Promise<SchedulerStats> {
	const epoch = now ?? Math.floor(Date.now() / 1000);
	const startedAt = Date.now();

	const stats: SchedulerStats = {
		inspected: 0,
		checked: 0,
		errors: 0,
		backoff: 0,
		recoveredExpired: 0,
		wallMs: 0,
	};

	// Evita reservar leases ou percorrer a fila em cada Cron restante do dia.
	// A reserva imediatamente antes do fetch continua a ser a decisão atómica.
	if (configuredCheckEngine(env) === 'google') {
		const limit = parseGoogleDailyLimit(env.GOOGLE_DAILY_LIMIT);
		if (await isGoogleDailyLimitReached(db, limit)) {
			stats.quotaLimited = true;
			stats.wallMs = Date.now() - startedAt;
			console.log(JSON.stringify({
				inspected: 0, checked: 0, errors: 0, backoff: 0,
				recoveredExpired: 0, quotaLimited: true, reason: 'GOOGLE_DAILY_LIMIT_REACHED',
				wallMs: stats.wallMs,
			}));
			return stats;
		}
	}

	// Recupera leases deixados por uma invocação terminada (incluindo CPU 1102)
	// antes de seleccionar a fila. O backoff crescente impede starvation.
	stats.recoveredExpired = await recoverExpiredLeases(db, epoch);

	// Selector: vencidos, com frequência activa, com dono, e SEM lease válido;
	// a mais vencida primeiro.
	const due = await selectDueMonitors(db, epoch);
	stats.inspected = due.length;

	for (const { id } of due) {
		const leaseToken = crypto.randomUUID();

		// A reserva acontece imediatamente antes de cada verificação e
		// revalida atomicamente que a monitorização continua activa e vencida.
		const claimed = await claimMonitor(db, id, leaseToken, epoch);
		if (!claimed) {
			// Outro executor apropriou entretanto: nada a fazer nesta execução.
			continue;
		}

		try {
			const result = await performCheck(db, id, leaseToken, env);
			if (result.outcome === 'error') {
				// Erro de recolha (ex.: HTTP 403): tentativa CONCLUÍDA — a
				// próxima tentativa é agendada como qualquer outro resultado.
				stats.errors += 1;
			}
			stats.checked += 1;
			await finaliseCheck(db, id, leaseToken, Math.ceil(Date.now() / 1000));
		} catch (error) {
			if (error instanceof GoogleDailyLimitReachedError) {
				await releaseLease(db, id, leaseToken, 'google_daily_limit_reached');
				stats.quotaLimited = true;
				break;
			}
			if (error instanceof LeaseLostError) {
				// A configuração mudou ou o lease expirou; não imponhas backoff
				// sobre o next_check_at definido pelo novo estado.
				await releaseLease(db, id, leaseToken, 'unchanged');
				continue;
			}
			// Erro inesperado (não de recolha): liberta a POR token e aplica
			// backoff — evita repetir a cada minuto sobre a mesma falha.
			stats.backoff += 1;
			await releaseLease(db, id, leaseToken, {
				at: epoch + INTERNAL_ERROR_BACKOFF_SECONDS,
			});
			console.error(
				`agendador: erro inesperado na monitorização ${id}`,
				error instanceof Error ? error.message : error,
			);
		}
	}

	stats.wallMs = Date.now() - startedAt;
	// Observabilidade do cron (visível em `wrangler tail watchly`).
	console.log(
		JSON.stringify({
			inspected: stats.inspected,
			checked: stats.checked,
			errors: stats.errors,
			backoff: stats.backoff,
		recoveredExpired: stats.recoveredExpired,
			...(stats.quotaLimited ? { quotaLimited: true, reason: 'GOOGLE_DAILY_LIMIT_REACHED' } : {}),
			wallMs: stats.wallMs,
		}),
	);
	return stats;
}

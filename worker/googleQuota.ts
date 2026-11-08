import type { Queryable } from './db.ts';

export const DEFAULT_GOOGLE_DAILY_LIMIT = 600;
export const MAX_GOOGLE_DAILY_LIMIT = 1440;

export class GoogleDailyLimitReachedError extends Error {
	constructor() {
		super('GOOGLE_DAILY_LIMIT_REACHED');
		this.name = 'GoogleDailyLimitReachedError';
	}
}

export class GoogleQuotaStorageError extends Error {
	constructor() {
		super('Não foi possível reservar a quota diária do Cloud Run.');
		this.name = 'GoogleQuotaStorageError';
	}
}

export function parseGoogleDailyLimit(value: string | undefined): number {
	if (value === undefined) return DEFAULT_GOOGLE_DAILY_LIMIT;
	if (!/^\d+$/.test(value)) throw new Error('GOOGLE_DAILY_LIMIT tem de ser um inteiro positivo.');
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_GOOGLE_DAILY_LIMIT) {
		throw new Error(`GOOGLE_DAILY_LIMIT tem de estar entre 1 e ${MAX_GOOGLE_DAILY_LIMIT}.`);
	}
	return limit;
}

function utcDate(now: Date): string {
	return now.toISOString().slice(0, 10);
}

/** Uma única UPSERT condicional reserva a quota; RETURNING null significa esgotada. */
export async function reserveGoogleDailyRequest(
	db: Queryable,
	limit: number,
	now = new Date(),
): Promise<boolean> {
	const reserved = await db.one<{ request_count: number }>(
		`INSERT INTO google_daily_usage (utc_date, request_count)
		 VALUES (?, 1)
		 ON CONFLICT (utc_date) DO UPDATE
		 SET request_count = google_daily_usage.request_count + 1
		 WHERE google_daily_usage.request_count < ?
		 RETURNING request_count`,
		[utcDate(now), limit],
	);
	return reserved !== null;
}

/** Leitura preventiva apenas para o scheduler parar após esgotamento; a reserva continua atómica. */
export async function isGoogleDailyLimitReached(
	db: Queryable,
	limit: number,
	now = new Date(),
): Promise<boolean> {
	const row = await db.one<{ request_count: number }>(
		'SELECT request_count FROM google_daily_usage WHERE utc_date = ?',
		[utcDate(now)],
	);
	return (row?.request_count ?? 0) >= limit;
}

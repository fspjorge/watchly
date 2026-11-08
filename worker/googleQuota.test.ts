import { describe, expect, it } from 'vitest';
import { SqliteQueryable, applyMigrationFile } from './testSupport.ts';
import {
	DEFAULT_GOOGLE_DAILY_LIMIT,
	MAX_GOOGLE_DAILY_LIMIT,
	parseGoogleDailyLimit,
	reserveGoogleDailyRequest,
} from './googleQuota.ts';

function quotaDatabase(): ReturnType<typeof SqliteQueryable.open> {
	const db = SqliteQueryable.open();
	for (const migration of [
		'0001_initial_schema.sql', '0002_multiuser_ownership.sql', '0003_scheduled_checks.sql',
		'0004_expired_lease_backoff.sql', '0005_google_daily_usage.sql',
	]) applyMigrationFile(db, migration);
	return db;
}

describe('Google daily quota', () => {
	it('uses default 600 and rejects limits above the absolute 1440 cap', () => {
		expect(parseGoogleDailyLimit(undefined)).toBe(DEFAULT_GOOGLE_DAILY_LIMIT);
		expect(parseGoogleDailyLimit(String(MAX_GOOGLE_DAILY_LIMIT))).toBe(MAX_GOOGLE_DAILY_LIMIT);
		expect(() => parseGoogleDailyLimit('1441')).toThrow('1440');
		expect(() => parseGoogleDailyLimit('0')).toThrow();
		expect(() => parseGoogleDailyLimit('3.5')).toThrow();
	});

	it('reserves through the limit and rejects the request after it is exactly reached', async () => {
		const db = quotaDatabase();
		const now = new Date('2026-11-08T12:00:00.000Z');
		expect(await reserveGoogleDailyRequest(db, 3, now)).toBe(true);
		expect(await reserveGoogleDailyRequest(db, 3, now)).toBe(true);
		expect(await reserveGoogleDailyRequest(db, 3, now)).toBe(true);
		expect(await reserveGoogleDailyRequest(db, 3, now)).toBe(false);
		expect(await db.one('SELECT utc_date, request_count FROM google_daily_usage'))
			.toEqual({ utc_date: '2026-11-08', request_count: 3 });
	});

	it('resets automatically at the UTC date boundary', async () => {
		const db = quotaDatabase();
		expect(await reserveGoogleDailyRequest(db, 1, new Date('2026-11-08T23:59:59.999Z'))).toBe(true);
		expect(await reserveGoogleDailyRequest(db, 1, new Date('2026-11-09T00:00:00.000Z'))).toBe(true);
		expect(await db.all('SELECT utc_date, request_count FROM google_daily_usage ORDER BY utc_date'))
			.toEqual([
				{ utc_date: '2026-11-08', request_count: 1 },
				{ utc_date: '2026-11-09', request_count: 1 },
			]);
	});

	it('parallel reservations never exceed the configured limit', async () => {
		const db = quotaDatabase();
		const now = new Date('2026-11-08T12:00:00.000Z');
		const reservations = await Promise.all(
			Array.from({ length: 40 }, () => reserveGoogleDailyRequest(db, 5, now)),
		);
		expect(reservations.filter(Boolean)).toHaveLength(5);
		expect(await db.one<{ request_count: number }>(
			'SELECT request_count FROM google_daily_usage WHERE utc_date = ?', ['2026-11-08']))
			.toEqual({ request_count: 5 });
	});
});

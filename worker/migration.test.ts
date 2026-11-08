import { describe, expect, it } from 'vitest';

import { SqliteQueryable, applyMigrationFile } from './testSupport.ts';

describe('migração 0002_multiuser_ownership', () => {
	it('preserva monitors e snapshots existentes e preenche o source_url', async () => {
		const db = SqliteQueryable.open();

		// Estado pré-migração (0001) com dados representativos do MVP.
		applyMigrationFile(db, '0001_initial_schema.sql');

		db.run(
			`INSERT INTO monitors (id, name, url, created_at, last_checked_at, last_status, last_error)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				'5250a15e-1111-4a10-9e1a-aaaaaaaaaaa1',
				'Exemplo antigo',
				'https://velho.pt/pagina',
				'2026-11-01 10:00:00',
				'2026-11-01 10:05:00',
				'changed',
				null,
			],
		);
		db.run(
			`INSERT INTO snapshots (monitor_id, content, content_hash, captured_at)
			 VALUES (?, ?, ?, ?)`,
			[
				'5250a15e-1111-4a10-9e1a-aaaaaaaaaaa1',
				'linha antiga A\nlinha antiga B',
				'hash-original-exemplo',
				'2026-11-01 10:03:00',
			],
		);
		db.run(
			`INSERT INTO snapshots (monitor_id, content, content_hash, captured_at)
			 VALUES (?, ?, ?, ?)`,
			[
				'5250a15e-1111-4a10-9e1a-aaaaaaaaaaa1',
				'linha antiga A\nlinha antiga B (alterada)',
				'hash-original-exemplo-2',
				'2026-11-01 10:05:00',
			],
		);

		// Migração 0002: estrutura nova + backfill.
		applyMigrationFile(db, '0002_multiuser_ownership.sql');

		// Monitores e snapshots conservados, intactos.
		expect(db.count('SELECT COUNT(*) AS total FROM monitors')).toBe(1);
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots')).toBe(2);

		const snapshot = await db.one<{ id: number; content: string; content_hash: string; captured_at: string; source_url: string }>(
			'SELECT id, content, content_hash, captured_at, source_url FROM snapshots WHERE captured_at = ?',
			['2026-11-01 10:05:00'],
		);
		expect(snapshot && {
			content: snapshot.content,
			content_hash: snapshot.content_hash,
			captured_at: snapshot.captured_at,
			source_url: snapshot.source_url,
		}).toEqual({
			content: 'linha antiga A\nlinha antiga B (alterada)',
			content_hash: 'hash-original-exemplo-2',
			captured_at: '2026-11-01 10:05:00',
			source_url: 'https://velho.pt/pagina',
		});

		// Monitores antigos continuam sem proprietário (associação controlada
		// só acontece no primeiro login do LEGACY_OWNER_EMAIL).
		const monitor = await db.one<{ user_id: null; last_status: string }>(
			'SELECT user_id, last_status FROM monitors',
		);
		expect(monitor).toEqual({ user_id: null, last_status: 'changed' });

		// Tabela users e índices criados.
		expect(
			db.count("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'users'"),
		).toBe(1);
		for (const name of ['idx_users_email_lower', 'idx_monitors_user', 'idx_snapshots_monitor_url']) {
			expect(
				db.count('SELECT COUNT(*) AS total FROM sqlite_master WHERE type = ? AND name = ?', ['index', name]),
			).toBe(1);
		}

		// last_login_at presente na users.
		db.run('INSERT INTO users (id, auth_subject, email) VALUES (?, ?, ?)', [
			'u-1',
			'sub-legado',
			'fspjorge@gmail.com',
		]);
		const user = await db.one<{ created_at: string | null; last_login_at: string | null }>(
			'SELECT created_at, last_login_at FROM users WHERE id = ?', ['u-1'],
		);
		expect(user && user.created_at).toBeTruthy();
		expect(user && user.last_login_at).toBeNull();
	});
});

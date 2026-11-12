import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMonitor, getMonitorDiff, performCheck, updateMonitor } from './api.ts';
import type { UserRecord } from './auth.ts';
import { applyMigrationFile, SqliteQueryable } from './testSupport.ts';

const OWNER: UserRecord = {
	id: 'keyword-user',
	auth_subject: 'keyword-subject',
	email: 'keyword@example.test',
	name: 'Keyword User',
	created_at: '2026-11-12 00:00:00',
	last_login_at: null,
	email_notifications_enabled: 1,
};

const MIGRATIONS = [
	'0001_initial_schema.sql', '0002_multiuser_ownership.sql', '0003_scheduled_checks.sql',
	'0004_expired_lease_backoff.sql', '0005_google_daily_usage.sql', '0006_email_notifications.sql',
	'0007_brevo_notification_events.sql', '0008_monitor_keywords.sql',
];

let db: SqliteQueryable;

beforeEach(() => {
	db = SqliteQueryable.open();
	for (const migration of MIGRATIONS) applyMigrationFile(db, migration);
	db.run('INSERT INTO users (id, auth_subject, email, name, email_notifications_enabled) VALUES (?, ?, ?, ?, 1)', [
		OWNER.id, OWNER.auth_subject, OWNER.email, OWNER.name,
	]);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function monitorWithSnapshot(before: string, keywords: string) {
	const monitor = await createMonitor(db, OWNER, {
		name: 'Produto', url: 'https://example.test/product', keywords,
	});
	await db.run(
		`INSERT INTO snapshots (monitor_id, source_url, content, content_hash, captured_at)
		 VALUES (?, ?, ?, ?, '2000-01-01 10:00:00')`,
		[monitor.id, monitor.url, before, 'old-hash'],
	);
	await db.run('UPDATE monitors SET lease_token = ?, lease_expires_at = ? WHERE id = ?', [
		'lease-keyword', Math.floor(Date.now() / 1000) + 300, monitor.id,
	]);
	return monitor;
}

function fetchHtml(html: string): void {
	vi.stubGlobal('fetch', vi.fn(async () => new Response(html, {
		status: 200,
		headers: { 'content-type': 'text/html' },
	})));
}

describe('configuração de keywords', () => {
	it('normaliza, deduplica e persiste termos opcionais na criação', async () => {
		const monitor = await createMonitor(db, OWNER, {
			name: 'Produto', url: 'https://example.test/product', keywords: ' Preço \npreço\nStock ',
		});
		expect(monitor.keywords).toBe('Preço\nStock');
	});

	it('permite limpar keywords por PATCH sem alterar a frequência', async () => {
		const created = await createMonitor(db, OWNER, {
			name: 'Produto', url: 'https://example.test/product', frequency_minutes: 30, keywords: 'Preço',
		});
		const updated = await updateMonitor(db, OWNER, created.id, { keywords: '' });
		expect(updated.keywords).toBe('');
		expect(updated.frequency_minutes).toBe(30);
		expect(updated.next_check_at).toBe(created.next_check_at);
	});

	it.each([
		['more than ten', Array.from({ length: 11 }, (_, i) => `k${i}`).join('\n')],
		['an overlong term', 'x'.repeat(81)],
		['wrong type', ['price']],
	] as const)('rejects %s on create', async (_label, keywords) => {
		await expect(createMonitor(db, OWNER, {
			name: 'Produto', url: 'https://example.test/product', keywords,
		})).rejects.toThrow('Keywords inválidas');
	});
});

describe('filtragem de alterações', () => {
	it('guarda mudanças sem keyword como base nova e não cria evento de email', async () => {
		const monitor = await monitorWithSnapshot('Título\nPreço\n10 euros', 'Preço');
		fetchHtml('<p>Título novo</p><p>Preço</p><p>10 euros</p>');

		const result = await performCheck(db, monitor.id, 'lease-keyword');
		const state = await db.one<{ last_status: string }>('SELECT last_status FROM monitors WHERE id = ?', [monitor.id]);
		const snapshots = await db.count('SELECT COUNT(*) AS total FROM snapshots WHERE monitor_id = ?', [monitor.id]);

		expect(result).toMatchObject({ outcome: 'filtered' });
		expect(state?.last_status).toBe('filtered');
		expect(snapshots).toBe(2);
		expect(db.count('SELECT COUNT(*) AS total FROM email_notification_outbox WHERE monitor_id = ?', [monitor.id])).toBe(0);
	});

	it('detecta keyword no conteúdo novo e gera uma alteração normal', async () => {
		const monitor = await monitorWithSnapshot('Máquina\nDisponível', 'indisponível');
		fetchHtml('<p>Máquina</p><p>Indisponível</p>');

		const result = await performCheck(db, monitor.id, 'lease-keyword');
		expect(result.outcome).toBe('changed');
		expect(db.count("SELECT COUNT(*) AS total FROM email_notification_outbox WHERE monitor_id = ? AND notification_type = 'change'", [monitor.id])).toBe(1);
	});

	it('detecta keyword na linha removida da versão anterior', async () => {
		const monitor = await monitorWithSnapshot('Máquina\nIndisponível', 'indisponível');
		fetchHtml('<p>Máquina</p><p>Disponível</p>');
		expect((await performCheck(db, monitor.id, 'lease-keyword')).outcome).toBe('changed');
	});

	it('não dispara quando a keyword existe apenas numa linha inalterada adjacente', async () => {
		const monitor = await monitorWithSnapshot('Máquina\nPreço\n10 euros', 'Preço');
		fetchHtml('<p>Máquina</p><p>Preço</p><p>12 euros</p>');
		expect((await performCheck(db, monitor.id, 'lease-keyword')).outcome).toBe('filtered');
	});

	it('compara a próxima execução com o snapshot da alteração filtrada, sem acumular ruído', async () => {
		const monitor = await monitorWithSnapshot('Título antigo', 'oferta');
		fetchHtml('<p>Título intermédio</p>');
		expect((await performCheck(db, monitor.id, 'lease-keyword')).outcome).toBe('filtered');

		const latest = await db.one<{ captured_at: string }>('SELECT captured_at FROM snapshots WHERE monitor_id = ? ORDER BY id DESC LIMIT 1', [monitor.id]);
		await db.run('UPDATE monitors SET lease_token = ?, lease_expires_at = ? WHERE id = ?', [
			'lease-keyword-2', Math.floor(Date.now() / 1000) + 300, monitor.id,
		]);
		fetchHtml('<p>Oferta nova</p>');
		expect((await performCheck(db, monitor.id, 'lease-keyword-2')).outcome).toBe('changed');
		expect(latest).not.toBeNull();
	});

	it('filtra também a vista de diferenças e indica quando não há correspondências', async () => {
		const monitor = await monitorWithSnapshot('Máquina\nPreço: 10 euros\nDetalhes\nRodapé antigo', 'Preço');
		fetchHtml('<p>Máquina</p><p>Preço: 12 euros</p><p>Detalhes</p><p>Rodapé novo</p>');
		await performCheck(db, monitor.id, 'lease-keyword');
		const diff = await getMonitorDiff(db, OWNER, monitor.id);
		expect(diff).toMatchObject({ filteredByKeywords: true, keywords: ['Preço'], hasMatchingDiff: true });
		expect(diff?.chunks.flatMap((chunk) => chunk.lines).join('\n')).not.toContain('Rodapé');
	});
});

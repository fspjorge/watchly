/**
 * Testes do agendador (cron): selector de monitorizações vencidas,
 * exclusão de leases válidos e monitorizações sem dono, cap de execução,
 * agendamento pós-verificação e backoff de erros inesperados.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyMigrationFile, SqliteQueryable } from './testSupport.ts';
import { runScheduler } from './scheduler.ts';

const M1 = '9250a15e-1111-4a10-9e1a-111111111111'; // vencida há mais tempo (freq 15)
const M2 = '9250a15e-2222-4a10-9e1a-222222222222'; // vencida mais tarde (freq 30)
const OWNER = 'user-a';

let db: ReturnType<typeof SqliteQueryable.open>;

function seedMonitor(
	id: string,
	frequency: number | null,
	nextCheckAt: number | null,
	owner: string | null = OWNER,
): void {
	if (owner) {
		db.run('INSERT OR IGNORE INTO users (id, auth_subject, email) VALUES (?, ?, ?)', [
			owner, `sub-${owner}`, `${owner}@exemplo.pt`,
		]);
	}
	db.run(
		`INSERT INTO monitors
		   (id, name, url, last_status, frequency_minutes, next_check_at, user_id)
		 VALUES (?, ?, ?, 'unchanged', ?, ?, ?)`,
		[id, `M ${id}`, `https://${id}.pt/`, frequency, nextCheckAt, owner],
	);
}

/** fetch simulado: HTML com o URL pedido; variante 403; variante que lança. */
function stubWorld(kind: 'html' | '403' | 'crash'): ReturnType<typeof vi.fn> {
	const mock = vi.fn((input: unknown) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof Request
					? input.url
					: String(input);
		if (kind === '403') {
			return Promise.resolve(
				new Response('<html>bloqueado</html>', { status: 403, headers: { 'content-type': 'text/html' } }),
			);
		}
		if (kind === 'crash') {
			return Promise.reject(new TypeError('worker crashed'));
		}
		return Promise.resolve(
			new Response(`<p>${url}</p>`, { status: 200, headers: { 'content-type': 'text/html' } }),
		);
	});
	vi.stubGlobal('fetch', mock);
	return mock;
}

beforeEach(() => {
	NOW = Math.floor(Date.now() / 1000);
	db = SqliteQueryable.open();
	applyMigrationFile(db, '0001_initial_schema.sql');
	applyMigrationFile(db, '0002_multiuser_ownership.sql');
	applyMigrationFile(db, '0003_scheduled_checks.sql');
	applyMigrationFile(db, '0004_expired_lease_backoff.sql');
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function htmlStubThenSeed(): ReturnType<typeof vi.fn> {
	return stubWorld('html');
}

async function row(id: string) {
	return db.one<{
		frequency_minutes: number | null; next_check_at: number | null;
		lease_expires_at: number | null; lease_token: string | null;
		consecutive_lease_failures: number;
	}>(
		'SELECT frequency_minutes, next_check_at, lease_expires_at, lease_token, consecutive_lease_failures FROM monitors WHERE id = ?',
		[id],
	);
}

let NOW = 0;

describe('runScheduler', () => {
	it('verifica a monitorização vencida, limpa a reserva e agenda agora + frequência', async () => {
		seedMonitor(M1, 15, NOW - 1);
		const fetchMock = htmlStubThenSeed();

		const stats = await runScheduler(db, NOW);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(stats.checked).toBe(1);
		expect(stats.errors).toBe(0);
		const state = await row(M1);
		expect(state && state.lease_token).toBeNull();
		expect(state && state.next_check_at).toBeGreaterThanOrEqual(NOW + 15 * 60);
		expect(state && state.next_check_at).toBeLessThanOrEqual((await lastCheckedRoof()) + 15 * 60 + 1);
	});

	it('respeita MAX_CHECKS_PER_CRON = 1: com dois vencidos, só o mais antigo corre', async () => {
		seedMonitor(M1, 15, NOW - 5); // vencida há mais tempo → preferida
		seedMonitor(M2, 30, NOW - 3);
		const fetchMock = htmlStubThenSeed();

		const stats = await runScheduler(db, NOW);

		expect(stats.checked).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe(`https://${M1}.pt/`);
		// M2 não foi tocado (a próxima execução segue-o; sem starvation porque
		// a ordem é pelo next_check_at mais antigo).
		const m2 = await row(M2);
		expect(m2 && m2.next_check_at).toBe(NOW - 3);
		expect(m2 && m2.lease_token).toBeNull();
	});

	it('ignora monitorização com lease ainda válido de outro executor', async () => {
		seedMonitor(M1, 15, NOW - 1);
		db.run('UPDATE monitors SET lease_token = ?, lease_expires_at = ? WHERE id = ?', [
			'tok-outro', NOW + 100, M1,
		]);
		const fetchMock = htmlStubThenSeed();

		const stats = await runScheduler(db, NOW);

		expect(stats.checked).toBe(0);
		expect(stats.inspected).toBe(0); // o selector EXCLUI leases ainda válidos
		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect((await row(M1))?.lease_token).toBe('tok-outro');
	});

	it('duas execuções Cron sobrepostas não verificam duas vezes o mesmo monitor', async () => {
		seedMonitor(M1, 15, NOW - 1);
		let finishFetch!: (response: Response) => void;
		const pendingFetch = new Promise<Response>((resolve) => { finishFetch = resolve; });
		const fetchMock = vi.fn(() => pendingFetch);
		vi.stubGlobal('fetch', fetchMock);

		const firstCron = runScheduler(db, NOW, { CHECK_ENGINE: 'cloudflare' });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

		// A primeira invocação mantém o lease enquanto a recolha está suspensa.
		const secondCron = await runScheduler(db, NOW, { CHECK_ENGINE: 'cloudflare' });
		expect(secondCron.checked).toBe(0);
		expect(secondCron.inspected).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		finishFetch(new Response('<p>cron result</p>', {
			status: 200,
			headers: { 'content-type': 'text/html' },
		}));
		const firstStats = await firstCron;
		expect(firstStats.checked).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('backoff de lease expirado liberta o monitor e deixa a fila avançar', async () => {
		seedMonitor(M1, 15, NOW - 1);
		seedMonitor(M2, 30, NOW - 2);
		db.run('UPDATE monitors SET lease_token = ?, lease_expires_at = ? WHERE id = ?', [
			'tok-morto', NOW - 10, M1,
		]);
		const fetchMock = htmlStubThenSeed();

		const stats = await runScheduler(db, NOW);

		expect(stats.checked).toBe(1);
		expect(stats.recoveredExpired).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe(`https://${M2}.pt/`);
		expect(await row(M1)).toMatchObject({
			lease_token: null,
			lease_expires_at: null,
			consecutive_lease_failures: 1,
			next_check_at: NOW + 120,
		});
	});

	it('erro de recolha (HTTP 403) conta como tentativa: agende próxima ≠ agora', async () => {
		seedMonitor(M1, 15, NOW - 1);
		stubWorld('403');

		const stats = await runScheduler(db, NOW);

		expect(stats.errors).toBe(1);
		expect(stats.checked).toBe(1); // tentativa concluída (com erro de recolha)
		const state = await row(M1);
		expect(state && state.lease_token).toBeNull();
		if (typeof (state && state.next_check_at) !== 'number') {
			throw new Error('403 não agendou repetição');
		}
		expect(state && state.next_check_at).toBeGreaterThanOrEqual(NOW + 15 * 60);
		const estado = await db.one<{ last_status: string }>(
			'SELECT last_status FROM monitors WHERE id = ?', [M1],
		);
		expect(estado && estado.last_status).toBe('error');
	});

	it('erro inesperado: liberta o lease por token e aplica backoff de 120 s', async () => {
		seedMonitor(M1, 15, NOW - 1);
		stubWorld('html');
		// Erro interno do pipeline (não é recolha): o SHA-256 falha após a
		// recolha. Rede/HTTP 4xx/5xx são ERROS DE RECOLHA pelo desenho
		// existente; backoff reserva-se a falhas do próprio Worker.
		vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new TypeError('hashpipe demolido'));
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

		const stats = await runScheduler(db, NOW);

		expect(stats.checked).toBe(0);
		expect(stats.backoff).toBe(1);
		const state = await row(M1);
		// lease foi libertado (token só existiu durante a tentativa).
		expect(state && state.lease_token).toBeNull();
		expect(state && state.lease_expires_at).toBeNull();
		expect(state && state.next_check_at).toBe(NOW + 120);
		// Log de observabilidade registou wallMs/checked/errors.
		expect(logSpy).toHaveBeenCalled();
		const logged = String(logSpy.mock.calls[0][0]);
		expect(JSON.parse(logged)).toMatchObject({ checked: 0, errors: 0 });
	});

	it('nunca verifica monitorizações sem dono (user_id IS NULL)', async () => {
		seedMonitor(M1, 15, NOW - 1, null); // órfã (antiga)
		const fetchMock = htmlStubThenSeed();

		const stats = await runScheduler(db, NOW);

		expect(stats.checked).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	it('nunca verifica monitorizações manuais (frequency NULL)', async () => {
		seedMonitor(M2, null, null);
		const fetchMock = htmlStubThenSeed();

		const stats = await runScheduler(db, NOW);

		expect(stats.checked).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	it('nada fica permanentemente por verificar: a ordem é sempre a mais vencida primeiro', async () => {
		seedMonitor(M1, 15, NOW - 10);
		seedMonitor(M2, 30, NOW - 3);
		const fetchMock = htmlStubThenSeed();

		// Execução 1: M1 (mais antiga).
		const s1 = await runScheduler(db, NOW);
		expect(s1.checked).toBe(1);
		expect(fetchMock.mock.calls[0][0]).toBe(`https://${M1}.pt/`);

		// M1 re-agenda para agora+900; M2 continua vencida → execução 2: M2.
		const s2 = await runScheduler(db, NOW + 1);
		expect(s2.checked).toBe(1);
		expect(fetchMock.mock.calls[1][0]).toBe(`https://${M2}.pt/`);
	});
});

/** Teto de last_checked_at usar CURRENT_TIMESTAMP do sqlite (não o NOW do teste). */
async function lastCheckedRoof(): Promise<number> {
	const row = await db.one<{ x: string | null }>(
		"SELECT strftime('%s','now') AS x FROM monitors LIMIT 1",
	);
	return Number(row?.x ?? NOW);
}

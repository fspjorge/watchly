/**
 * Testes das primitivas de agendamento: claim/finalise/release por token,
 * com epoch unix (segundos UTC) passado como argumento (determinísticos).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { applyMigrationFile, SqliteQueryable } from './testSupport.ts';
import { persistCheckResults } from './api.ts';
import {
	claimMonitor,
	claimOwnedMonitor,
	finaliseCheck,
	FREQUENCY_MINUTES,
	isFrequencyValid,
	recoverExpiredLeases,
	releaseLease,
} from './scheduling.ts';

const M1 = '6250a15e-1111-4a10-9e1a-111111111111'; // vencida, frequência 15
const M2 = '6250a15e-2222-4a10-9e1a-222222222222'; // manual (frequência NULL)
const M3 = '6250a15e-3333-4a10-9e1a-333333333333'; // agendada e AINDA não vencida
const OWNER = 'user-a';
const OTHER = 'user-b';

let db: ReturnType<typeof SqliteQueryable.open>;

function seedMonitor(
	id: string,
	frequency: number | null,
	nextCheckAt: number | null,
	owner: string | null = OWNER,
): void {
	if (owner) {
		db.run('INSERT OR IGNORE INTO users (id, auth_subject, email) VALUES (?, ?, ?)', [
			owner,
			`sub-${owner}`,
			`${owner}@exemplo.pt`,
		]);
	}
	db.run(
		`INSERT INTO monitors (id, name, url, last_status, frequency_minutes, next_check_at, user_id)
		 VALUES (?, ?, ?, 'unchanged', ?, ?, ?)`,
		[id, `M ${id}`, `https://${id}.pt/`, frequency, nextCheckAt, owner],
	);
}

beforeEach(() => {
	db = SqliteQueryable.open();
	applyMigrationFile(db, '0001_initial_schema.sql');
	applyMigrationFile(db, '0002_multiuser_ownership.sql');
	applyMigrationFile(db, '0003_scheduled_checks.sql');
	applyMigrationFile(db, '0004_expired_lease_backoff.sql');
	seedMonitor(M1, 15, 900_000); // vencida no instante 900
	seedMonitor(M2, null, null);
	seedMonitor(M3, 60, 10_000_000);
});

async function row(id: string): Promise<Record<string, unknown>> {
	return (await db.one<Record<string, unknown>>(
		'SELECT frequency_minutes, next_check_at, lease_expires_at, lease_token, consecutive_lease_failures FROM monitors WHERE id = ?',
		[id],
	)) as Record<string, unknown>;
}

describe('isFrequencyValid / FREQUENCY_MINUTES', () => {
	it('aceita exactamente as frequências previstas e null', () => {
		expect(FREQUENCY_MINUTES).toEqual([15, 30, 60, 360, 720, 1440]);
		expect(isFrequencyValid(null)).toBe(true);
		for (const f of FREQUENCY_MINUTES) expect(isFrequencyValid(f)).toBe(true);
		for (const bad of [7, 45, 3000, -15, 0, '30', 1.5, undefined]) {
			expect(isFrequencyValid(bad)).toBe(false);
		}
	});
});

describe('claimMonitor (cron)', () => {
	it('apropria uma monitorização vencida e devolve o token como em vigor', async () => {
		const now = 900_000;
		const ok = await claimMonitor(db, M1, 'tok-cron-1', now);
		expect(ok).toBe(true);
		const state = await row(M1);
		expect(state.lease_token).toBe('tok-cron-1');
		// TTL de 180 s a partir de now.
		expect(state.lease_expires_at).toBe(now + 180);
		// Se a execução morrer (por ex., CPU 1102), evita retentar em loop
		// antes do próximo ciclo e bloquear o monitor seguinte na fila.
		expect(state.next_check_at).toBe(now + 15 * 60);
	});

	it('recusa quando a monitorização não está vencida', async () => {
		const ok = await claimMonitor(db, M3, 'tok-x', 900_000);
		expect(ok).toBe(false);
		expect((await row(M3)).lease_token).toBeNull();
	});

	it('recusa quando outra execução detém um lease ainda válido', async () => {
		db.run('UPDATE monitors SET lease_token = ?, lease_expires_at = 1_000_000 WHERE id = ?', [
			'tok-outro',
			M1,
		]);
		const ok = await claimMonitor(db, M1, 'tok-cron-2', 900_500);
		expect(ok).toBe(false);
		expect((await row(M1)).lease_token).toBe('tok-outro');
	});

	it('recupera leases expirados (recuperação de execuções interrompidas)', async () => {
		db.run('UPDATE monitors SET lease_token = ?, lease_expires_at = ? WHERE id = ?', [
			'tok-velho',
			900_500, // expira antes de 900_600
			M1,
		]);
		const ok = await claimMonitor(db, M1, 'tok-cron-3', 900_600);
		expect(ok).toBe(true);
		expect((await row(M1)).lease_token).toBe('tok-cron-3');
	});

	it('após CPU 1102, aguarda o próximo intervalo antes de tentar o monitor outra vez', async () => {
		const now = 900_000;
		expect(await claimMonitor(db, M1, 'tok-interrompido', now)).toBe(true);

		// O runtime mata a execução; o lease expira ao fim de 180 s, mas a
		// reserva já adiou next_check_at para o ciclo seguinte (15 min).
		expect(await claimMonitor(db, M1, 'tok-demasiado-cedo', now + 181)).toBe(false);
		expect((await row(M1)).lease_token).toBe('tok-interrompido');
		expect(await claimMonitor(db, M1, 'tok-ciclo-seguinte', now + 15 * 60)).toBe(true);
		expect((await row(M1)).lease_token).toBe('tok-ciclo-seguinte');
	});

	it('recuperação de leases expirados aplica backoff crescente apenas uma vez por lease', async () => {
		const start = 900_000;
		expect(await claimMonitor(db, M1, 'tok-falha-1', start)).toBe(true);
		db.run('UPDATE monitors SET lease_expires_at = ? WHERE id = ?', [start + 180, M1]);
		expect(await recoverExpiredLeases(db, start + 181)).toBe(1);
		expect(await row(M1)).toMatchObject({
			lease_token: null,
			lease_expires_at: null,
			consecutive_lease_failures: 1,
			next_check_at: start + 181 + 120,
		});
		// Nova execução Cron não volta a contar o mesmo lease já libertado.
		expect(await recoverExpiredLeases(db, start + 182)).toBe(0);

		const secondStart = start + 181 + 120;
		expect(await claimMonitor(db, M1, 'tok-falha-2', secondStart)).toBe(true);
		db.run('UPDATE monitors SET lease_expires_at = ? WHERE id = ?', [secondStart + 180, M1]);
		expect(await recoverExpiredLeases(db, secondStart + 181)).toBe(1);
		expect(await row(M1)).toMatchObject({
			consecutive_lease_failures: 2,
			next_check_at: secondStart + 181 + 240,
		});
	});

	it('backoff de leases expirados fica limitado a 24 horas', async () => {
		const now = 900_000;
		db.run('UPDATE monitors SET consecutive_lease_failures = 10 WHERE id = ?', [M1]);
		expect(await claimMonitor(db, M1, 'tok-falha-repetida', now)).toBe(true);
		db.run('UPDATE monitors SET lease_expires_at = ? WHERE id = ?', [now + 180, M1]);
		expect(await recoverExpiredLeases(db, now + 181)).toBe(1);
		expect(await row(M1)).toMatchObject({
			consecutive_lease_failures: 11,
			next_check_at: now + 181 + 24 * 60 * 60,
		});
	});

	it('backoff após lease expirado também impede uma verificação manual imediata', async () => {
		const now = 900_000;
		expect(await claimMonitor(db, M1, 'tok-interrompido', now)).toBe(true);
		db.run('UPDATE monitors SET lease_expires_at = ? WHERE id = ?', [now + 180, M1]);
		expect(await claimOwnedMonitor(db, OWNER, M1, 'tok-manual-cedo', now + 182)).toBe('too_recent');
		expect((await row(M1)).consecutive_lease_failures).toBe(1);
		expect(await claimOwnedMonitor(db, OWNER, M1, 'tok-manual-apto', now + 182 + 120)).toBe('claimed');
	});

	it('revalida atomicamente que continua vencida: quem chegou segundo não tomou posse', async () => {
		// Dois executors reclamam em sequência com o MESMO prazo: o primeiro
		// apropriou (lease válido), o segundo é recusado mesmo que em SQL
		// parecessem elegíveis ao mesmo tempo.
		const p1 = claimMonitor(db, M1, 'tok-a', 900_000);
		const p2 = claimMonitor(db, M1, 'tok-b', 900_000);
		const [r1, r2] = await Promise.all([p1, p2]);
		// Pelo menos um falhou; o token em vigor é exactamente o de quem venceu.
		const state = await row(M1);
		const winner = state.lease_token;
		expect(winner).toBeTypeOf('string');
		if (winner === 'tok-a') {
			expect(r1).toBe(true);
			expect(r2).toBe(false);
		} else {
			expect(winner).toBe('tok-b');
			expect(r2).toBe(true);
			expect(r1).toBe(false);
		}
	});
});

describe('claimOwnedMonitor (endpoint manual)', () => {
	it('exige propriedade: outro utilizador não apropria', async () => {
		const ok = await claimOwnedMonitor(db, OTHER, M1, 'tok-manual', 900_000);
		expect(ok).toBe('not_found');
		expect((await row(M1)).lease_token).toBeNull();
	});

	it('apropria para o dono, mesmo sem monitorização vencida', async () => {
		const ok = await claimOwnedMonitor(db, OWNER, M3, 'tok-manual', 900_000);
		expect(ok).toBe('claimed');
		expect((await row(M3)).lease_token).toBe('tok-manual');
	});

	it('recusa atomicamente uma verificação manual dentro do intervalo mínimo', async () => {
		const now = Math.floor(Date.now() / 1000);
		expect(await claimOwnedMonitor(db, OWNER, M3, 'tok-manual-A', now)).toBe('claimed');
		expect(await persistCheckResults(db, {
			id: M3, expectedUrl: `https://${M3}.pt/`, leaseToken: 'tok-manual-A', status: 'unchanged',
		})).toBe(true);
		await finaliseCheck(db, M3, 'tok-manual-A', Math.ceil(Date.now() / 1000));

		const ok = await claimOwnedMonitor(
			db, OWNER, M3, 'tok-manual-repetido', Math.floor(Date.now() / 1000), 2_000,
		);
		expect(ok).toBe('too_recent');
		expect((await row(M3)).lease_token).toBeNull();
	});

	it('duas aquisições manuais simultâneas deixam apenas um executor entrar', async () => {
		const claims = await Promise.all([
			claimOwnedMonitor(db, OWNER, M3, 'tok-manual-A', 900_000),
			claimOwnedMonitor(db, OWNER, M3, 'tok-manual-B', 900_000),
		]);
		expect(claims.filter((claim) => claim === 'claimed')).toHaveLength(1);
		expect(claims.filter((claim) => claim === 'busy')).toHaveLength(1);
		const token = (await row(M3)).lease_token;
		expect(['tok-manual-A', 'tok-manual-B']).toContain(token);
	});
});

describe('persistCheckResults', () => {
	it('rejeita o executor A expirado depois de B adquirir e gravar, preservando apenas B', async () => {
		const now = 900_000;
		expect(await claimMonitor(db, M1, 'tok-A', now)).toBe(true);

		// O lease de A expira e B adquire o mesmo monitor.
		const bNow = now + 15 * 60;
		expect(await claimMonitor(db, M1, 'tok-B', bNow)).toBe(true);
		expect(await persistCheckResults(db, {
			id: M1, expectedUrl: `https://${M1}.pt/`, leaseToken: 'tok-B', leaseNow: bNow,
			snapshot: { sourceUrl: `https://${M1}.pt/`, content: 'resultado B', contentHash: 'hash-B' },
			status: 'changed',
		})).toBe(true);
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots WHERE monitor_id = ?', [M1])).toBe(1);

		const acceptedA = await persistCheckResults(db, {
			id: M1, expectedUrl: `https://${M1}.pt/`, leaseToken: 'tok-A', leaseNow: bNow,
			snapshot: { sourceUrl: `https://${M1}.pt/`, content: 'resultado A obsoleto', contentHash: 'hash-A' },
			status: 'changed',
		});
		expect(acceptedA).toBe(false);

		const snapshots = await db.all<{ content: string; content_hash: string }>(
			'SELECT content, content_hash FROM snapshots WHERE monitor_id = ?', [M1],
		);
		expect(snapshots).toEqual([{ content: 'resultado B', content_hash: 'hash-B' }]);
		const monitor = await db.one<{ last_status: string; lease_token: string }>(
			'SELECT last_status, lease_token FROM monitors WHERE id = ?', [M1],
		);
		expect(monitor).toEqual({ last_status: 'changed', lease_token: 'tok-B' });
	});
});

describe('finaliseCheck', () => {
	it('token correcto: liberta o lease e agenda conclusão + frequência vigente', async () => {
		await claimMonitor(db, M1, 'tok-1', 900_000);
		await finaliseCheck(db, M1, 'tok-1', 900_090, 900_090);
		const state = await row(M1);
		expect(state.lease_token).toBeNull();
		expect(state.lease_expires_at).toBeNull();
		expect(state.next_check_at).toBe(900_090 + 15 * 60);
	});

	it('token errado não altera nada (execução antiga não pode finalizar)', async () => {
		await claimMonitor(db, M1, 'tok-1', 900_000);
		await finaliseCheck(db, M1, 'tok-OUTRO', 900_090, 900_090);
		const state = await row(M1);
		expect(state.lease_token).toBe('tok-1');
		expect(state.lease_expires_at).toBe(900_180);
		expect(state.next_check_at).toBe(900_000 + 15 * 60); // reserva de recuperação
	});

	it('lease expirado não pode ser finalizado mesmo com o token antigo', async () => {
		await claimMonitor(db, M1, 'tok-1', 900_000);
		await finaliseCheck(db, M1, 'tok-1', 900_500, 900_500);
		const state = await row(M1);
		expect(state.lease_token).toBe('tok-1');
		expect(state.next_check_at).toBe(900_000 + 15 * 60);
	});

	it('frequência alterada DURANTE a execução é respeitada e não sobrescrita', async () => {
		await claimMonitor(db, M1, 'tok-1', 900_000);
		// Utilizador muda a frequência para 60 min enquanto a verificação corre.
		db.run('UPDATE monitors SET frequency_minutes = 60 WHERE id = ?', [M1]);
		await finaliseCheck(db, M1, 'tok-1', 900_090, 900_090);
		expect((await row(M1)).next_check_at).toBe(900_090 + 60 * 60);
	});

	it('frequência removida DURANTE a execução deixa o monitor manual', async () => {
		await claimMonitor(db, M1, 'tok-1', 900_000);
		db.run('UPDATE monitors SET frequency_minutes = NULL WHERE id = ?', [M1]);
		await finaliseCheck(db, M1, 'tok-1', 900_090, 900_090);
		const state = await row(M1);
		expect(state.next_check_at).toBeNull();
		expect(state.lease_token).toBeNull();
	});

	it('monitorização manual: finalise escreve next_check_at = NULL', async () => {
		await claimOwnedMonitor(db, OWNER, M2, 'tok-2', 900_000);
		await finaliseCheck(db, M2, 'tok-2', 900_123, 900_123);
		const state = await row(M2);
		expect(state.lease_token).toBeNull();
		expect(state.next_check_at).toBeNull();
	});
});

describe('releaseLease', () => {
	it("'unchanged': liberta a reserva e mantém o agendamento", async () => {
		await claimMonitor(db, M1, 'tok-1', 900_000);
		await releaseLease(db, M1, 'tok-1', 'unchanged', 900_001);
		const state = await row(M1);
		expect(state.lease_token).toBeNull();
		expect(state.lease_expires_at).toBeNull();
		expect(state.next_check_at).toBe(900_000 + 15 * 60); // reserva de recuperação
	});

	it('token errado não liberta', async () => {
		await claimMonitor(db, M1, 'tok-1', 900_000);
		await releaseLease(db, M1, 'tok-OUTRO', 'unchanged', 900_001);
		expect((await row(M1)).lease_token).toBe('tok-1');
	});

	it("{ at }: backoff de erro interno re-agenda para o instante indicado", async () => {
		await claimMonitor(db, M1, 'tok-1', 900_000);
		await releaseLease(db, M1, 'tok-1', { at: 900_120 }, 900_001);
		const state = await row(M1);
		expect(state.lease_token).toBeNull();
		expect(state.next_check_at).toBe(900_120);
	});
});

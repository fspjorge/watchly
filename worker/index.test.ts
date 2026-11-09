import { describe, expect, it, vi } from 'vitest';

import { ApiError } from './api.ts';
import { D1Queryable } from './db.ts';

const { runSchedulerMock, dispatchEmailsMock } = vi.hoisted(() => ({ runSchedulerMock: vi.fn(), dispatchEmailsMock: vi.fn() }));
vi.mock('./scheduler.ts', () => ({ runScheduler: runSchedulerMock }));
vi.mock('./emailNotifications.ts', () => ({ dispatchEmailNotifications: dispatchEmailsMock }));

import worker, { parseMonitorPatchBody } from './index.ts';

describe('Worker entry point', () => {
	it('exports both fetch and scheduled handlers on the default module export', () => {
		expect(typeof worker.fetch).toBe('function');
		expect(typeof worker.scheduled).toBe('function');
	});

	it('routes scheduled events to the existing scheduler with the Worker D1 binding and env', async () => {
		runSchedulerMock.mockClear();
		dispatchEmailsMock.mockClear();
		const env = { watchly_db: {} as D1Database, CHECK_ENGINE: 'cloudflare' } as Env;

		await worker.scheduled?.({} as ScheduledController, env, {} as ExecutionContext);

		expect(runSchedulerMock).toHaveBeenCalledTimes(1);
		expect(runSchedulerMock.mock.calls[0][0]).toBeInstanceOf(D1Queryable);
		expect(runSchedulerMock.mock.calls[0][1]).toBeUndefined();
		expect(runSchedulerMock.mock.calls[0][2]).toBe(env);
		expect(dispatchEmailsMock).toHaveBeenCalledTimes(1);
	});
});

describe('parseMonitorPatchBody', () => {
	it('preserva frequência ausente e null como estados distintos', () => {
		expect(parseMonitorPatchBody({ name: 'Novo nome' })).toEqual({ name: 'Novo nome' });
		expect(parseMonitorPatchBody({ frequency_minutes: null })).toEqual({ frequency_minutes: null });
	});

	it.each([15, 30, 60, 360, 720, 1440])('aceita frequência válida %s', (frequency) => {
		expect(parseMonitorPatchBody({ frequency_minutes: frequency })).toEqual({
			frequency_minutes: frequency,
		});
	});

	it.each([7, 0, -15, 15.5, '15', true, {}, []])('rejeita frequência inválida %j', (frequency) => {
		expect(() => parseMonitorPatchBody({ frequency_minutes: frequency })).toThrow(ApiError);
	});
});

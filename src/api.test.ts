import { afterEach, describe, expect, it, vi } from 'vitest';

import { addMonitor, checkMonitor, frequencyLabel, type Monitor } from './api.ts';

const frequencies = [null, 15, 30, 60, 360, 720, 1440] as const;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('addMonitor frequency', () => {
	it.each(frequencies)('sends the selected frequency %s without changing it', async (frequency) => {
		const monitor: Monitor = {
			id: 'monitor-id',
			name: 'Monitor de teste',
			url: 'https://example.test/',
			created_at: '2026-11-08 00:00:00',
			last_checked_at: null,
			last_status: 'pending',
			last_error: null,
			frequency_minutes: frequency,
			next_check_at: frequency === null ? null : 1_800_000_000,
			keywords: '',
		};
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify({ monitor }), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		const returned = await addMonitor(monitor.name, monitor.url, frequency);

		expect(returned.frequency_minutes).toBe(frequency);
		const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(requestBody).toEqual({
			name: monitor.name,
			url: monitor.url,
			frequency_minutes: frequency,
			keywords: '',
		});
	});

	it('defaults to manual when existing callers omit the optional frequency', async () => {
		const monitor = { id: 'monitor-id', name: 'Manual', url: 'https://example.test/' };
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify({ monitor }), { status: 201 }),
		);
		vi.stubGlobal('fetch', fetchMock);

		await addMonitor(monitor.name, monitor.url);
		const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(requestBody.frequency_minutes).toBeNull();
	});

	it('sends the selected keywords unchanged on create', async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
			monitor: { id: 'm1', name: 'Monitor', url: 'https://example.test/', keywords: 'Preço\nDisponível' },
		}), { status: 201 }));
		vi.stubGlobal('fetch', fetchMock);

		await addMonitor('Monitor', 'https://example.test/', null, 'Preço\nDisponível');
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(body.keywords).toBe('Preço\nDisponível');
	});

	it('labels old monitors with a null frequency as manual-only', () => {
		expect(frequencyLabel(null)).toBe('Apenas manual');
	});
});

describe('API error messages', () => {
	it('shows the message from a failed manual check instead of masking it with HTTP status', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
			outcome: 'error', message: 'A página devolveu HTTP 502.',
		}), { status: 502, headers: { 'content-type': 'application/json' } })));

		await expect(checkMonitor('monitor-id')).rejects.toMatchObject({
			status: 502,
			message: 'A página devolveu HTTP 502.',
		});
	});
});

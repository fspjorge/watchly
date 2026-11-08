import { afterEach, describe, expect, it, vi } from 'vitest';

import { addMonitor, frequencyLabel, type Monitor } from './api.ts';

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

	it('labels old monitors with a null frequency as manual-only', () => {
		expect(frequencyLabel(null)).toBe('Apenas manual');
	});
});

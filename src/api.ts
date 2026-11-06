/**
 * Cliente da API REST do Worker.
 */

export type MonitorStatus = 'pending' | 'unchanged' | 'changed' | 'error';

export type Monitor = {
	id: string;
	name: string;
	url: string;
	created_at: string;
	last_checked_at: string | null;
	last_status: MonitorStatus;
	last_error: string | null;
};

export type CheckOutcome = 'initial' | 'unchanged' | 'changed' | 'error';

export type DiffChunk = {
	type: 'unchanged' | 'removed' | 'added';
	lines: string[];
};

export type MonitorDiff = {
	monitor: {
		id: string;
		name: string;
		url: string;
		last_status: MonitorStatus;
	};
	before: { id: number; captured_at: string };
	after: { id: number; captured_at: string };
	addedCount: number;
	removedCount: number;
	chunks: DiffChunk[];
};

class ApiRequestError extends Error {
	constructor(message: string) {
		super(message);
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		headers: { 'content-type': 'application/json' },
		...init,
	});

	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		// respostas sem corpo JSON
	}

	if (!response.ok) {
		const message =
			typeof body === 'object' && body !== null && 'error' in body
				? String((body as { error: unknown }).error)
				: `O servidor respondeu com o estado ${response.status}.`;
		throw new ApiRequestError(message);
	}

	return body as T;
}

export async function listMonitors(): Promise<Monitor[]> {
	const { monitors } = await request<{ monitors: Monitor[] }>('/api/monitors');
	return monitors;
}

export async function addMonitor(name: string, url: string): Promise<Monitor> {
	const { monitor } = await request<{ monitor: Monitor }>('/api/monitors', {
		method: 'POST',
		body: JSON.stringify({ name, url }),
	});
	return monitor;
}

export async function checkMonitor(id: string): Promise<{ outcome: CheckOutcome; message: string }> {
	return request<{ outcome: CheckOutcome; message: string }>(
		`/api/monitors/${id}/check`,
		{ method: 'POST' },
	);
}

export async function getDiff(id: string): Promise<MonitorDiff> {
	const { diff } = await request<{ diff: MonitorDiff }>(`/api/monitors/${id}/diff`);
	return diff;
}

export const STATUS_LABELS: Record<MonitorStatus, string> = {
	pending: 'Por verificar',
	unchanged: 'Sem alterações',
	changed: 'Alterações detectadas',
	error: 'Erro',
};

export function formatDate(iso: string | null): string {
	if (!iso) return '—';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '—';
	return new Intl.DateTimeFormat('pt-PT', {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(date);
}

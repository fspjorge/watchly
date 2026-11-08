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

/** Erro de API com o estado HTTP; 401/403 sinalizam fim de sessão. */
export class ApiRequestError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** Indica se o erro corresponde a sessão ausente/expirada ou acesso negado. */
export function isAuthError(error: unknown): boolean {
	return (
		error instanceof ApiRequestError &&
		(error.status === 401 || error.status === 403)
	);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		headers: { 'content-type': 'application/json' },
		// Dados pessoais: nunca ler de caches do browser.
		cache: 'no-store',
		...init,
	});

	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		// respostas sem corpo JSON (ex.: 204)
	}

	if (!response.ok) {
		const message =
			typeof body === 'object' && body !== null && 'error' in body
				? String((body as { error: unknown }).error)
				: `O servidor respondeu com o estado ${response.status}.`;
		if (response.status === 401 || response.status === 403) {
			// Sessão terminou/expirada: sinaliza globalmente para que a
			// aplicação limpe os dados em ecrã (ver App.tsx).
			window.dispatchEvent(
				new CustomEvent<string>('watchly:auth-error', { detail: message }),
			);
		}
		throw new ApiRequestError(response.status, message);
	}

	return body as T;
}

export type User = {
	id: string;
	email: string;
	name: string | null;
	created_at: string;
};

export async function getMe(): Promise<User> {
	const { user } = await request<{ user: User }>('/api/me');
	return user;
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

export async function updateMonitor(
	id: string,
	input: { name?: string; url?: string },
): Promise<Monitor> {
	const { monitor } = await request<{ monitor: Monitor }>(`/api/monitors/${id}`, {
		method: 'PATCH',
		body: JSON.stringify(input),
	});
	return monitor;
}

export async function deleteMonitor(id: string): Promise<void> {
	await request<void>(`/api/monitors/${id}`, { method: 'DELETE' });
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

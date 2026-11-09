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
	frequency_minutes: number | null;
	next_check_at: number | null;
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
	email_notifications_enabled: boolean;
};

export async function getMe(): Promise<User> {
	const { user } = await request<{ user: User }>('/api/me');
	return user;
}

export async function updateEmailNotificationPreference(enabled: boolean): Promise<boolean> {
	const result = await request<{ email_notifications_enabled: boolean }>('/api/me/preferences', {
		method: 'PATCH',
		body: JSON.stringify({ email_notifications_enabled: enabled }),
	});
	return result.email_notifications_enabled;
}

export async function listMonitors(): Promise<Monitor[]> {
	const { monitors } = await request<{ monitors: Monitor[] }>('/api/monitors');
	return monitors;
}

export async function addMonitor(
	name: string,
	url: string,
	frequency_minutes: number | null = null,
): Promise<Monitor> {
	const { monitor } = await request<{ monitor: Monitor }>('/api/monitors', {
		method: 'POST',
		body: JSON.stringify({ name, url, frequency_minutes }),
	});
	return monitor;
}

export async function updateMonitor(
	id: string,
	input: { name?: string; url?: string; frequency_minutes?: number | null },
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

/* ------------------------------------------------------------------ */
/* Verificações automáticas                                            */
/* ------------------------------------------------------------------ */

/** Frequências configuráveis, em minutos. */
export const FREQUENCY_OPTIONS: readonly number[] = [15, 30, 60, 360, 720, 1440];

/** Opções partilhadas pelos formulários de criação e edição. */
export const FREQUENCY_SELECT_OPTIONS = [
	{ value: '', label: 'Apenas manual (sem agendamento)' },
	{ value: '15', label: 'A cada 15 minutos' },
	{ value: '30', label: 'A cada 30 minutos' },
	{ value: '60', label: 'A cada hora' },
	{ value: '360', label: 'A cada 6 horas' },
	{ value: '720', label: 'A cada 12 horas' },
	{ value: '1440', label: 'Uma vez por dia' },
] as const;

/** Etiquetas pt-PT de frequência e formatação de epochs (segundos UTC). */
export function frequencyLabel(minutes: number | null): string {
	if (minutes === null) return 'Apenas manual';
	switch (minutes) {
		case 15: return '15 minutos';
		case 30: return '30 minutos';
		case 60: return '1 hora';
		case 360: return '6 horas';
		case 720: return '12 horas';
		case 1440: return '24 horas';
		default: return `${minutes} minutos`;
	}
}

/** Formata um epoch unix (segundos UTC) na hora local; null = '—'. */
export function formatEpoch(seconds: number | null): string {
	if (seconds === null) return '—';
	const date = new Date(seconds * 1000);
	if (Number.isNaN(date.getTime())) return '—';
	return new Intl.DateTimeFormat('pt-PT', {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(date);
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

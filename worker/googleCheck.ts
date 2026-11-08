/** Cloud Run adapter: transport only. Comparison and persistence stay in Worker/D1. */
export type CheckEngineEnv = {
	CHECK_ENGINE?: string;
	CLOUD_RUN_URL?: string;
	WATCHLY_HMAC_SECRET?: string;
	CLOUD_RUN_TIMEOUT_MS?: string;
	GOOGLE_DAILY_LIMIT?: string;
};

export type GoogleCheckResult = {
	content: string;
	contentHash: string;
};

export class GoogleCheckError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GoogleCheckError';
	}
}

export function configuredCheckEngine(env: CheckEngineEnv): 'cloudflare' | 'google' {
	const engine = env.CHECK_ENGINE ?? 'cloudflare';
	if (engine !== 'cloudflare' && engine !== 'google') {
		throw new GoogleCheckError('Configuração CHECK_ENGINE inválida.');
	}
	return engine;
}

function timeoutFromEnv(value: string | undefined): number {
	if (value === undefined) return 15_000;
	if (!/^\d+$/.test(value)) throw new GoogleCheckError('Configuração de timeout do Cloud Run inválida.');
	const timeout = Number(value);
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
		throw new GoogleCheckError('Configuração de timeout do Cloud Run inválida.');
	}
	return timeout;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sign(secret: string, timestamp: string, body: Uint8Array): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
	);
	const prefix = encoder.encode(`${timestamp}\n`);
	const message = new Uint8Array(prefix.length + body.length);
	message.set(prefix);
	message.set(body, prefix.length);
	return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, message)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validMetrics(value: unknown): boolean {
	if (!isRecord(value)) return false;
	for (const key of ['durationMs', 'fetchMs', 'extractMs', 'normalizeMs', 'hashMs', 'bytesReceived']) {
		const metric = value[key];
		if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0) return false;
	}
	return true;
}

function validateSuccess(value: unknown): GoogleCheckResult {
	if (!isRecord(value)) throw new GoogleCheckError('Resposta inválida do serviço Cloud Run.');
	const status = value.httpStatus;
	if (!['initial', 'unchanged', 'changed'].includes(String(value.outcome))
		|| typeof value.message !== 'string'
		|| typeof value.content !== 'string'
		|| typeof value.contentHash !== 'string'
		|| !/^[a-f0-9]{64}$/.test(value.contentHash)
		|| typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status >= 300
		|| typeof value.contentType !== 'string'
		|| !validMetrics(value.metrics)) {
		throw new GoogleCheckError('Resposta inválida do serviço Cloud Run.');
	}
	return { content: value.content, contentHash: value.contentHash };
}

/** Prepares the signed request without sending it; useful for reserving quota immediately before fetch. */
export async function prepareGoogleCheck(
	url: string,
	env: CheckEngineEnv,
): Promise<() => Promise<GoogleCheckResult>> {
	if (!env.CLOUD_RUN_URL) throw new GoogleCheckError('CLOUD_RUN_URL não está configurado.');
	const secret = env.WATCHLY_HMAC_SECRET;
	if (!secret) throw new GoogleCheckError('WATCHLY_HMAC_SECRET não está configurado.');
	const timeoutMs = timeoutFromEnv(env.CLOUD_RUN_TIMEOUT_MS);
	let endpoint: URL;
	try {
		endpoint = new URL('/v1/check', env.CLOUD_RUN_URL);
		if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error();
	} catch {
		throw new GoogleCheckError('CLOUD_RUN_URL inválido; é necessário um URL HTTPS.');
	}

	const body = new TextEncoder().encode(JSON.stringify({ url }));
	return async () => {
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = await sign(secret, timestamp, body);
		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-watchly-timestamp': timestamp,
					'x-watchly-signature': signature,
				},
				body,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			throw new GoogleCheckError(error instanceof Error && error.name === 'TimeoutError'
				? 'Timeout ao contactar o serviço Cloud Run.'
				: 'Falha ao contactar o serviço Cloud Run.');
		}
		if (!response.ok) throw new GoogleCheckError(`O serviço Cloud Run devolveu HTTP ${response.status}.`);
		let data: unknown;
		try {
			data = await response.json();
		} catch {
			throw new GoogleCheckError('Resposta JSON inválida do serviço Cloud Run.');
		}
		if (isRecord(data) && data.outcome === 'error') {
			throw new GoogleCheckError(typeof data.message === 'string' ? data.message.slice(0, 500) : 'Falha na verificação remota.');
		}
		return validateSuccess(data);
	};
}

/** Sends only the monitor URL. No caller-controlled resolver or transport options are accepted. */
export async function checkWithGoogle(url: string, env: CheckEngineEnv): Promise<GoogleCheckResult> {
	return prepareGoogleCheck(url, env).then((send) => send());
}

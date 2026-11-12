import {
	ApiError,
	checkMonitor,
	createMonitor,
	deleteMonitor,
	getMonitorDiff,
	listMonitors,
	updateMonitor,
	type MonitorDiff,
} from './api.ts';
import { AuthError, authenticateUser, type AuthEnv, type UserRecord } from './auth.ts';
import { D1Queryable } from './db.ts';
import { runScheduler } from './scheduler.ts';
import { dispatchEmailNotifications } from './emailNotifications.ts';
import { isFrequencyValid } from './scheduling.ts';
import type { Queryable } from './db.ts';
import type { CheckEngineEnv } from './googleCheck.ts';

export const handler = {
	fetch: handleRequest,
	scheduled: async (_event, env) => {
		const db = new D1Queryable(env.watchly_db);
		try {
			await runScheduler(db, undefined, env);
		} finally {
			// O dispatcher é limitado e isolado: uma falha de e-mail não interfere
			// com leases nem com o resultado do scheduler.
			await dispatchEmailNotifications(db, env);
		}
	},
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env): Promise<Response> {
	return serveApi(request, env, new D1Queryable(env.watchly_db));
}

async function json(data: unknown, status = 200): Promise<Response> {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			// Dados por utilizador: nunca podem ser guardados em caches
			// partilhadas nem reutilizados após troca de sessão.
			'cache-control': 'no-store',
		},
	});
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE']);

/**
 * Indica se um pedido de escrita tem sinais de origem cruzada que o
 * tornam um alvo de CSRF (cookies do Cloudflare Access são enviados por
 * browsers mesmo em pedidos cross-site).
 * Estratégia:
 *   - cabeçalho Origin presente → tem de coincidir com a origem do pedido;
 *   - sem Origin mas com Sec-Fetch-Site → só same-origin/none é aceite;
 *   - sem ambos (clientes sem browser, ex.: curl) → aceite.
 */
function isSameOriginWrite(request: Request): boolean {
	const origin = request.headers.get('origin');
	if (origin) {
		try {
			return new URL(origin).origin === new URL(request.url).origin;
		} catch {
			return false;
		}
	}
	const site = request.headers.get('sec-fetch-site');
	if (site) return site === 'same-origin' || site === 'none';
	return true;
}

const idPathRe = /^\/api\/monitors\/([0-9a-fA-F-]{36})\/(check|diff)$/;
const idRootRe = /^\/api\/monitors\/([0-9a-fA-F-]{36})$/;

/** Pipeline da API, testável com qualquer Queryable. */
export async function serveApi(
	request: Request,
	env: AuthEnv & CheckEngineEnv,
	db: Queryable,
): Promise<Response> {
	try {
		const url = new URL(request.url);

		// Middleware de autenticação para TODAS as rotas /api/*.
		if (!url.pathname.startsWith('/api/')) {
			return await json({ error: 'Recurso não encontrado.' }, 404);
		}

		// Protecção CSRF: rotas de escrita só aceitáveis da mesma origem.
		// (Antes da autenticação, para que pedidos cross-site nem cheguem
		// a consumir verificação de JWT.)
		if (MUTATING_METHODS.has(request.method) && !isSameOriginWrite(request)) {
			return await json({ error: 'Pedido de outra origem rejeitado.' }, 403);
		}

		const user = await authenticateUser(request, env, db);

		if (url.pathname === '/api/me' && request.method === 'GET') {
			return await json({ user: publicUser(user) });
		}

		if (url.pathname === '/api/me/preferences' && request.method === 'PATCH') {
			const body = await parseJsonBody(request);
			if (typeof body.email_notifications_enabled !== 'boolean') {
				throw new ApiError(400, 'email_notifications_enabled deve ser true ou false.');
			}
			await db.run(
				'UPDATE users SET email_notifications_enabled = ? WHERE id = ?',
				[body.email_notifications_enabled ? 1 : 0, user.id],
			);
			const updated = await db.one<{ email_notifications_enabled: number }>(
				'SELECT email_notifications_enabled FROM users WHERE id = ?', [user.id],
			);
			return await json({ email_notifications_enabled: updated?.email_notifications_enabled === 1 });
		}

		if (url.pathname === '/api/monitors') {
			if (request.method === 'GET') {
				const monitors = await listMonitors(db, user);
				return await json({ monitors });
			}

			if (request.method === 'POST') {
				const body: unknown = await parseJsonBody(request);
				// user_id do corpo é ignorado SEMPRE: o proprietário é o autenticado.
				const monitor = await createMonitor(
					db,
					user,
					body as { name?: unknown; url?: unknown; frequency_minutes?: unknown; keywords?: unknown },
				);
				return await json({ monitor }, 201);
			}

			return await json({ error: 'Método não suportado.' }, 405);
		}

		const idMatch = idPathRe.exec(url.pathname);
		if (idMatch && request.method === 'POST') {
			if (idMatch[2] !== 'check') {
				return await json({ error: 'Recurso não encontrado.' }, 404);
			}
			const result = await checkMonitor(db, user, idMatch[1], env);
			return await json(
				{ outcome: result.outcome, message: result.message },
				result.outcome === 'error' ? 502 : 200,
			);
		}

		if (idMatch && request.method === 'GET' && idMatch[2] === 'diff') {
			const diff = await getMonitorDiff(db, user, idMatch[1]);
			if (!diff) {
				return await json(
					{
						error:
							'Ainda não há duas versões do URL actual para comparar. Efectua a verificação inicial e, depois de o conteúdo mudar, volta a verificar.',
					},
					404,
				);
			}
			return await json({ diff: serialiseDiff(diff) });
		}

		const rootMatch = idRootRe.exec(url.pathname);
		if (rootMatch) {
			if (request.method === 'PATCH') {
				const body = await parseJsonBody(request);
				const monitor = await updateMonitor(
					db,
					user,
					rootMatch[1],
					parseMonitorPatchBody(body),
				);
				return await json({ monitor });
			}

			if (request.method === 'DELETE') {
				await deleteMonitor(db, user, rootMatch[1]);
				return new Response(null, {
					status: 204,
					headers: { 'cache-control': 'no-store' },
				});
			}

			return await json({ error: 'Método não suportado.' }, 405);
		}

		return await json({ error: 'Recurso não encontrado.' }, 404);
	} catch (error) {
		if (error instanceof ApiError) {
			return await json({ error: error.message }, error.status);
		}
		if (error instanceof AuthError) {
			return await json({ error: error.message }, error.status);
		}
		console.error('Erro inesperado na API', error);
		return await json({ error: 'Erro inesperado no servidor.' }, 500);
	}
}

/** Valida os campos do PATCH antes de atravessar a fronteira da API. */
export function parseMonitorPatchBody(
	body: Record<string, unknown>,
): { name?: unknown; url?: unknown; frequency_minutes?: number | null; keywords?: unknown } {
	const patch: { name?: unknown; url?: unknown; frequency_minutes?: number | null; keywords?: unknown } = {};
	if (Object.hasOwn(body, 'name')) patch.name = body.name;
	if (Object.hasOwn(body, 'url')) patch.url = body.url;
	if (Object.hasOwn(body, 'frequency_minutes')) {
		if (!isFrequencyValid(body.frequency_minutes)) {
			throw new ApiError(
				400,
				'Frequência inválida. Valores aceites: manual (null), 15, 30, 60, 360, 720 ou 1440 minutos.',
			);
		}
		patch.frequency_minutes = body.frequency_minutes;
	}
	if (Object.hasOwn(body, 'keywords')) patch.keywords = body.keywords;
	return patch;
}

function publicUser(user: UserRecord): unknown {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		created_at: user.created_at,
		email_notifications_enabled: user.email_notifications_enabled === 1,
	};
}

function serialiseDiff(diff: MonitorDiff): unknown {
	return {
		monitor: {
			id: diff.monitor.id,
			name: diff.monitor.name,
			url: diff.monitor.url,
			last_status: diff.monitor.last_status,
		},
		before: diff.before,
		after: diff.after,
		addedCount: diff.addedCount,
		removedCount: diff.removedCount,
		keywords: diff.keywords,
		filteredByKeywords: diff.filteredByKeywords,
		hasMatchingDiff: diff.hasMatchingDiff,
		chunks: diff.chunks,
	};
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
	// Exige application/json: além de validação de entrada, força preflight
	// CORS em pedidos cross-origin com corpo (date-blind CSRF de fetch fica
	// bloqueado no gate de Origin/Sec-Fetch-Site).
	const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
	if (!contentType.includes('application/json')) {
		throw new ApiError(
			415,
			'O corpo da mensagem deve ser JSON com Content-Type: application/json.',
		);
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new ApiError(400, 'O corpo da mensagem deve ser um objecto JSON válido.');
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		throw new ApiError(400, 'O corpo da mensagem deve ser um objecto JSON válido.');
	}
	return body as Record<string, unknown>;
}

export default handler;

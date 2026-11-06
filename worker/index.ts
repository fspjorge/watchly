import {
	ApiError,
	checkMonitor,
	createMonitor,
	getMonitorDiff,
	listMonitors,
	type MonitorDiff,
} from './api.ts';

export default {
	fetch: handleRequest,
} satisfies ExportedHandler<Env>;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

const idPathRe = /^\/api\/monitors\/([0-9a-f-]{36})\/(check|diff)$/;

async function handleRequest(request: Request, env: Env): Promise<Response> {
	try {
		const url = new URL(request.url);
		const db = env.watchly_db;

		if (url.pathname === '/api/monitors') {
			if (request.method === 'GET') {
				const monitors = await listMonitors(db);
				return json({ monitors });
			}

			if (request.method === 'POST') {
				const body: unknown = await parseJsonBody(request);
				const monitor = await createMonitor(
					db,
					body as { name?: unknown; url?: unknown },
				);
				return json({ monitor }, 201);
			}

			return json({ error: 'Método não suportado.' }, 405);
		}

		const idMatch = idPathRe.exec(url.pathname);
		if (idMatch && request.method === 'POST' && idMatch[2] === 'check') {
			const result = await checkMonitor(db, idMatch[1]);
			return json(
				{ outcome: result.outcome, message: result.message },
				result.outcome === 'error' ? 502 : 200,
			);
		}

		if (idMatch && request.method === 'GET' && idMatch[2] === 'diff') {
			const diff = await getMonitorDiff(db, idMatch[1]);
			if (!diff) {
				return json(
					{
						error:
							'Ainda não há duas versões para comparar. Efectua a verificação inicial e, depois de o conteúdo mudar, volta a verificar.',
					},
					404,
				);
			}
			return json({ diff: serialiseDiff(diff) });
		}

		return json({ error: 'Recurso não encontrado.' }, 404);
	} catch (error) {
		if (error instanceof ApiError) {
			return json({ error: error.message }, error.status);
		}
		console.error('Erro inesperado na API', error);
		return json({ error: 'Erro inesperado no servidor.' }, 500);
	}
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
		chunks: diff.chunks,
	};
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
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

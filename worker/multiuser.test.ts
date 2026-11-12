import { afterEach, describe, expect, it, vi } from 'vitest';

import { serveApi } from './index.ts';
import { clearJwksCacheForTests, type AuthEnv } from './auth.ts';
import {
	applyMigrationFile,
	createTestIdp,
	SqliteQueryable,
	stubWorkerFetch,
	type TestIdp,
	type TestTokenClaims,
} from './testSupport.ts';

const TEAM = 'https://team.example.com';
const AUD = 'watchly-app';
const LEGACY_EMAIL = 'fspjorge@gmail.com';

function authEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
	return {
		TEAM_DOMAIN: TEAM,
		ACCESS_AUD: AUD,
		LEGACY_OWNER_EMAIL: LEGACY_EMAIL,
		DEV_AUTH: 'false',
		DEV_EMAIL: 'dev-user-a@example.test',
		DEV_NAME: 'Utilizador A (dev)',
		...overrides,
	};
}

function freshDb(): SqliteQueryable {
	const db = SqliteQueryable.open();
	applyMigrationFile(db, '0001_initial_schema.sql');
	applyMigrationFile(db, '0002_multiuser_ownership.sql');
	applyMigrationFile(db, '0003_scheduled_checks.sql');
	applyMigrationFile(db, '0004_expired_lease_backoff.sql');
	applyMigrationFile(db, '0005_google_daily_usage.sql');
	applyMigrationFile(db, '0006_email_notifications.sql');
	applyMigrationFile(db, '0007_brevo_notification_events.sql');
	applyMigrationFile(db, '0008_monitor_keywords.sql');
	return db;
}

/** Aplica 0001, insere dados do MVP (sem proprietário) e só depois a 0002. */
function dbWithLegacyData(): SqliteQueryable {
	const db = SqliteQueryable.open();
	applyMigrationFile(db, '0001_initial_schema.sql');

	db.run(
		`INSERT INTO monitors (id, name, url, created_at, last_checked_at, last_status)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		['bb1a5b1e-1111-4a10-9e1a-aaaaaaaaaaa1', 'Antiga um', 'https://velho.pt/um', '2026-11-01 10:00:00', '2026-11-01 10:03:00', 'unchanged'],
	);
	db.run(
		`INSERT INTO monitors (id, name, url, created_at, last_checked_at, last_status)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		['bb1a5b1e-2222-4a10-9e1a-aaaaaaaaaaa2', 'Antiga dois', 'https://velho.pt/dois', '2026-11-01 10:01:00', null, 'pending'],
	);
	db.run(
		`INSERT INTO snapshots (monitor_id, content, content_hash, captured_at)
		 VALUES (?, ?, ?, ?)`,
		['bb1a5b1e-1111-4a10-9e1a-aaaaaaaaaaa1', 'conteúdo antigo', 'hash-antigo', '2026-11-01 10:03:00'],
	);
	db.run(
		`INSERT INTO snapshots (monitor_id, content, content_hash, captured_at)
		 VALUES (?, ?, ?, ?)`,
		['bb1a5b1e-2222-4a10-9e1a-aaaaaaaaaaa2', 'conteúdo antigo dois', 'hash-antigo-2', '2026-11-01 10:04:00'],
	);

	applyMigrationFile(db, '0002_multiuser_ownership.sql');
	applyMigrationFile(db, '0003_scheduled_checks.sql');
	applyMigrationFile(db, '0004_expired_lease_backoff.sql');
	applyMigrationFile(db, '0005_google_daily_usage.sql');
	applyMigrationFile(db, '0006_email_notifications.sql');
	applyMigrationFile(db, '0007_brevo_notification_events.sql');
	applyMigrationFile(db, '0008_monitor_keywords.sql');
	return db;
}

async function userBySubject(db: SqliteQueryable, subject: string): Promise<string> {
	const row = await db.one<{ id: string }>(
		'SELECT id FROM users WHERE auth_subject = ?',
		[subject],
	);
	if (!row) throw new Error(`utilizador ${subject} não encontrado`);
	return row.id;
}

function call(
	db: SqliteQueryable,
	env: AuthEnv,
	idp: TestIdp,
	claims: TestTokenClaims | null,
	method: string,
	path: string,
	body?: Record<string, unknown>,
	extraHeaders: Record<string, string> = {},
): Promise<Response> {
	// Os testes usam um emissor JWT próprio. Garante que o fetch simulado
	// disponibiliza o JWKS desse emissor, sem substituir um stub HTML já instalado.
	if (!vi.isMockFunction(globalThis.fetch)) {
		stubWorkerFetch(idp, '');
	}

	const headers: Record<string, string> = { ...extraHeaders };
	if (body && !headers['content-type']) headers['content-type'] = 'application/json';
	const request = new Request(`http://localhost:8787${path}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!claims) {
		return serveApi(request, env, db);
	}
	// O token tem de ser assinado antes do pedido; mint devolve Promise.
	return idp.mint(claims).then((token) =>
		serveApi(
			new Request(`http://localhost:8787${path}`, {
				method,
				headers: { ...headers, 'Cf-Access-Jwt-Assertion': token },
				body: body ? JSON.stringify(body) : undefined,
			}),
			env,
			db,
		),
	);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type MonitorJson = { id: string; name: string; url: string; user_id: string | null };

/** BD com 0001-0003 (agendamento incluído). */
function db0003(): SqliteQueryable {
	const db = SqliteQueryable.open();
	applyMigrationFile(db, '0001_initial_schema.sql');
	applyMigrationFile(db, '0002_multiuser_ownership.sql');
	applyMigrationFile(db, '0003_scheduled_checks.sql');
	applyMigrationFile(db, '0004_expired_lease_backoff.sql');
	applyMigrationFile(db, '0005_google_daily_usage.sql');
	applyMigrationFile(db, '0006_email_notifications.sql');
	applyMigrationFile(db, '0007_brevo_notification_events.sql');
	applyMigrationFile(db, '0008_monitor_keywords.sql');
	return db;
}

/** fetch simulado que responde sempre 403 para qualquer URL de conteúdo. */
function stubForbiddenHtml(idp: TestIdp): void {
	vi.stubGlobal(
		'fetch',
		vi.fn((input: unknown) => {
			const url =
				typeof input === 'string'
					? input
					: input instanceof Request
						? input.url
						: String(input);
			if (url.endsWith('/cdn-cgi/access/certs')) {
				return Promise.resolve(
					new Response(JSON.stringify(idp.jwks), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
				);
			}
			return Promise.resolve(
				new Response('<html><title>403 Forbidden</title></html>', {
					status: 403,
					headers: { 'content-type': 'text/html' },
				}),
			);
		}),
	);
}

async function createMonitorViaApi(
	db: SqliteQueryable,
	env: AuthEnv,
	idp: TestIdp,
	claims: TestTokenClaims,
	body: Record<string, unknown>,
): Promise<Response> {
	return call(db, env, idp, claims, 'POST', '/api/monitors', body);
}

/** Devolve conteúdo diferente em cada verificação do mesmo URL. */
function stubChangingHtml(idp: TestIdp): void {
	const requestCounts = new Map<string, number>();
	stubWorkerFetch(idp, (rawUrl) => {
		const url = new URL(rawUrl);
		const baseVersion = Number(url.searchParams.get('v') ?? '0');
		const requestCount = (requestCounts.get(rawUrl) ?? 0) + 1;
		requestCounts.set(rawUrl, requestCount);
		return `<p>${baseVersion + requestCount - 1}</p>`;
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	// Cada teste cria um par de chaves diferente, pelo que não podemos
	// reutilizar o JWKS remoto em cache do teste anterior.
	clearJwksCacheForTests();
});

describe('Registo de utilizadores', () => {
	it('pedido sem token devolve 401', async () => {
		const idp = await createTestIdp();
		const response = await call(freshDb(), authEnv(), idp, null, 'GET', '/api/me');
		expect(response.status).toBe(401);
	});

	it('primeiro login cria o perfil; o seguinte reutiliza o mesmo perfil', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();
		const claims = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test', name: 'Alice' };

		const first = await call(db, env, idp, claims, 'GET', '/api/me');
		expect(first.status).toBe(200);
		const firstUser = (await first.json()).user as { id: string; email: string; name: string | null };
		expect(firstUser.email).toBe('a@example.test');
		expect(firstUser.name).toBe('Alice');

		const second = await call(db, env, idp, claims, 'GET', '/api/me');
		const secondUser = (await second.json()).user as { id: string };
		expect(secondUser.id).toBe(firstUser.id);
		expect(db.count('SELECT COUNT(*) AS total FROM users')).toBe(1);
	});

	it('actualização de nome/email mantém a identidade por auth_subject', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();

		const primeiro = await call(
			db, env, idp,
			{ iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test', name: 'Alice Antiga' },
			'GET', '/api/me',
		);
		const idPrimeiro = ((await primeiro.json()).user as { id: string }).id;

		const segundo = await call(
			db, env, idp,
			{ iss: TEAM, aud: AUD, sub: 'sub-A', email: 'novo-email@example.test' },
			'GET', '/api/me',
		);
		const perfil = (await segundo.json()).user as { id: string; email: string; name: string | null };
		expect(perfil.id).toBe(idPrimeiro);
		expect(perfil.email).toBe('novo-email@example.test');
		expect(db.count('SELECT COUNT(*) AS total FROM users')).toBe(1);
	});

	it('email igual com subject diferente não funde contas', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();

		await call(db, env, idp, { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'partilhado@example.test' }, 'GET', '/api/me');
		await call(db, env, idp, { iss: TEAM, aud: AUD, sub: 'sub-B', email: 'Partilhado@Example.Test' }, 'GET', '/api/me');

		expect(
			db.count('SELECT COUNT(*) AS total FROM users WHERE LOWER(email) = ?', ['partilhado@example.test']),
		).toBe(2);
	});
});

describe('Associação dos dados antigos (LEGACY_OWNER_EMAIL)', () => {
	it('só o proprietário inicial recebe os registos antigos; é idempotente; novos utilizadores não recebem nada', async () => {
		const db = dbWithLegacyData();
		const env = authEnv();
		const idp = await createTestIdp();

		// Login de outro utilizador: não vê os registos órfãos.
		const respostaB = await call(
			db, env, idp,
			{ iss: TEAM, aud: AUD, sub: 'sub-B', email: 'b@example.test' },
			'GET', '/api/monitors',
		);
		expect(((await respostaB.json()) as { monitors: unknown[] }).monitors).toEqual([]);

		// Login do proprietário inicial: recebe os registos antigos.
		const respostaLegado = await call(
			db, env, idp,
			{ iss: TEAM, aud: AUD, sub: 'sub-legado', email: '  FspJorge@GMAIL.com ' },
			'GET', '/api/monitors',
		);
		const monitoresLegado = ((await respostaLegado.json()) as { monitors: Array<{ id: string }> }).monitors;
		expect(monitoresLegado).toHaveLength(2);

		const legacyId = await userBySubject(db, 'sub-legado');
		expect(db.count('SELECT COUNT(*) AS total FROM monitors WHERE user_id IS NULL')).toBe(0);
		expect(db.count('SELECT COUNT(*) AS total FROM monitors WHERE user_id = ?', [legacyId])).toBe(2);

		// Segundo login do proprietário: idempotente (nada muda, nada duplica).
		await call(
			db, env, idp,
			{ iss: TEAM, aud: AUD, sub: 'sub-legado', email: LEGACY_EMAIL },
			'GET', '/api/monitors',
		);
		expect(db.count('SELECT COUNT(*) AS total FROM users')).toBe(2);
		expect(db.count('SELECT COUNT(*) AS total FROM monitors WHERE user_id = ?', [legacyId])).toBe(2);
		// snapshots do histórico conservados.
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots')).toBe(2);
	});
});

describe('Isolamento entre utilizadores', () => {
	it('cada utilizador só vê, verifica, edita e apaga as suas monitorizações', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();

		const claimsA = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' };
		const claimsB = { iss: TEAM, aud: AUD, sub: 'sub-B', email: 'b@example.test' };

		const criadaA = await createMonitorViaApi(db, env, idp, claimsA, {
			name: 'Mon A',
			url: 'https://conteudo.pt/mon-a',
		});
		expect(criadaA.status).toBe(201);
		const monitorA = ((await criadaA.json()) as { monitor: MonitorJson }).monitor;
		expect(monitorA.user_id).toBe(await userBySubject(db, 'sub-A'));

		const criadaB = await createMonitorViaApi(db, env, idp, claimsB, {
			name: 'Mon B',
			url: 'https://conteudo.pt/mon-b',
		});
		const monitorB = ((await criadaB.json()) as { monitor: MonitorJson }).monitor;

		// Listagens separadas.
		const listaA = await call(db, env, idp, claimsA, 'GET', '/api/monitors');
		expect(((await listaA.json()) as { monitors: MonitorJson[] }).monitors.map((m) => m.name)).toEqual(['Mon A']);
		const listaB = await call(db, env, idp, claimsB, 'GET', '/api/monitors');
		expect(((await listaB.json()) as { monitors: MonitorJson[] }).monitors.map((m) => m.name)).toEqual(['Mon B']);

		// Tentativas de A sobre a monitorização de B devolvem 404.
		expect((await call(db, env, idp, claimsA, 'POST', `/api/monitors/${monitorB.id}/check`)).status).toBe(404);
		expect((await call(db, env, idp, claimsA, 'GET', `/api/monitors/${monitorB.id}/diff`)).status).toBe(404);
		expect((await call(db, env, idp, claimsA, 'PATCH', `/api/monitors/${monitorB.id}`, { name: 'Hackeada' })).status).toBe(404);
		expect((await call(db, env, idp, claimsA, 'DELETE', `/api/monitors/${monitorB.id}`)).status).toBe(404);

		// A monitorização de B permanece intacta e ao seu alcance.
		const listaFinalB = await call(db, env, idp, claimsB, 'GET', '/api/monitors');
		const monitoresFinalB = ((await listaFinalB.json()) as { monitors: MonitorJson[] }).monitors;
		expect(monitoresFinalB.map((m) => m.name)).toEqual(['Mon B']);
	});

	it('user_id enviado no corpo não contorna a autorização', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();

		const claimsA = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' };
		const claimsB = { iss: TEAM, aud: AUD, sub: 'sub-B', email: 'b@example.test' };
		await call(db, env, idp, claimsB, 'GET', '/api/me');
		const idB = await userBySubject(db, 'sub-B');

		// POST com user_id de B no corpo: o proprietário é sempre o autenticado (A).
		const respostaCriacao = await createMonitorViaApi(db, env, idp, claimsA, {
			name: 'Injeção',
			url: 'https://conteudo.pt/injecao',
			user_id: idB,
		});
		const monitorCriada = ((await respostaCriacao.json()) as { monitor: MonitorJson }).monitor;
		expect(monitorCriada.user_id).toBe(await userBySubject(db, 'sub-A'));
		expect(monitorCriada.user_id).not.toBe(idB);

		// PATCH com user_id de B também é ignorado.
		await call(db, env, idp, claimsA, 'PATCH', `/api/monitors/${monitorCriada.id}`, {
			name: 'Injeção 2',
			user_id: idB,
		});
		const monitorDepois = await db.one<{ user_id: string }>(
			'SELECT user_id FROM monitors WHERE id = ?',
			[monitorCriada.id],
		);
		expect(monitorDepois === null ? null : monitorDepois.user_id).toBe(await userBySubject(db, 'sub-A'));
		expect(monitorDepois === null ? null : monitorDepois.user_id).not.toBe(idB);
	});
});

describe('Protecção de sessão e CSRF', () => {
	it('escrita com Origin cruzado é rejeitada com 403 (POST/PATCH/DELETE)', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();
		const claims = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' };

		const criada = await call(
			db, env, idp, claims, 'POST', '/api/monitors',
			{ name: 'Legítima', url: 'https://conteudo.pt/csrf' },
			{ origin: 'http://localhost:8787' },
		);
		expect(criada.status).toBe(201);
		const monitor = ((await criada.json()) as { monitor: MonitorJson }).monitor;

		await expect(
			call(db, env, idp, claims, 'POST', '/api/monitors', { name: 'X', url: 'https://conteudo.pt/x' }, { origin: 'https://atacante.example' }),
		).resolves.toMatchObject({ status: 403 });
		await expect(
			call(db, env, idp, claims, 'PATCH', `/api/monitors/${monitor.id}`, { name: 'X' }, { origin: 'https://atacante.example' }),
		).resolves.toMatchObject({ status: 403 });
		await expect(
			call(db, env, idp, claims, 'DELETE', `/api/monitors/${monitor.id}`, undefined, { origin: 'https://atacante.example' }),
		).resolves.toMatchObject({ status: 403 });

		// Nada foi criado nem alterado.
		expect(db.count('SELECT COUNT(*) AS total FROM monitors WHERE name = ?', ['X'])).toBe(0);
	});

	it('escrita com Sec-Fetch-Site cross-site (sem Origin) é rejeitada com 403', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();
		const claims = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' };

		// Simula um POST de formulário HTML cross-site: sem Origin confiável,
		// Sec-Fetch-Site denuncia a origem cruzada.
		await expect(
			call(
				db, env, idp, claims, 'POST', '/api/monitors',
				{ name: 'X', url: 'https://conteudo.pt/form-csrf' },
				{ 'sec-fetch-site': 'cross-site' },
			),
		).resolves.toMatchObject({ status: 403 });
	});

	it('Sec-Fetch-Site same-origin/none e pedidos sem cabeçalhos de browser continuam aceites', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();
		const claims = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' };

		// Sec-Fetch-Site: same-origin → aceite.
		await expect(
			call(db, env, idp, claims, 'POST', '/api/monitors', { name: 'A', url: 'https://conteudo.pt/same' }, { 'sec-fetch-site': 'same-origin' }),
		).resolves.toMatchObject({ status: 201 });

		// Sec-Fetch-Site: none (bookmark/typed URL) → aceite.
		await expect(
			call(db, env, idp, claims, 'POST', '/api/monitors', { name: 'B', url: 'https://conteudo.pt/none' }, { 'sec-fetch-site': 'none' }),
		).resolves.toMatchObject({ status: 201 });

		// Cliente sem cabeçalhos de browser (curl/scripts próprios) → aceite.
		await expect(
			call(db, env, idp, claims, 'POST', '/api/monitors', { name: 'C', url: 'https://conteudo.pt/curl' }),
		).resolves.toMatchObject({ status: 201 });
	});

	it('leitura com Origin cruzado não é bloqueada (a protecção só se aplica a escrita)', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();
		const claims = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' };

		await expect(
			call(db, env, idp, claims, 'GET', '/api/monitors', undefined, { origin: 'https://atacante.example' }),
		).resolves.toMatchObject({ status: 200 });
	});

	it('corpo com Content-Type que não application/json devolve 415', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();
		const claims = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' };

		await expect(
			call(
				db, env, idp, claims, 'POST', '/api/monitors',
				{ name: 'X', url: 'https://conteudo.pt/texto' },
				{ 'content-type': 'text/plain' },
			),
		).resolves.toMatchObject({ status: 415 });
	});
});

describe('Cabecalhos de cache das respostas da API', () => {
	it('respostas de sucesso incluem Cache-Control: no-store (200/201/204)', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();
		const claims = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' };

		const me = await call(db, env, idp, claims, 'GET', '/api/me');
		expect(me.status).toBe(200);
		expect(me.headers.get('cache-control')).toBe('no-store');

		const criada = await call(db, env, idp, claims, 'POST', '/api/monitors', { name: 'A', url: 'https://conteudo.pt/cache' });
		expect(criada.status).toBe(201);
		expect(criada.headers.get('cache-control')).toBe('no-store');

		const apagada = await call(db, env, idp, claims, 'DELETE', `/api/monitors/${((await criada.json()) as { monitor: MonitorJson }).monitor.id}`);
		expect(apagada.status).toBe(204);
		expect(apagada.headers.get('cache-control')).toBe('no-store');
	});

	it('erros (401/403/404) também incluem Cache-Control: no-store', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();
		const claims = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' };

		const semToken = await call(freshDb(), env, idp, null, 'GET', '/api/me');
		expect(semToken.status).toBe(401);
		expect(semToken.headers.get('cache-control')).toBe('no-store');

		const csrf = await call(db, env, idp, claims, 'POST', '/api/monitors', { name: 'X', url: 'https://conteudo.pt/x' }, { origin: 'https://atacante.example' });
		expect(csrf.status).toBe(403);
		expect(csrf.headers.get('cache-control')).toBe('no-store');

		const inexistente = await call(db, env, idp, claims, 'GET', '/api/monitors/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/diff');
		expect(inexistente.status).toBe(404);
		expect(inexistente.headers.get('cache-control')).toBe('no-store');
	});
});

describe('Configuração de produção (guard fail-loud)', () => {
	it('TEAM_DOMAIN/ACCESS_AUD com placeholders devolvem 500 com mensagem clara (não 401 silencioso)', async () => {
		const db = freshDb();
		const idp = await createTestIdp();

		const respostaTeam = await call(
			db,
			authEnv({ TEAM_DOMAIN: 'https://SUBSTITUIR-ME.cloudflareaccess.com', ACCESS_AUD: 'aud-real' }),
			idp, null, 'GET', '/api/me',
		);
		expect(respostaTeam.status).toBe(500);
		expect(await respostaTeam.text()).toMatch(/TEAM_DOMAIN/i);

		const respostaAud = await call(
			db,
			authEnv({ TEAM_DOMAIN: 'https://team-real.example.com', ACCESS_AUD: 'SUBSTITUIR-ME' }),
			idp, null, 'GET', '/api/me',
		);
		expect(respostaAud.status).toBe(500);
		expect(await respostaAud.text()).toMatch(/ACCESS_AUD/i);
	});

	it('TEAM_DOMAIN sem https é rejeitado com 500', async () => {
		const db = freshDb();
		const idp = await createTestIdp();

		const resposta = await call(
			db,
			authEnv({ TEAM_DOMAIN: 'http://team-real.example.com' }),
			idp, null, 'GET', '/api/me',
		);
		expect(resposta.status).toBe(500);
		expect(await resposta.text()).toMatch(/https/i);
	});

	it('modo de desenvolvimento local funciona mesmo com placeholders (guard só se aplica a produção)', async () => {
		const db = freshDb();
		const idp = await createTestIdp();

		const resposta = await call(
			db,
			authEnv({
				DEV_AUTH: 'true',
				TEAM_DOMAIN: 'https://SUBSTITUIR-ME.cloudflareaccess.com',
				ACCESS_AUD: 'SUBSTITUIR-ME',
			}),
			idp, null, 'GET', '/api/me',
		);
		expect(resposta.status).toBe(200);
	});
});

describe('Gestão e histórico', () => {
	it('editar o nome preserva o histórico e mantém a comparação do mesmo URL', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();
		const claimsA = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' };

		stubChangingHtml(idp);

		const criada = await createMonitorViaApi(db, env, idp, claimsA, {
			name: 'Mon H',
			url: 'https://conteudo.pt/hist?v=1',
		});
		const monitor = ((await criada.json()) as { monitor: MonitorJson }).monitor;

		expect(((await (await call(db, env, idp, claimsA, 'POST', `/api/monitors/${monitor.id}/check`)).json()) as { outcome: string }).outcome).toBe('initial');

		// Novo conteúdo no mesmo URL (v=2) → 'changed'.
		await sleep(2600);
		expect(((await (await call(db, env, idp, claimsA, 'POST', `/api/monitors/${monitor.id}/check`)).json()) as { outcome: string }).outcome).toBe('changed');

		// Editar apenas o nome: o diff do mesmo URL continua disponível.
		const patch = await call(db, env, idp, claimsA, 'PATCH', `/api/monitors/${monitor.id}`, { name: 'Mon H renomeada' });
		expect(patch.status).toBe(200);
		const depoisNome = ((await patch.json()) as { monitor: MonitorJson }).monitor;
		expect(depoisNome.name).toBe('Mon H renomeada');
		expect(depoisNome.url).toBe('https://conteudo.pt/hist?v=1');

		const diff = await call(db, env, idp, claimsA, 'GET', `/api/monitors/${monitor.id}/diff`);
		expect(diff.status).toBe(200);
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots WHERE monitor_id = ?', [monitor.id])).toBe(2);
	});

	it('alterar o URL preserva os snapshots antigos e nunca compara URLs diferentes', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();
		const claimsA = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' };

		stubChangingHtml(idp);

		const criada = await createMonitorViaApi(db, env, idp, claimsA, {
			name: 'Mon U',
			url: 'https://conteudo.pt/hist?v=1',
		});
		const monitor = ((await criada.json()) as { monitor: MonitorJson }).monitor;

		await call(db, env, idp, claimsA, 'POST', `/api/monitors/${monitor.id}/check`);
		await sleep(2600);
		await call(db, env, idp, claimsA, 'POST', `/api/monitors/${monitor.id}/check`);
		const snapIdsAntes = await db.all<{ id: number }>(
			'SELECT id FROM snapshots WHERE monitor_id = ? ORDER BY id',
			[monitor.id],
		);
		expect(snapIdsAntes).toHaveLength(2);

		// Editar o URL: estado a "Por verificar" (pending).
		const patch = await call(db, env, idp, claimsA, 'PATCH', `/api/monitors/${monitor.id}`, {
			url: 'https://conteudo.pt/hist?v=3',
		});
		const monitorEditada = ((await patch.json()) as { monitor: MonitorJson }).monitor;
		expect(monitorEditada.url).toBe('https://conteudo.pt/hist?v=3');
		const rowDepois = await db.one<{ last_status: string }>(
			'SELECT last_status FROM monitors WHERE id = ?',
			[monitor.id],
		);
		expect(rowDepois === null ? null : rowDepois.last_status).toBe('pending');

		// Snapshots antigos preservados com o seu source_url.
		const antiços = await db.all<{ id: number; source_url: string }>(
			'SELECT id, source_url FROM snapshots WHERE monitor_id = ? ORDER BY id',
			[monitor.id],
		);
		expect(antiços).toHaveLength(2);
		expect(antiços.every((s) => s.source_url === 'https://conteudo.pt/hist?v=1')).toBe(true);

		// diff ainda não existe para o URL novo (nunca compara com o antigo).
		const diffAntes = await call(db, env, idp, claimsA, 'GET', `/api/monitors/${monitor.id}/diff`);
		expect(diffAntes.status).toBe(404);

		// Primeira verificação do URL novo: referência inicial em branco.
		const primeiraNova = await call(db, env, idp, claimsA, 'POST', `/api/monitors/${monitor.id}/check`);
		expect(((await primeiraNova.json()) as { outcome: string }).outcome).toBe('initial');

		// Nova mudança: 'changed' e a comparação só usa versões do URL novo.
		await sleep(2600);
		const segundaNova = await call(db, env, idp, claimsA, 'POST', `/api/monitors/${monitor.id}/check`);
		expect(((await segundaNova.json()) as { outcome: string }).outcome).toBe('changed');

		const diffNovo = await call(db, env, idp, claimsA, 'GET', `/api/monitors/${monitor.id}/diff`);
		expect(diffNovo.status).toBe(200);
		const dadosDiff = (await diffNovo.json()) as {
			diff: { before: { id: number }; after: { id: number }; chunks: Array<{ type: string; lines: string[] }> };
		};
		const linhasDiff = dadosDiff.diff.chunks.flatMap((c) => c.lines);
		expect(linhasDiff).toContain('3');
		expect(linhasDiff).not.toContain('1');

		// Total: 2 antigas + 2 novas.
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots WHERE monitor_id = ?', [monitor.id])).toBe(4);
	}, 15_000);

	it('apagar uma monitorização própria apaga os snapshots; apagar alheia devolve 404', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();

		const claimsA = { iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' };
		const claimsB = { iss: TEAM, aud: AUD, sub: 'sub-B', email: 'b@example.test' };

		stubWorkerFetch(idp, (url) => `<p>${new URL(url).searchParams.get('v') ?? '0'}</p>`);

		const criadaA = await createMonitorViaApi(db, env, idp, claimsA, {
			name: 'Mon A',
			url: 'https://conteudo.pt/apagar-a',
		});
		const monitorA = ((await criadaA.json()) as { monitor: MonitorJson }).monitor;
		await call(db, env, idp, claimsA, 'POST', `/api/monitors/${monitorA.id}/check`);
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots WHERE monitor_id = ?', [monitorA.id])).toBe(1);

		const criadaB = await createMonitorViaApi(db, env, idp, claimsB, {
			name: 'Mon B',
			url: 'https://conteudo.pt/apagar-b',
		});
		const monitorB = ((await criadaB.json()) as { monitor: MonitorJson }).monitor;
		await call(db, env, idp, claimsB, 'POST', `/api/monitors/${monitorB.id}/check`);

		// A tenta apagar a de B: 404 e nada muda.
		expect((await call(db, env, idp, claimsA, 'DELETE', `/api/monitors/${monitorB.id}`)).status).toBe(404);
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots WHERE monitor_id = ?', [monitorB.id])).toBe(1);

		// A apaga a sua: monitor e snapshots desaparecem.
		const deleted = await call(db, env, idp, claimsA, 'DELETE', `/api/monitors/${monitorA.id}`);
		expect(deleted.status).toBe(204);
		expect(db.count('SELECT COUNT(*) AS total FROM monitors WHERE id = ?', [monitorA.id])).toBe(0);
		expect(db.count('SELECT COUNT(*) AS total FROM snapshots WHERE monitor_id = ?', [monitorA.id])).toBe(0);
	});
});

describe('Verificações agendadas — endpoint manual e PATCH (0003)', () => {
	const claims = () => ({ iss: TEAM, aud: AUD, sub: 'sub-A', email: 'a@example.test' });

	async function setup(stub = 'html'): Promise<{
		db: SqliteQueryable; env: AuthEnv; idp: TestIdp; monitor: MonitorJson;
	}> {
		const db = db0003();
		const env = authEnv();
		const idp = await createTestIdp();
		const c = claims();
		if (stub === '403') {
			stubForbiddenHtml(idp);
		} else {
			stubWorkerFetch(idp, (url) => `<p>${new URL(url).searchParams.get('v') ?? '0'}</p>`);
		}
		const criada = await createMonitorViaApi(db, env, idp, c, {
			name: 'Mon Sched',
			url: 'https://conteudo.pt/sched',
		});
		return { db, env, idp, monitor: ((await criada.json()) as { monitor: MonitorJson }).monitor };
	}

	async function schedulingRow(db: SqliteQueryable, id: string) {
		return db.one<{
			frequency_minutes: number | null; next_check_at: number | null;
			lease_expires_at: number | null; lease_token: string | null;
		}>(
			'SELECT frequency_minutes, next_check_at, lease_expires_at, lease_token FROM monitors WHERE id = ?',
			[id],
		);
	}

	it('POST /check com frequência 30 min agende a próxima ≈ agora + 1800 s e limpe a reserva', async () => {
		const { db, env, idp, monitor } = await setup();
		await call(db, env, idp, claims(), 'PATCH', `/api/monitors/${monitor.id}`, { frequency_minutes: 30 });
		const antes = Date.now();
		const resposta = await call(db, env, idp, claims(), 'POST', `/api/monitors/${monitor.id}/check`);
		expect(resposta.status).toBe(200);
		const row = await schedulingRow(db, monitor.id);
		expect(row).not.toBeNull();
		expect(row && row.frequency_minutes).toBe(30);
		expect(row && row.lease_token).toBeNull();
		const esperado = row && row.next_check_at;
		if (typeof esperado === 'number') {
			const agora = Date.now();
			// Entre 'antes' e 'agora' (em ocasiões): conclusão do check.
			expect(esperado).toBeGreaterThanOrEqual(Math.floor(antes / 1000) + 1800);
			expect(esperado).toBeLessThanOrEqual(Math.floor(agora / 1000) + 1801);
		} else {
			throw new Error('next_check_at não foi agendado');
		}
	});

	it('POST /check em monitorização manual mantém next_check_at NULL', async () => {
		const { db, env, idp, monitor } = await setup();
		const resposta = await call(db, env, idp, claims(), 'POST', `/api/monitors/${monitor.id}/check`);
		expect(resposta.status).toBe(200);
		const row = await schedulingRow(db, monitor.id);
		expect(row && row.next_check_at).toBeNull();
		expect(row && row.lease_token).toBeNull();
	});

	it('POST /check duplicado durante verificação em curso devolve 409; após lease expirar, volta a funcionar', async () => {
		const { db, env, idp, monitor } = await setup();
		// Outro executor (cron ou pedido manual antigo) tomou posse agora.
		db.run('UPDATE monitors SET lease_token = ?, lease_expires_at = ? WHERE id = ?', [
			'tok-outro', Math.floor(Date.now() / 1000) + 120, monitor.id,
		]);
		const bloqueado = await call(db, env, idp, claims(), 'POST', `/api/monitors/${monitor.id}/check`);
		expect(bloqueado.status).toBe(409);
		expect((await bloqueado.json()) as { error: string }).toMatchObject({ error: /Verificação em curso/ });

		// A reserva expira (execução interrompida), o utilizador volta ao trabalho.
		db.run('UPDATE monitors SET lease_expires_at = ? WHERE id = ?', [
			Math.floor(Date.now() / 1000) - 1, monitor.id,
		]);
		const resposta = await call(db, env, idp, claims(), 'POST', `/api/monitors/${monitor.id}/check`);
		expect(resposta.status).toBe(200);
	});

	it('PATCH activa frequência e agenda a primeira verificação para já', async () => {
		const { db, env, idp, monitor } = await setup();
		const antes = Math.floor(Date.now() / 1000);
		const patch = await call(db, env, idp, claims(), 'PATCH', `/api/monitors/${monitor.id}`, { frequency_minutes: 60 });
		expect(patch.status).toBe(200);
		const row = await schedulingRow(db, monitor.id);
		expect(row && row.frequency_minutes).toBe(60);
		const next = row && row.next_check_at;
		if (typeof next !== 'number') throw new Error('activação não agendou');
		expect(next).toBeGreaterThanOrEqual(antes); // "imediatamente"
		expect(next).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
	});

	it('PATCH desactiva a frequência (null) e esvazia o agendamento', async () => {
		const { db, env, idp, monitor } = await setup();
		await call(db, env, idp, claims(), 'PATCH', `/api/monitors/${monitor.id}`, { frequency_minutes: 15 });
		const patch = await call(db, env, idp, claims(), 'PATCH', `/api/monitors/${monitor.id}`, { frequency_minutes: null });
		expect(patch.status).toBe(200);
		const row = await schedulingRow(db, monitor.id);
		expect(row && row.frequency_minutes).toBeNull();
		expect(row && row.next_check_at).toBeNull();
	});

	it('PATCH com frequência inválida devolve 400', async () => {
		const { db, env, idp, monitor } = await setup();
		const patch = await call(db, env, idp, claims(), 'PATCH', `/api/monitors/${monitor.id}`, { frequency_minutes: 7 });
		expect(patch.status).toBe(400);
		const row = await schedulingRow(db, monitor.id);
		expect(row && row.frequency_minutes).toBeNull();
	});

	it('PATCH que altera o URL reinicia o estado e deixa próxima verificação = agora + frequência', async () => {
		const { db, env, idp, monitor } = await setup();
		await call(db, env, idp, claims(), 'PATCH', `/api/monitors/${monitor.id}`, { frequency_minutes: 30 });
		const antes = Math.floor(Date.now() / 1000);
		const patch = await call(db, env, idp, claims(), 'PATCH', `/api/monitors/${monitor.id}`, {
			url: 'https://conteudo.pt/sched?v=2',
		});
		expect(patch.status).toBe(200);
		const row = await schedulingRow(db, monitor.id);
		expect(row && row.lease_token).toBeNull();
		const next = row && row.next_check_at;
		if (typeof next !== 'number') throw new Error('não agendou após alteração de URL');
		expect(next).toBeGreaterThanOrEqual(antes + 1800); // agora + 30 min
		const estado = await db.one<{ last_status: string; last_checked_at: string | null }>(
			'SELECT last_status, last_checked_at FROM monitors WHERE id = ?', [monitor.id],
		);
		expect(estado && estado.last_status).toBe('pending');
	});

	it('PATCH que só muda o nome não re-agenda a próxima verificação', async () => {
		const { db, env, idp, monitor } = await setup();
		await call(db, env, idp, claims(), 'PATCH', `/api/monitors/${monitor.id}`, { frequency_minutes: 30 });
		const antes = await schedulingRow(db, monitor.id);
		const patch = await call(db, env, idp, claims(), 'PATCH', `/api/monitors/${monitor.id}`, {
			name: 'Só o nome',
		});
		expect(patch.status).toBe(200);
		const row = await schedulingRow(db, monitor.id);
		// O agendamento vigente não pode ter sido empurrado pela mudança de nome.
		expect(row && row.next_check_at).toBe(antes && antes.next_check_at);
		expect(row && row.frequency_minutes).toBe(30);
	});

	it('PATCH que altera o URL numa monitorização manual mantém next_check_at NULL', async () => {
		const { db, env, idp, monitor } = await setup();
		const patch = await call(db, env, idp, claims(), 'PATCH', `/api/monitors/${monitor.id}`, {
			url: 'https://conteudo.pt/manual-novo',
		});
		expect(patch.status).toBe(200);
		const row = await schedulingRow(db, monitor.id);
		expect(row && row.frequency_minutes).toBeNull();
		expect(row && row.next_check_at).toBeNull();
		const estado = await db.one<{ last_status: string }>(
			'SELECT last_status FROM monitors WHERE id = ?', [monitor.id],
		);
		expect(estado && estado.last_status).toBe('pending');
	});

	it('criação continua sem frequência (NULL) e sem agendamento', async () => {
		const db = db0003();
		const env = authEnv();
		const idp = await createTestIdp();
		const c = claims();
		stubWorkerFetch(idp, '<p>ok</p>');
		const resposta = await createMonitorViaApi(db, env, idp, c, { name: 'Nova', url: 'https://conteudo.pt/nova' });
		expect(resposta.status).toBe(201);
		const monitor = ((await resposta.json()) as { monitor: MonitorJson }).monitor;
		const row = await schedulingRow(db, monitor.id);
		expect(row && row.frequency_minutes).toBeNull();
		expect(row && row.next_check_at).toBeNull();
		expect(row && row.lease_token).toBeNull();
	});

	it.each([null, 15, 30, 60, 360, 720, 1440])(
		'POST cria monitorização com frequência %s e a configuração persiste ao listar',
		async (frequency) => {
			const db = db0003();
			const env = authEnv();
			const idp = await createTestIdp();
			stubWorkerFetch(idp, '<p>ok</p>');
			const startedAt = Math.floor(Date.now() / 1000);
			const response = await createMonitorViaApi(db, env, idp, claims(), {
				name: 'Nova com frequência',
				url: 'https://conteudo.pt/nova-com-frequencia',
				frequency_minutes: frequency,
			});

			expect(response.status).toBe(201);
			const created = ((await response.json()) as { monitor: MonitorJson }).monitor;
			const saved = await schedulingRow(db, created.id);
			expect(saved?.frequency_minutes).toBe(frequency);
			if (frequency === null) {
				expect(saved?.next_check_at).toBeNull();
			} else {
				expect(saved?.next_check_at).toBeGreaterThanOrEqual(startedAt);
				expect(saved?.next_check_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
			}

			// Equivale ao reload do dashboard: GET devolve a frequência persistida.
			const listed = await call(db, env, idp, claims(), 'GET', '/api/monitors');
			expect(listed.status).toBe(200);
			const monitors = (await listed.json() as { monitors: Array<{ id: string; frequency_minutes: number | null }> }).monitors;
			expect(monitors.find((monitor) => monitor.id === created.id)?.frequency_minutes).toBe(frequency);
		},
	);

	it('POST rejeita frequência inválida sem criar monitorização', async () => {
		const db = db0003();
		const env = authEnv();
		const idp = await createTestIdp();
		stubWorkerFetch(idp, '<p>ok</p>');
		const response = await createMonitorViaApi(db, env, idp, claims(), {
			name: 'Frequência inválida',
			url: 'https://conteudo.pt/invalida',
			frequency_minutes: 7,
		});

		expect(response.status).toBe(400);
		expect(db.count('SELECT COUNT(*) AS total FROM monitors')).toBe(0);
	});

	it('resposta HTTP 403 conta como tentativa concluída: erro registado E próxima verificação agendada', async () => {
		const { db, env, idp, monitor } = await setup('403');
		await call(db, env, idp, claims(), 'PATCH', `/api/monitors/${monitor.id}`, { frequency_minutes: 15 });
		const resposta = await call(db, env, idp, claims(), 'POST', `/api/monitors/${monitor.id}/check`);
		// O outcome é erro de recolha, mas a finalização AGENDA a próxima tentativa.
		const dados = (await resposta.json()) as { outcome: string };
		expect(dados.outcome).toBe('error');
		const row = await schedulingRow(db, monitor.id);
		expect(row && row.frequency_minutes).toBe(15);
		if (typeof (row && row.next_check_at) !== 'number') {
			throw new Error('403 não agendou repetição');
		}
		expect(row && row.lease_token).toBeNull();
		const estado = await db.one<{ last_status: string }>(
			'SELECT last_status FROM monitors WHERE id = ?', [monitor.id],
		);
		expect(estado && estado.last_status).toBe('error');
	});

	it('preferência de e-mail é visível e alterável apenas pelo utilizador autenticado', async () => {
		const db = freshDb();
		const env = authEnv();
		const idp = await createTestIdp();
		const claimsA = { iss: TEAM, aud: AUD, sub: 'email-pref-A', email: 'pref-a@example.test' };
		const claimsB = { iss: TEAM, aud: AUD, sub: 'email-pref-B', email: 'pref-b@example.test' };

		const first = await call(db, env, idp, claimsA, 'GET', '/api/me');
		expect((await first.json()).user.email_notifications_enabled).toBe(false);
		const updated = await call(db, env, idp, claimsA, 'PATCH', '/api/me/preferences', {
			email_notifications_enabled: true,
		});
		expect(updated.status).toBe(200);
		expect(await updated.json()).toEqual({ email_notifications_enabled: true });
		const reload = await call(db, env, idp, claimsA, 'GET', '/api/me');
		expect((await reload.json()).user.email_notifications_enabled).toBe(true);
		const second = await call(db, env, idp, claimsB, 'GET', '/api/me');
		expect((await second.json()).user.email_notifications_enabled).toBe(false);
		const invalid = await call(db, env, idp, claimsA, 'PATCH', '/api/me/preferences', {
			email_notifications_enabled: 'false',
		});
		expect(invalid.status).toBe(400);
	});
});

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

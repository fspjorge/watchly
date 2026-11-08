import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

import {
	authenticate,
	clearJwksCacheForTests,
	devIdentity,
	normalizeEmail,
	type AuthEnv,
} from './auth.ts';
import { createTestIdp, type TestIdp } from './testSupport.ts';

const TEAM = 'https://team.example.com';
const AUD = 'watchly-app';

function env(overrides: Partial<AuthEnv> = {}): AuthEnv {
	return {
		TEAM_DOMAIN: TEAM,
		ACCESS_AUD: AUD,
		DEV_AUTH: 'false',
		DEV_EMAIL: 'dev-user-a@example.test',
		DEV_NAME: 'Utilizador A (dev)',
		...overrides,
	};
}

function request(url: string, headers: Record<string, string> = {}): Request {
	return new Request(url, { headers });
}

function withToken(token: string): Record<string, string> {
	return { 'Cf-Access-Jwt-Assertion': token };
}

/** Instala fetch registando pedidos, respondendo JWKS no endpoint de certs. */
async function stubJwksFetch(idp: TestIdp): Promise<string[]> {
	const requested: string[] = [];
	const { vi: vitest } = await import('vitest');
	vitest.stubGlobal(
		'fetch',
		vitest.fn((input: unknown) => {
			const url =
				typeof input === 'string' ? input : String((input as Request).url);
			requested.push(url);
			return Promise.resolve(
				new Response(JSON.stringify(idp.jwks), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			);
		}),
	);
	return requested;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

beforeEach(() => {
	// Cada teste gera um par de chaves novo: a cache do JWKS é limpa.
	clearJwksCacheForTests();
});

describe('verifyAccessToken / authenticate (JWT do Cloudflare Access)', () => {
	it('rejeita pedidos sem Cf-Access-Jwt-Assertion com 401', async () => {
		await expect(authenticate(request('https://app.example.com/api/me'), env())).rejects.toMatchObject({
			status: 401,
		});
	});

	it('rejeita assinatura inválida', async () => {
		const idp = await createTestIdp();
		// Assina com par de chaves diferente do incluído no JWKS.
		const wrongPair = (await crypto.subtle.generateKey(
			{
				name: 'RSASSA-PKCS1-v1_5',
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: 'SHA-256',
			},
			true,
			['sign', 'verify'],
		)) as CryptoKeyPair;
		const token = await new SignJWT({ email: 'a@b.pt' })
			.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
			.setSubject('sub-wrong')
			.setIssuer(TEAM)
			.setAudience(AUD)
			.setExpirationTime('1h')
			.sign(wrongPair.privateKey);

		await stubJwksFetch(idp);
		await expect(
			authenticate(request('https://app/api/me', withToken(token)), env()),
		).rejects.toMatchObject({ status: 401 });
	});

	it('rejeita emissor incorrecto', async () => {
		const idp = await createTestIdp();
		await stubJwksFetch(idp);
		const token = await idp.mint({
			iss: 'https://outra-org.example.com',
			aud: AUD,
			sub: 'sub-1',
			email: 'a@b.pt',
		});
		await expect(
			authenticate(request('https://app/api/me', withToken(token)), env()),
		).rejects.toMatchObject({ status: 401 });
	});

	it('rejeita audiência incorrecta', async () => {
		const idp = await createTestIdp();
		await stubJwksFetch(idp);
		const token = await idp.mint({
			iss: TEAM,
			aud: 'outra-app',
			sub: 'sub-1',
			email: 'a@b.pt',
		});
		await expect(
			authenticate(request('https://app/api/me', withToken(token)), env()),
		).rejects.toMatchObject({ status: 401 });
	});

	it('rejeita token expirado', async () => {
		const idp = await createTestIdp();
		await stubJwksFetch(idp);
		const token = await idp.mint({
			iss: TEAM,
			aud: AUD,
			sub: 'sub-1',
			email: 'a@b.pt',
			expired: true,
		});
		await expect(
			authenticate(request('https://app/api/me', withToken(token)), env()),
		).rejects.toMatchObject({ status: 401 });
	});

	it('rejeita token sem exp (requiredClaims)', async () => {
		const idp = await createTestIdp();
		await stubJwksFetch(idp);
		// Assinado com o par do IdP, mas sem setExpirationTime.
		const token = await new SignJWT({ email: 'a@b.pt' })
			.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
			.setSubject('sub-sem-exp')
			.setIssuer(TEAM)
			.setAudience(AUD)
			.sign(idp.privateKey);

		await expect(
			authenticate(request('https://app/api/me', withToken(token)), env()),
		).rejects.toMatchObject({ status: 401 });
	});

	it('rejeita token ainda não válido (nbf no futuro)', async () => {
		const idp = await createTestIdp();
		await stubJwksFetch(idp);
		const token = await idp.mint({
			iss: TEAM,
			aud: AUD,
			sub: 'sub-1',
			email: 'a@b.pt',
			notYetValid: true,
		});
		await expect(
			authenticate(request('https://app/api/me', withToken(token)), env()),
		).rejects.toMatchObject({ status: 401 });
	});

	it('rejeita token sem sub', async () => {
		const idp = await createTestIdp();
		await stubJwksFetch(idp);
		const token = await idp.mint({ iss: TEAM, aud: AUD, email: 'a@b.pt' });
		await expect(
			authenticate(request('https://app/api/me', withToken(token)), env()),
		).rejects.toMatchObject({ status: 401 });
	});

	it('rejeita token sem email ou com email inválido', async () => {
		const idp = await createTestIdp();
		await stubJwksFetch(idp);
		const semEmail = await idp.mint({ iss: TEAM, aud: AUD, sub: 'sub-1' });
		await expect(
			authenticate(request('https://app/api/me', withToken(semEmail)), env()),
		).rejects.toMatchObject({ status: 401 });

		const emailFalso = await idp.mint({
			iss: TEAM,
			aud: AUD,
			sub: 'sub-1',
			email: 'isto-nao-e-um-email',
		});
		await expect(
			authenticate(request('https://app/api/me', withToken(emailFalso)), env()),
		).rejects.toMatchObject({ status: 401 });
	});

	it('JWT válido produz a identidade esperada, com email normalizado', async () => {
		const idp = await createTestIdp();
		await stubJwksFetch(idp);
		const token = await idp.mint({
			iss: TEAM,
			aud: AUD,
			sub: 'sub-identidade-1',
			email: '  Utilizador@Exemplo.COM ',
			name: 'Utilizador Um',
		});
		const identity = await authenticate(
			request('https://app/api/me', withToken(token)),
			env(),
		);
		expect(identity).toEqual({
			subject: 'sub-identidade-1',
			email: 'utilizador@exemplo.com',
			name: 'Utilizador Um',
		});
	});

	it('obtém a JWK do endpoint correcto e reutiliza a cache', async () => {
		// Team domain próprio: a cache do JWKS é global por emissor.
		const cacheTeam = 'https://team-cache.example.com';
		const idp = await createTestIdp();
		const requested = await stubJwksFetch(idp);
		const token = await idp.mint({
			iss: cacheTeam,
			aud: AUD,
			sub: 'sub-1',
			email: 'a@b.pt',
		});

		await authenticate(
			request('https://app/api/me', withToken(token)),
			env({ TEAM_DOMAIN: cacheTeam }),
		);
		await authenticate(
			request('https://app/api/me', withToken(token)),
			env({ TEAM_DOMAIN: cacheTeam }),
		);

		expect(requested).toEqual([`${cacheTeam}/cdn-cgi/access/certs`]);
	});
});

describe('modo de desenvolvimento (DEV_AUTH)', () => {
	it('activa apenas com DEV_AUTH=true E host local', () => {
		const localRequest = request('http://localhost:5173/api/me');
		expect(devIdentity(localRequest, env({ DEV_AUTH: 'true' }))).toEqual({
			subject: 'dev:dev-user-a@example.test',
			email: 'dev-user-a@example.test',
			name: 'Utilizador A (dev)',
		});
		expect(devIdentity(localRequest, env({ DEV_AUTH: 'false' }))).toBeNull();
		expect(devIdentity(localRequest, env({ DEV_AUTH: undefined }))).toBeNull();

		// Activado mas com host não local: nunca se aplica.
		const remoteRequest = request('https://watchly.example.com/api/me');
		expect(devIdentity(remoteRequest, env({ DEV_AUTH: 'true' }))).toBeNull();
	});

	it('authenticate usa o JWT mesmo com DEV_AUTH activo quando o host não é local', async () => {
		const idp = await createTestIdp();
		await stubJwksFetch(idp);
		const token = await idp.mint({
			iss: TEAM,
			aud: AUD,
			sub: 'sub-1',
			email: 'jwt@exemplo.pt',
		});
		const identity = await authenticate(
			request('https://app.example.com/api/me', withToken(token)),
			env({ DEV_AUTH: 'true' }),
		);
		expect(identity.email).toBe('jwt@exemplo.pt');
	});

	it('authenticate com DEV_AUTH activo e host local dispensa JWT', async () => {
		const identity = await authenticate(
			request('http://localhost:5173/api/me'),
			env({ DEV_AUTH: 'true' }),
		);
		expect(identity.email).toBe('dev-user-a@example.test');
	});
});

describe('normalizeEmail', () => {
	it('remove espaços periféricos e uniformiza a caixa', () => {
		expect(normalizeEmail('  FspJorge@Gmail.COM ')).toBe('fspjorge@gmail.com');
	});
});

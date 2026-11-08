/**
 * Autenticação e gestão de utilizadores.
 *
 * A identidade é obtida EXCLUSIVAMENTE do JWT emitido e assinado pelo
 * Cloudflare Access (cabeçalho Cf-Access-Jwt-Assertion), verificado com
 * `jose` e Web Crypto (compatível com Workers).
 *
 * Em desenvolvimento local existe um modo de identidade explícito e
 * fail-closed (DEV_AUTH=true + hostname loopback); um valor enviado
 * pelo browser nunca activa este modo.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import type { Queryable } from './db.ts';

/** Identidade validada (claims do Access JWT). */
export type AuthenticatedUserIdentity = {
	subject: string;
	email: string;
	name?: string;
};

/** Utilizador interno da base de dados. */
export type UserRecord = {
	id: string;
	auth_subject: string;
	email: string;
	name: string | null;
	created_at: string;
	last_login_at: string | null;
};

export class AuthError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export type AuthEnv = {
	TEAM_DOMAIN: string;
	ACCESS_AUD: string;
	LEGACY_OWNER_EMAIL?: string;
	DEV_AUTH?: string;
	DEV_EMAIL?: string;
	DEV_NAME?: string;
};

const ACCESS_TOKEN_HEADER = 'Cf-Access-Jwt-Assertion';

/** Cache do conjunto de chaves públicas (JWKS) por emissor. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Reinicia a cache do JWKS (uso exclusivo em testes). */
export function clearJwksCacheForTests(): void {
	jwksCache.clear();
}

function jwksFor(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
	// createRemoteJWKSet obtém as chaves de <TEAM_DOMAIN>/cdn-cgi/access/certs
	// e mantém uma cache interna reutilizável entre pedidos.
	let jwks = jwksCache.get(teamDomain);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
		jwksCache.set(teamDomain, jwks);
	}
	return jwks;
}

/** Emissor aceito, normalizado (sem barra final). */
function issuerFor(teamDomain: string): string {
	return teamDomain.replace(/\/+$/, '');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Verifica um token Access e devolve a identidade.
 * Rejeita assinatura inválida, emissor/audiência diferentes, tokens expirados
 * ou ainda não válidos, e sub/email ausentes ou inválidos.
 */
export async function verifyAccessToken(
	token: string,
	env: AuthEnv,
	jwksOverride?: ReturnType<typeof createRemoteJWKSet>,
): Promise<AuthenticatedUserIdentity> {
	let payload: JWTPayload;
	try {
		const jwks = jwksOverride ?? jwksFor(issuerFor(env.TEAM_DOMAIN));
		({ payload } = await jwtVerify(token, jwks, {
			issuer: issuerFor(env.TEAM_DOMAIN),
			audience: env.ACCESS_AUD,
			algorithms: ['RS256'],
			// Cloudflare Access emite sempre exp/sub/email; exige-os explicitamente
			// para rejeitar tokens mal formados mesmo que a assinatura valha.
			requiredClaims: ['exp', 'sub', 'email'],
		}));
	} catch {
		throw new AuthError(401, 'Sessão inválida. Volta a autenticar-te.');
	}

	const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
	if (!subject) {
		throw new AuthError(401, 'Sessão inválida (identidade em falta).');
	}

	const emailRaw = typeof payload.email === 'string' ? payload.email : '';
	if (!emailRaw || !EMAIL_RE.test(emailRaw.trim())) {
		throw new AuthError(401, 'Sessão inválida (email em falta).');
	}

	const name =
		typeof payload.name === 'string' && payload.name.trim() !== ''
			? payload.name.trim()
			: undefined;

	return { subject, email: normalizeEmail(emailRaw), name };
}

/** Indica se o pedido provém de um host local (localhost, 127.0.0.1 ou [::1]). */
export function isLoopbackRequest(request: Request): boolean {
	const hostname = new URL(request.url).hostname;
	return (
		hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
	);
}

/**
 * Identidade de desenvolvimento: apenas quando activada explicitamente por
 * variável de ambiente E o pedido vem de um host local.
 */
export function devIdentity(request: Request, env: AuthEnv): AuthenticatedUserIdentity | null {
	if (!env.DEV_AUTH || env.DEV_AUTH.toLowerCase() !== 'true') return null;
	if (!isLoopbackRequest(request)) return null;
	if (!env.DEV_EMAIL || !EMAIL_RE.test(env.DEV_EMAIL)) return null;
	return {
		subject: `dev:${normalizeEmail(env.DEV_EMAIL)}`,
		email: normalizeEmail(env.DEV_EMAIL),
		name: env.DEV_NAME && env.DEV_NAME.trim() !== '' ? env.DEV_NAME.trim() : undefined,
	};
}

/**
 * Bloqueia pedidos quando a configuração de identidade ainda tem valores
 * de substituição: falha com 500 claro (em vez de 401 silencioso) para
 * tornar o diagnóstico imediato numa publicação mal configurada.
 * Só se aplica fora do modo de desenvolvimento (o chamador avalia o dev
 * mode primeiro, portanto o dev local com placeholders continua a funcionar).
 */
export function assertAccessConfigured(env: AuthEnv): void {
	const teamDomain = (env.TEAM_DOMAIN ?? '').trim();
	const accessAud = (env.ACCESS_AUD ?? '').trim();
	if (
		!teamDomain ||
		!teamDomain.startsWith('https://') ||
		teamDomain.includes('SUBSTITUIR-ME')
	) {
		throw new AuthError(
			500,
			'Configuração do servidor incompleta: define o TEAM_DOMAIN real (https://...) antes de publicar a aplicação.',
		);
	}
	if (!accessAud || accessAud === 'SUBSTITUIR-ME') {
		throw new AuthError(
			500,
			'Configuração do servidor incompleta: define o ACCESS_AUD real antes de publicar a aplicação.',
		);
	}
}

/**
 * Middleware de autenticação de um pedido.
 * O modo de desenvolvimento (explícito, host loopback) tem precedência sobre
 * o JWT; caso contrário, exige um JWT Access válido.
 */
export async function authenticate(
	request: Request,
	env: AuthEnv,
	jwksOverride?: ReturnType<typeof createRemoteJWKSet>,
): Promise<AuthenticatedUserIdentity> {
	const dev = devIdentity(request, env);
	if (dev) return dev;

	assertAccessConfigured(env);

	const token = request.headers.get(ACCESS_TOKEN_HEADER);
	if (!token) {
		throw new AuthError(401, 'Sessão não iniciada. Autentica-te para continuar.');
	}
	return verifyAccessToken(token, env, jwksOverride);
}

/* ------------------------------------------------------------------ */
/* Utilizadores e associação dos dados antigos                         */
/* ------------------------------------------------------------------ */

/**
 * Localiza o utilizador pelo auth_subject ou cria o perfil no primeiro acesso.
 * Actualiza, a cada login, o email/nome (mantendo a identidade por auth_subject)
 * e o last_login_at. Nunca funde contas diferentes com o mesmo email.
 */
export async function getOrCreateUser(db: Queryable, identity: AuthenticatedUserIdentity): Promise<UserRecord> {
	await db.run(
		`INSERT INTO users (id, auth_subject, email, name, last_login_at)
		 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(auth_subject) DO UPDATE SET
		   email = excluded.email,
		   name = COALESCE(excluded.name, users.name),
		   last_login_at = CURRENT_TIMESTAMP`,
		[crypto.randomUUID(), identity.subject, identity.email, identity.name ?? null],
	);

	const user = await db.one<UserRecord>(
		'SELECT id, auth_subject, email, name, created_at, last_login_at FROM users WHERE auth_subject = ?',
		[identity.subject],
	);
	if (!user) {
		throw new AuthError(500, 'Não foi possível criar o perfil do utilizador.');
	}
	return user;
}

/**
 * Associa os registos antigos (monitors.user_id IS NULL) ao proprietário
 * inicial, apenas quando a identidade validada tem o email LEGACY_OWNER_EMAIL.
 * Idempotente: em logins repetidos não há registos sem proprietário a mover.
 */
export async function associateLegacyData(
	db: Queryable,
	user: UserRecord,
	legacyOwnerEmail: string | undefined,
): Promise<void> {
	if (!legacyOwnerEmail) return;
	if (normalizeEmail(legacyOwnerEmail) !== user.email) return;
	await db.run('UPDATE monitors SET user_id = ? WHERE user_id IS NULL', [user.id]);
}

/**
 * Autentica um pedido e devolve o utilizador interno correspondente,
 * executando (segura e idempotentemente) a associação dos dados antigos.
 */
export async function authenticateUser(
	request: Request,
	env: AuthEnv,
	db: Queryable,
	jwksOverride?: ReturnType<typeof createRemoteJWKSet>,
): Promise<UserRecord> {
	const identity = await authenticate(request, env, jwksOverride);
	const user = await getOrCreateUser(db, identity);
	await associateLegacyData(db, user, env.LEGACY_OWNER_EMAIL);
	return user;
}

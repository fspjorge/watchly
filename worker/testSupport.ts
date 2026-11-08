/**
 * Utilitários de teste: adaptador SQLite (node:sqlite in-memory) que
 * implementa a mesma interface Queryable usada com D1, e infra-estrutura
 * para emitir JWTs RS256 como o Cloudflare Access o faria.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exportJWK, SignJWT } from 'jose';
import { vi } from 'vitest';

import type { BatchOperation, Queryable } from './db.ts';

/* ------------------------------------------------------------------ */
/* SQLite in-memory com a interface Queryable                          */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

export class SqliteQueryable implements Queryable {
	private readonly db: DatabaseSync;

	private constructor(db: DatabaseSync) {
		this.db = db;
	}

	static open(): SqliteQueryable {
		const db = new DatabaseSync(':memory:');
		// As restrições de chave externa têm de estar activas para reproduzir
		// o comportamento do D1 (em particular ON DELETE CASCADE).
		db.exec('PRAGMA foreign_keys = ON');
		return new SqliteQueryable(db);
	}

	run(sql: string, params: unknown[] = []): Promise<void> {
		this.db.prepare(sql).run(...(params as never[]));
		return Promise.resolve();
	}

	one<T extends Row>(sql: string, params: unknown[] = []): Promise<T | null> {
		const row = this.db.prepare(sql).get(...(params as never[])) as T | undefined;
		return Promise.resolve(row ?? null);
	}

	all<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
		const rows = this.db.prepare(sql).all(...(params as never[])) as T[];
		return Promise.resolve(rows);
	}

	batch(operations: BatchOperation[]): Promise<number[]> {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const changes = operations.map(({ sql, params = [] }) =>
				Number(this.db.prepare(sql).run(...(params as never[])).changes),
			);
			this.db.exec('COMMIT');
			return Promise.resolve(changes);
		} catch (error) {
			this.db.exec('ROLLBACK');
			return Promise.reject(error);
		}
	}

	/** Executa SQL cru (migrações multi-instrução). */
	exec(sql: string): void {
		this.db.exec(sql);
	}

	count(query: string, params: unknown[] = []): number {
		const row = this.db.prepare(query).get(...(params as never[])) as { total: number };
		return Number(row.total);
	}
}

/** Aplica um ficheiro de migração (migrations/*.sql) à base de dados de teste. */
export function applyMigrationFile(db: SqliteQueryable, fileName: string): void {
	const sql = readFileSync(resolve(process.cwd(), 'migrations', fileName), 'utf8');
	db.exec(sql);
}

/* ------------------------------------------------------------------ */
/* Emissor de JWTs de teste (como o Cloudflare Access)                 */
/* ------------------------------------------------------------------ */

export type TestTokenClaims = {
	iss: string;
	aud: string;
	sub?: string;
	email?: string;
	name?: string;
	expired?: boolean;
	notYetValid?: boolean;
};

export type TestIdp = {
	jwks: { keys: unknown[] };
	privateKey: CryptoKey;
	requests: string[];
	mint: (claims: TestTokenClaims) => Promise<string>;
};

const RS256_ARGS: RsaHashedKeyGenParams = {
	name: 'RSASSA-PKCS1-v1_5',
	modulusLength: 2048,
	publicExponent: new Uint8Array([1, 0, 1]),
	hash: 'SHA-256',
};

export async function createTestIdp(): Promise<TestIdp> {
	const keyPair = (await crypto.subtle.generateKey(RS256_ARGS, true, [
		'sign',
		'verify',
	])) as CryptoKeyPair;
	const jwk = (await exportJWK(keyPair.publicKey)) as Record<string, unknown>;
	jwk.kid = 'test-key';
	jwk.alg = 'RS256';

	return {
		jwks: { keys: [jwk] },
		privateKey: keyPair.privateKey,
		requests: [],
		async mint(claims) {
			const jwt = new SignJWT({
				email: claims.email,
				name: claims.name,
			});
			jwt.setProtectedHeader({ alg: 'RS256', kid: 'test-key' });
			if (claims.sub !== undefined) jwt.setSubject(claims.sub);
			jwt.setIssuer(claims.iss);
			jwt.setAudience(claims.aud);
			jwt.setIssuedAt(Math.floor(Date.now() / 1000) - 10);
			if (claims.expired) {
				jwt.setExpirationTime(Math.floor(Date.now() / 1000) - 60);
			} else {
				jwt.setExpirationTime(Math.floor(Date.now() / 1000) + 3600);
			}
			if (claims.notYetValid) {
				jwt.setNotBefore(Math.floor(Date.now() / 1000) + 3600);
			}
			return jwt.sign(this.privateKey);
		},
	};
}

/**
 * Instala um fetch simulado:
 *  - responde o JWKS em <qualquer-host>/cdn-cgi/access/certs;
 *  - responde HTML configurável em quaisquer outros URLs.
 * Devolve a lista de URLs pedidos (em ordem).
 */
export function stubWorkerFetch(
	idp: TestIdp,
	htmlOrFactory: string | ((url: string) => string),
): string[] {
	const requested: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((input: unknown) => {
			const url =
				typeof input === 'string'
					? input
					: input instanceof Request
						? input.url
						: String(input);
			requested.push(url);
			if (url.endsWith('/cdn-cgi/access/certs')) {
				return Promise.resolve(
					new Response(JSON.stringify(idp.jwks), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
				);
			}
			const html =
				typeof htmlOrFactory === 'function' ? htmlOrFactory(url) : htmlOrFactory;
			return Promise.resolve(
				new Response(html, {
					status: 200,
					headers: { 'content-type': 'text/html' },
				}),
			);
		}),
	);
	return requested;
}

export function stopStubbedFetch(): void {
	vi.unstubAllGlobals();
}

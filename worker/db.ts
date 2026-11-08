/**
 * Interface mínima de acesso a dados, implementada sobre D1 em produção
 * e sobre node:sqlite nos testes (in-memory). Todas as funções de negócio
 * dependem apenas desta interface.
 */

export type QueryRow = Record<string, unknown>;

export interface Queryable {
	/** Executa uma instrução de escrita. */
	run(sql: string, params?: unknown[]): Promise<void>;
	/** Devolve a primeira linha, ou null. */
	one<T extends QueryRow>(sql: string, params?: unknown[]): Promise<T | null>;
	/** Devolve todas as linhas. */
	all<T extends QueryRow>(sql: string, params?: unknown[]): Promise<T[]>;
}

export class D1Queryable implements Queryable {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	run(sql: string, params: unknown[] = []): Promise<void> {
		return this.db
			.prepare(sql)
			.bind(...params)
			.run()
			.then(() => undefined);
	}

	one<T extends QueryRow>(sql: string, params: unknown[] = []): Promise<T | null> {
		return this.db
			.prepare(sql)
			.bind(...params)
			.first<T>();
	}

	async all<T extends QueryRow>(sql: string, params: unknown[] = []): Promise<T[]> {
		const { results } = await this.db
			.prepare(sql)
			.bind(...params)
			.all<T>();
		return results;
	}
}

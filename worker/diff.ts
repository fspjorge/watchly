/**
 * Comparação textual por linhas usando LCS (subsequência comum mais longa).
 */

export type DiffChunkType = 'unchanged' | 'removed' | 'added';

export type DiffChunk = {
	type: DiffChunkType;
	lines: string[];
};

type Op = { type: DiffChunkType; line: string };

/** Número máximo de células da matriz LCS antes de recorrer a "substituição total". */
const MAX_LCS_CELLS = 1_000_000;

/**
 * Compara duas sequências de linhas e devolve segmentos na ordem do documento:
 * 'unchanged' (em ambas), 'removed' (apenas na versão anterior) e
 * 'added' (apenas na versão nova). Segmentos consecutivos do mesmo tipo
 * são agrupados num só chunk.
 */
export function diffLines(before: string[], after: string[]): DiffChunk[] {
	const chunks: DiffChunk[] = [];
	const push = (type: DiffChunkType, line: string) => {
		const last = chunks[chunks.length - 1];
		if (last && last.type === type) {
			last.lines.push(line);
		} else {
			chunks.push({ type, lines: [line] });
		}
	};

	// Corta o prefixo e sufixo comuns: reduz muito o custo do LCS
	// e reflecte o padrão mais frequente em alterações de páginas.
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) {
		start++;
	}
	let endB = before.length;
	let endA = after.length;
	while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
		endB--;
		endA--;
	}

	for (let i = 0; i < start; i++) {
		push('unchanged', before[i]);
	}

	const midB = before.slice(start, endB);
	const midA = after.slice(start, endA);

	// Protecção contra explosão quadrática em páginas muito grandes:
	// quando a matriz LCS seria demasiado grande, trata como substituição total.
	if (midB.length * midA.length > MAX_LCS_CELLS) {
		if (midB.length > 0) {
			chunks.push({ type: 'removed', lines: midB });
		}
		if (midA.length > 0) {
			chunks.push({ type: 'added', lines: midA });
		}
	} else {
		for (const op of lcsOps(midB, midA)) {
			push(op.type, op.line);
		}
	}

	const suffixLength = before.length - endB;
	for (let i = 0; i < suffixLength; i++) {
		push('unchanged', before[endB + i]);
	}

	return chunks;
}

function lcsOps(before: string[], after: string[]): Op[] {
	if (before.length === 0 && after.length === 0) {
		return [];
	}

	const n = before.length;
	const m = after.length;

	// lcs[i][j] = comprimento do LCS de before[i..] e after[j..]
	const lcs: Uint32Array[] = Array.from(
		{ length: n + 1 },
		() => new Uint32Array(m + 1),
	);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] =
				before[i] === after[j]
					? lcs[i + 1][j + 1] + 1
					: Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (before[i] === after[j]) {
			ops.push({ type: 'unchanged', line: before[i] });
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			ops.push({ type: 'removed', line: before[i] });
			i++;
		} else {
			ops.push({ type: 'added', line: after[j] });
			j++;
		}
	}
	while (i < n) {
		ops.push({ type: 'removed', line: before[i] });
		i++;
	}
	while (j < m) {
		ops.push({ type: 'added', line: after[j] });
		j++;
	}
	return ops;
}

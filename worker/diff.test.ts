import { describe, expect, it } from 'vitest';

import { diffLines, diffMatchesKeywords, filterDiffByKeywords } from './diff.ts';

const ofType = (chunks: ReturnType<typeof diffLines>, type: string) =>
	chunks.filter((chunk) => chunk.type === type).flatMap((chunk) => chunk.lines);

describe('diffLines', () => {
	it('devolve um único chunk "unchanged" quando não há diferenças', () => {
		const lines = ['a', 'b', 'c'];
		const chunks = diffLines(lines, lines);
		expect(chunks).toEqual([{ type: 'unchanged', lines: ['a', 'b', 'c'] }]);
	});

	it('marca como "added" as linhas só presentes na versão nova, intercaladas', () => {
		const chunks = diffLines(['a', 'c'], ['a', 'b', 'c']);
		expect(ofType(chunks, 'unchanged')).toEqual(['a', 'c']);
		expect(ofType(chunks, 'added')).toEqual(['b']);
		expect(ofType(chunks, 'removed')).toEqual([]);
	});

	it('marca como "removed" as linhas só presentes na versão anterior, intercaladas', () => {
		const chunks = diffLines(['a', 'b', 'c'], ['a', 'c']);
		expect(ofType(chunks, 'unchanged')).toEqual(['a', 'c']);
		expect(ofType(chunks, 'removed')).toEqual(['b']);
		expect(ofType(chunks, 'added')).toEqual([]);
	});

	it('mantém a ordem do documento nos chunks', () => {
		const chunks = diffLines(
			['manteve', 'velho-um', 'manteve-dois', 'velho-dois', 'manteve-três'],
			['manteve', 'novo-um', 'manteve-dois', 'novo-dois', 'manteve-três'],
		);

		expect(chunks).toEqual([
			{ type: 'unchanged', lines: ['manteve'] },
			{ type: 'removed', lines: ['velho-um'] },
			{ type: 'added', lines: ['novo-um'] },
			{ type: 'unchanged', lines: ['manteve-dois'] },
			{ type: 'removed', lines: ['velho-dois'] },
			{ type: 'added', lines: ['novo-dois'] },
			{ type: 'unchanged', lines: ['manteve-três'] },
		]);
	});

	it('permite reconstruir as duas versões a partir do diff', () => {
		const before = ['um', 'dois', 'três', 'quatro'];
		const after = ['um', 'dois-dois', 'dois', 'cinco'];
		const chunks = diffLines(before, after);

		const rebuiltBefore: string[] = [];
		const rebuiltAfter: string[] = [];
		for (const chunk of chunks) {
			if (chunk.type === 'unchanged' || chunk.type === 'removed') {
				rebuiltBefore.push(...chunk.lines);
			}
			if (chunk.type === 'unchanged' || chunk.type === 'added') {
				rebuiltAfter.push(...chunk.lines);
			}
		}
		expect(rebuiltBefore).toEqual(before);
		expect(rebuiltAfter).toEqual(after);
	});

	it('à afectação só numa linha: as restantes ficam sem destaque', () => {
		const chunks = diffLines(
			['intro', 'Preço: 10 euros', 'fim'],
			['intro', 'Preço: 12 euros', 'fim'],
		);
		expect(chunks).toEqual([
			{ type: 'unchanged', lines: ['intro'] },
			{ type: 'removed', lines: ['Preço: 10 euros'] },
			{ type: 'added', lines: ['Preço: 12 euros'] },
			{ type: 'unchanged', lines: ['fim'] },
		]);
	});

	it('trata versão anterior vazia como tudo adicionado', () => {
		const chunks = diffLines([], ['a', 'b']);
		expect(chunks).toEqual([{ type: 'added', lines: ['a', 'b'] }]);
	});

	it('agrupa linhas removidas e adicionadas consecutivas num chunk só', () => {
		const chunks = diffLines(['x', 'y', 'z'], ['1', '2', '3', '4']);
		expect(chunks).toEqual([
			{ type: 'removed', lines: ['x', 'y', 'z'] },
			{ type: 'added', lines: ['1', '2', '3', '4'] },
		]);
	});

	it('usa o prefixo e sufixo comuns como âncoras do diff', () => {
		const chunks = diffLines(['comum', 'trabalho', 'fim'], ['comum', 'esforço', 'fim']);
		expect(chunks[0]).toEqual({ type: 'unchanged', lines: ['comum'] });
		expect(chunks[chunks.length - 1]).toEqual({ type: 'unchanged', lines: ['fim'] });
	});

	it('trata as duas versões vazias como nenhuma diferença', () => {
		expect(diffLines([], [])).toEqual([]);
	});

	it('matches keyword in removed or added text without case sensitivity', () => {
		const chunks = diffLines(['Preço: 10 euros'], ['Preço: 12 euros']);
		expect(diffMatchesKeywords(chunks, ['preço'])).toBe(true);
		expect(diffMatchesKeywords(chunks, ['12 EUROS'])).toBe(true);
		expect(diffMatchesKeywords(chunks, ['stock'])).toBe(false);
	});

	it('does not treat an unchanged adjacent keyword as a match', () => {
		const chunks = diffLines(['Preço', '10 euros'], ['Preço', '12 euros']);
		expect(diffMatchesKeywords(chunks, ['preço'])).toBe(false);
	});

	it('filters displayed changes to lines that contain a keyword', () => {
		const chunks = diffLines(
			['Produto', 'Preço: 10 euros', 'Detalhes', 'Stock disponível', 'Condições', 'Rodapé antigo'],
			['Produto', 'Preço: 12 euros', 'Detalhes', 'Stock indisponível', 'Condições', 'Rodapé novo'],
		);
		const filtered = filterDiffByKeywords(chunks, ['preço']);
		expect(filtered).toEqual([
			{ type: 'removed', lines: ['Preço: 10 euros'] },
			{ type: 'added', lines: ['Preço: 12 euros'] },
		]);
	});

	it('preserves all changes when no keywords are configured', () => {
		const chunks = diffLines(['old'], ['new']);
		expect(filterDiffByKeywords(chunks, [])).toEqual(chunks);
		expect(diffMatchesKeywords(chunks, [])).toBe(true);
	});
});

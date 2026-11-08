import { describe, expect, it } from 'vitest';

import { extractTextFromHtml, normalizeText } from './extract.ts';

describe('normalizeText', () => {
	it('normaliza sequências de espaços numa única linha', () => {
		expect(normalizeText('BEM\t VINDO  ao   Watchly')).toBe('BEM VINDO ao Watchly');
	});

	it('remove espaços não separáveis no início e fim das linhas', () => {
		expect(normalizeText('\u00a0 Olá mundo \u00a0')).toBe('Olá mundo');
	});

	it('normaliza quebras de linha CR/LF para LF', () => {
		expect(normalizeText('primeira\r\nsegunda\rterceira')).toBe(
			'primeira\nsegunda\nterceira',
		);
	});

	it('remove linhas vazias (resultado de quebras adicionais)', () => {
		expect(normalizeText('a\n\n\nb\n\n   \nc')).toBe('a\nb\nc');
	});

	it('remove espaços no fim de cada linha', () => {
		expect(normalizeText('a   \nb\t \n c d ')).toBe('a\nb\nc d');
	});
});

describe('extractTextFromHtml', () => {
	it('remove o conteúdo de <script>, <style>, <noscript> e <svg>', () => {
		const html = `
			<html>
				<head>
					<title>Página de teste</title>
					<style>body { color: red; }</style>
					<script>alert('cursores'); </script>
				</head>
				<body>
					<noscript>Activa o JavaScript</noscript>
					<svg><text>ícone</text></svg>
					<h1>Bem-vindo</h1>
				</body>
			</html>
		`;
		const text = extractTextFromHtml(html);
		expect(text).not.toContain('color: red');
		expect(text).not.toContain('alert');
		expect(text).not.toContain('Activa o JavaScript');
		expect(text).not.toContain('ícone');
		expect(text).toContain('Bem-vindo');
	});

	it('transforma elementos de bloco em quebras de linha', () => {
		const text = extractTextFromHtml(
			'<div>Primeiro</div><p>Segundo</p><p>Terceiro</p>',
		);
		expect(text).toBe('Primeiro\nSegundo\nTerceiro');
	});

	it('trata <br> como quebra de linha', () => {
		const text = extractTextFromHtml('<p>linha um<br>linha dois</p>');
		expect(text).toBe('linha um\nlinha dois');
	});

	it('decodifica entidades de caracteres', () => {
		const text = extractTextFromHtml('<p>Preço &amp; custo &lt;MAX&gt;&#163;9&nbsp;99</p>');
		expect(text).toBe('Preço & custo <MAX>£9 99');
	});

	it('remove comentários HTML', () => {
		const text = extractTextFromHtml('<p>Visível</p><!-- invisível -->');
		expect(text).toContain('Visível');
		expect(text).not.toContain('invisível');
	});

	it('ignora elementos ignorados mesmo com tags mal formadas ou aninhadas', () => {
		const html = '<svg><script>alert()</script></svg><p>dentro</p>';
		const text = extractTextFromHtml(html);
		expect(text).not.toContain('alert');
		expect(text).toContain('dentro');
	});

	it('extrai texto igual a partir de HTML com formatações diferentes', () => {
		// A mesma página com espaços/atributos diferentes deve produzir o mesmo texto.
		const html1 = '<body><h1>Notícias</h1>   <p>Hoje   chove</p></body>';
		const html2 = '<body><h1>\n Notícias \n</h1><p>Hoje chove\n</p></body>';
		expect(extractTextFromHtml(html1)).toBe(extractTextFromHtml(html2));
	});

	it('remove conteúdo de <template> e <iframe>', () => {
		const html = '<p>Antes</p><template>interna</template><iframe src="x"></iframe><p>Depois</p>';
		const text = extractTextFromHtml(html);
		expect(text).toBe('Antes\nDepois');
	});

	it('processa documentos pequenos, médios e densos sem perder o texto visível', () => {
		for (const size of [1024, 16 * 1024, 60 * 1024]) {
			const html = `<main><h1>Início</h1><p>${'a'.repeat(size)}</p><p>Fim</p></main>`;
			const text = extractTextFromHtml(html);
			expect(text.startsWith('Início\n')).toBe(true);
			expect(text.endsWith('\nFim')).toBe(true);
			expect(text).toContain('a'.repeat(size));
		}
	});

	it('ignora páginas com muitos elementos e payloads grandes em elementos não visíveis', () => {
		const dense = '<span>visível</span>'.repeat(2500);
		const hidden = `<script>${'<node attr="value">payload</node>'.repeat(1000)}</script>`;
		const text = extractTextFromHtml(`<body>${hidden}${dense}<p>fim</p></body>`);
		expect(text).not.toContain('payload');
		expect(text.match(/visível/g)).toHaveLength(2500);
		expect(text.endsWith('\nfim')).toBe(true);
	});
});

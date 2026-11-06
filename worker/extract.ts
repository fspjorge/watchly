/**
 * Extracção de texto relevante a partir de HTML e normalização.
 *
 * Sem parser completo: usa transformações sobre o HTML bruto, suficientes
 * para obter o texto visível da página de forma estável.
 */

/** Elementos cujo conteúdo deve ser ignorado por completo. */
const IGNORED_ELEMENTS = [
	'script',
	'style',
	'noscript',
	'svg',
	'template',
	'iframe',
];

/** Comentários HTML. */
const COMMENT_RE = /<!--[\s\S]*?-->/g;

const WHITESPACE_TAG =
	'<br\\s*/?>|</?(?:p|div|section|article|main|header|footer|aside|nav|h[1-6]|li|ul|ol|tr|table|blockquote|pre|figcaption|details|summary|figure)\\b[^>]*>';

/** Constrói uma expressão regular que remove o elemento e todo o seu conteúdo. */
function elementContentRe(tag: string): RegExp {
	return new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi');
}

/** Constrói uma expressão regular para elementos "void" (sem conteúdo). */
function voidElementRe(tag: string): RegExp {
	return new RegExp(`<${tag}\\b[^>]*>`, 'gi');
}

function decodeEntities(text: string): string {
	const named: Record<string, string> = {
		'&amp;': '&',
		'&lt;': '<',
		'&gt;': '>',
		'&quot;': '"',
		'&apos;': "'",
		'&#39;': "'",
		'&nbsp;': ' ',
		'&ndash;': '–',
		'&mdash;': '—',
		'&hellip;': '…',
	};

	let out = text;
	for (const [entity, value] of Object.entries(named)) {
		out = out.split(entity).join(value);
	}

	return out.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
		String.fromCodePoint(Number.parseInt(hex, 16)),
	).replace(/&#(\d+);/g, (_, dec: string) =>
		String.fromCodePoint(Number.parseInt(dec, 10)),
	);
}

/**
 * Extrai o texto visível de um documento HTML.
 * As quebras de bloco (p, div, h1-h6, li, br, ...) tornam-se novas linhas.
 */
export function extractTextFromHtml(html: string): string {
	let result = html;

	result = result.replace(COMMENT_RE, ' ');

	for (const tag of IGNORED_ELEMENTS) {
		result = result.replace(elementContentRe(tag), ' ');
		result = result.replace(voidElementRe(tag), ' ');
	}

	// Transforma tags de bloco em quebras de linha e remove as restantes.
	result = result.replace(new RegExp(WHITESPACE_TAG, 'gi'), '\n');
	result = result.replace(/<[^>]*>/g, ' ');

	result = decodeEntities(result);

	return normalizeText(result);
}

/**
 * Normaliza texto recolhido para que pequenas alterações de formatação
 * não gerem diferenças falsas:
 * - normaliza espaços (incluindo espaços não separáveis) para um só espaço;
 * - remove espaços no início/fim de cada linha;
 * - remove linhas vazias.
 */
export function normalizeText(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/\u00a0/g, ' ')
		.split('\n')
		.map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim())
		.filter((line) => line.length > 0)
		.join('\n');
}

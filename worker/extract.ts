/**
 * Extracção de texto relevante de HTML com um scanner de uma passagem.
 * Não é um parser HTML completo; mantém o comportamento deliberadamente
 * simples usado para comparar páginas e evita percorrer o documento por
 * cada tag ignorada.
 */

const IGNORED_ELEMENTS = new Set([
	'script',
	'style',
	'noscript',
	'svg',
	'template',
	'iframe',
]);

const BLOCK_ELEMENTS = new Set([
	'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav',
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'tr', 'table',
	'blockquote', 'pre', 'figcaption', 'details', 'summary', 'figure', 'br',
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
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

const ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#39|nbsp|ndash|mdash|hellip|#x[0-9a-f]+|#\d+);/gi;

function decodeEntities(text: string): string {
	return text.replace(ENTITY_RE, (entity) => {
		const named = NAMED_ENTITIES[entity.toLowerCase()];
		if (named !== undefined) return named;

		const hex = /^&#x([0-9a-f]+);$/i.exec(entity);
		const decimal = /^&#(\d+);$/.exec(entity);
		const codePoint = hex ? Number.parseInt(hex[1], 16) :
			decimal ? Number.parseInt(decimal[1], 10) : null;
		if (codePoint === null || codePoint < 0 || codePoint > 0x10ffff) return entity;
		try {
			return String.fromCodePoint(codePoint);
		} catch {
			return entity;
		}
	});
}

function isTagNameChar(code: number): boolean {
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		code === 45 || code === 58
	);
}

/** Procura `>` sem tratar um `>` dentro de atributo citado como fim da tag. */
function findTagEnd(html: string, from: number): number {
	let quote = 0;
	for (let i = from; i < html.length; i++) {
		const code = html.charCodeAt(i);
		if (quote !== 0) {
			if (code === quote) quote = 0;
		} else if (code === 34 || code === 39) {
			quote = code;
		} else if (code === 62) {
			return i;
		}
	}
	return -1;
}

/** Extrai texto visível percorrendo o HTML uma única vez. */
export function extractTextFromHtml(html: string): string {
	return normalizeText(extractRawTextFromHtml(html));
}

/** Scanner + entidades, sem normalização de espaços/linhas. */
export function extractRawTextFromHtml(html: string): string {
	const output: string[] = [];
	let index = 0;
	let textStart = 0;
	let ignoredTag: string | null = null;
	let ignoredDepth = 0;

	while (index < html.length) {
		if (html.charCodeAt(index) !== 60) {
			index++;
			continue;
		}

		if (ignoredTag === null) output.push(html.slice(textStart, index));

		if (html.startsWith('<!--', index)) {
			const commentEnd = html.indexOf('-->', index + 4);
			index = commentEnd === -1 ? html.length : commentEnd + 3;
			if (ignoredTag === null) output.push(' ');
			textStart = index;
			continue;
		}

		let nameStart = index + 1;
		let closing = false;
		if (html.charCodeAt(nameStart) === 47) {
			closing = true;
			nameStart++;
		}
		if (!isTagNameChar(html.charCodeAt(nameStart)) ||
			(html.charCodeAt(nameStart) >= 48 && html.charCodeAt(nameStart) <= 57)) {
			// Um `<` que não inicia uma tag é texto; não descartar texto legítimo.
			index++;
			textStart = index - 1;
			continue;
		}

		let nameEnd = nameStart + 1;
		while (nameEnd < html.length && isTagNameChar(html.charCodeAt(nameEnd))) nameEnd++;
		const tagName = html.slice(nameStart, nameEnd).toLowerCase();
		const tagEnd = findTagEnd(html, nameEnd);
		if (tagEnd === -1) {
			if (ignoredTag === null) output.push(html.slice(index));
			index = html.length;
			textStart = index;
			break;
		}
		let beforeEnd = tagEnd - 1;
		while (beforeEnd >= nameEnd && /\s/.test(html[beforeEnd])) beforeEnd--;
		const selfClosing = html[beforeEnd] === '/';

		if (ignoredTag !== null) {
			if (tagName === ignoredTag) {
				if (closing) ignoredDepth--;
				else if (!selfClosing) ignoredDepth++;
				if (ignoredDepth === 0) ignoredTag = null;
			}
		} else if (IGNORED_ELEMENTS.has(tagName)) {
			if (!closing && !selfClosing) {
				ignoredTag = tagName;
				ignoredDepth = 1;
			}
			output.push(' ');
		} else {
			output.push(BLOCK_ELEMENTS.has(tagName) ? '\n' : ' ');
		}

		index = tagEnd + 1;
		textStart = index;
	}

	if (ignoredTag === null && textStart < html.length) output.push(html.slice(textStart));
	return decodeEntities(output.join(''));
}

/**
 * Normaliza espaços para que alterações de formatação não gerem diferenças.
 */
export function normalizeText(text: string): string {
	const lines: string[] = [];
	let line: string[] = [];
	let pendingSpace = false;

	const finishLine = () => {
		if (line.length > 0) lines.push(line.join(''));
		line = [];
		pendingSpace = false;
	};

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === '\r' || char === '\n') {
			if (char === '\r' && text[i + 1] === '\n') i++;
			finishLine();
		} else if (char === ' ' || char === '\t' || char === '\f' || char === '\v' || char === '\u00a0') {
			if (line.length > 0) pendingSpace = true;
		} else {
			if (pendingSpace) line.push(' ');
			line.push(char);
			pendingSpace = false;
		}
	}
	finishLine();
	return lines.join('\n');
}

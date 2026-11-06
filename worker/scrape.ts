/**
 * Recolha (scraping) do conteúdo de uma página.
 *
 * - valida o URL (apenas HTTP/HTTPS, sem anfitriões locais/privados);
 * - valida destinos dos redirects manualmente (anti-SSRF);
 * - impõe timeout ao pedido;
 * - impõe limite de tamanho ao corpo.
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

export class ScrapeError extends Error {
	constructor(message: string) {
		super(message);
	}
}

const BLOCKED_IP_RANGES: Array<[number, number]> = [
	[0x00000000, 0x00ffffff], // 0.0.0.0/8
	[0x0a000000, 0x0affffff], // 10.0.0.0/8
	[0x64400000, 0x647fffff], // 100.64.0.0/10 (CGNAT)
	[0x7f000000, 0x7fffffff], // 127.0.0.0/8
	[0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 (inclui metadados)
	[0xac100000, 0xac1fffff], // 172.16.0.0/12
	[0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
	[0xc6120000, 0xc613ffff], // 198.18.0.0/15 (benchmarking)
];

const IPV4_HOST_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const BLOCKED_HOSTNAMES = new Set(['localhost']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/**
 * Valida um URL de monitorização: apenas HTTP/HTTPS, com anfitrião público.
 * Devolve o URL normalizado ou lança erro com mensagem em PT-PT.
 */
export function validateMonitorUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new ScrapeError('URL inválido.');
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new ScrapeError('Apenas são aceites URLs HTTP ou HTTPS.');
	}

	if (url.username || url.password) {
		throw new ScrapeError('URLs com credenciais embutidas não são aceites.');
	}

	const hostname = url.hostname.toLowerCase().replace(/\.$/, '');

	if (hostname.length === 0 || BLOCKED_HOSTNAMES.has(hostname)) {
		throw new ScrapeError('O endereço não pode apontar para o próprio servidor.');
	}

	if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
		throw new ScrapeError('O endereço não pode apontar para rede local ou interna.');
	}

	if (IPV4_HOST_RE.test(hostname) && isPrivateIPv4(hostname)) {
		throw new ScrapeError('O endereço não pode apontar para rede local ou interna.');
	}

	const port = url.port;
	if (port !== '' && port !== '80' && port !== '443') {
		throw sameRender();
	}

	return url.toString();
}

function sameRender(): Error {
	return new ScrapeError('Apenas são aceites as portas 80 e 443.');
}

function isPrivateIPv4(host: string): boolean {
	const parts = host.split('.').map(Number);
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n > 255)) {
		return true;
	}
	const value =
		((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
	return BLOCKED_IP_RANGES.some(
		([start, end]) => value >= start && value <= end,
	);
}

/** Verifica se um destino intermédio (redirect) pode ser seguido. */
function assertSafeDestination(text: string): string {
	let destination: URL;
	try {
		destination = new URL(text);
	} catch {
		throw new ScrapeError('Redirecionamento inválido.');
	}
	if (destination.protocol !== 'http:' && destination.protocol !== 'https:') {
		throw new ScrapeError('Redirecionamento para protocolo não suportado.');
	}
	return destination.toString();
}

export type FetchedPage = {
	finalUrl: string;
	status: number;
	contentType: string;
	text: string;
};

/**
 * Recolhe a página: segue redirects manualmente (validando cada destino),
 * impõe timeout e limita o tamanho do corpo.
 */
export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
	let current = rawUrl;
	let response: Response | undefined;

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const signalTimeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
		const attempt = await fetch(current, {
			redirect: 'manual',
			signal: signalTimeout,
			headers: {
				'user-agent': 'Watchly/0.1 (+monitorização de páginas)',
				accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
			},
		});

		if ([301, 302, 303, 307, 308].includes(attempt.status)) {
			const location = attempt.headers.get('location');
			if (!location) {
				throw new ScrapeError('Redirecionamento sem destino (Location).');
			}
			current = assertSafeDestination(new URL(location, current).toString());
			continue;
		}

		response = attempt;
		break;
	}

	if (!response) {
		throw new ScrapeError(`Demasiados redirecionamentos (limite: ${MAX_REDIRECTS}).`);
	}

	if (!response.ok) {
		throw new ScrapeError(`A página devolveu o estado HTTP ${response.status}.`);
	}

	const contentType = response.headers.get('content-type') ?? '';
	const mediaType = contentType.split(';')[0].trim().toLowerCase();
	if (
		mediaType !== '' &&
		!['text/html', 'application/xhtml+xml', 'text/plain'].includes(mediaType)
	) {
		throw new ScrapeError(`Tipo de conteúdo não suportado: ${mediaType}.`);
	}

	const text = await readBodyWithLimit(response);
	return { finalUrl: current, status: response.status, contentType, text };
}

async function readBodyWithLimit(response: Response): Promise<string> {
	if (!response.body) {
		return '';
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
	let total = 0;
	let text = '';

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_BODY_BYTES) {
			reader.cancel().catch(() => {});
			throw new ScrapeError(
				`Conteúdo demasiado grande (limite: ${Math.round(MAX_BODY_BYTES / 1000)} kB).`,
			);
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();

	return text;
}

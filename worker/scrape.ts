/**
 * Recolha (scraping) do conteúdo de uma página.
 *
 * - valida o URL inicial e TODOS os destinos de redirect com a mesma regra
 *   (apenas HTTP/HTTPS, sem anfitriões locais/privados, sem credenciais);
 * - segue redirects manualmente para poder validar cada destino (anti-SSRF);
 * - impõe timeout ao pedido;
 * - impõe limite de tamanho ao corpo.
 */

const FETCH_TIMEOUT_MS = 15_000;
/** Limite inicial ajustável do corpo descodificado, escolhido para o orçamento Free. */
export const MAX_BODY_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;

export class ScrapeError extends Error {
	readonly httpStatus?: number;
	readonly contentLength?: string | null;
	readonly bodyBytesRead: number;

	constructor(
		message: string,
		options: { httpStatus?: number; contentLength?: string | null; bodyBytesRead?: number } = {},
	) {
		super(message);
		this.httpStatus = options.httpStatus;
		this.contentLength = options.contentLength;
		this.bodyBytesRead = options.bodyBytesRead ?? 0;
	}
}

const IPV4_HOST_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const BLOCKED_HOSTNAMES = new Set(['localhost']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
const SAFE_PORTS = new Set(['', '80', '443']);

/**
 * Analisa e valida um URL com todas as regras de segurança.
 * Aplica-se tanto ao URL da monitorização como a cada destino de redirect.
 */
function parseSafeUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
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

	let unsafeHost = false;
	if (hostname.length === 0 || BLOCKED_HOSTNAMES.has(hostname)) {
		unsafeHost = true;
	} else if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
		unsafeHost = true;
	} else if (IPV4_HOST_RE.test(hostname) && isPrivateIPv4(hostname)) {
		unsafeHost = true;
	} else if (
		hostname.startsWith('[') &&
		hostname.endsWith(']') &&
		isPrivateIPv6(hostname)
	) {
		unsafeHost = true;
	}

	if (unsafeHost) {
		throw new ScrapeError('O endereço não pode apontar para rede local ou interna.');
	}

	if (!SAFE_PORTS.has(url.port)) {
		throw new ScrapeError('Apenas são aceites as portas 80 e 443.');
	}

	return url;
}

/** Valida o URL inicial de uma monitorização; devolve-o normalizado. */
export function validateMonitorUrl(raw: string): string {
	return parseSafeUrl(raw.trim()).toString();
}

/**
 * Valida o destino de um redirect (relativo ou absoluto) com as mesmas regras.
 * Lista de exemplos bloqueados: localhost, 127.0.0.1, 192.168.1.1, [::1],
 * [::ffff:127.0.0.1] (IPv6 com IPv4 mapeado), *.local, *.internal, credenciais.
 */
function resolveRedirectLocation(location: string, base: string): string {
	let resolved: URL;
	try {
		// Location pode ser relativo ou absoluto: ambos são resolvidos e validados.
		resolved = new URL(location, base);
	} catch {
		throw new ScrapeError('Redirecionamento inválido.');
	}
	return parseSafeUrl(resolved.toString()).toString();
}

/* ------------------------------------------------------------------ */
/* Anfitriões privados: IPv4 e IPv6                                    */
/* ------------------------------------------------------------------ */

const BLOCKED_IP_RANGES: Array<[number, number]> = [
	[0x00000000, 0x00ffffff], // 0.0.0.0/8
	[0x0a000000, 0x0affffff], // 10.0.0.0/8
	[0x64400000, 0x647fffff], // 100.64.0.0/10 (CGNAT)
	[0x7f000000, 0x7fffffff], // 127.0.0.0/8 (loopback)
	[0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 (inclui metadados)
	[0xac100000, 0xac1fffff], // 172.16.0.0/12
	[0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
	[0xc6120000, 0xc613ffff], // 198.18.0.0/15 (benchmarking)
];

function isPrivateIPv4Value(value: number): boolean {
	return BLOCKED_IP_RANGES.some(([start, end]) => value >= start && value <= end);
}

function isPrivateIPv4(host: string): boolean {
	const parts = host.split('.').map(Number);
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n > 255)) {
		return true;
	}
	const value =
		((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
	return isPrivateIPv4Value(value);
}

/**
 * Expande um endereço IPv6 para 8 grupos de 16 bits.
 * Devolve null se não for um IPv6 bem formado (inclui identificadores de zona).
 */
function parseIPv6Groups(text: string): number[] | null {
	if (text.includes('%')) return null; // zona de âmbito (ex.: fe80::1%eth0)

	const halves = text.toLowerCase().split('::');
	if (halves.length > 2) return null;

	let head = halves[0] ? halves[0].split(':') : [];
	let tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	if (halves.length === 1) {
		if (head.length !== 8) return null;
		tail = [];
	}

	const parseGroup = (group: string): number | null => {
		if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
		return Number.parseInt(group, 16);
	};

	const headValues = head.map(parseGroup);
	const tailValues = tail.map(parseGroup);
	if (headValues.includes(null) || tailValues.includes(null)) return null;

	const headGroups = headValues as number[];
	const tailGroups = tailValues as number[];

	let middleGroups: number[];
	if (halves.length === 2) {
		const missing = 8 - (headGroups.length + tailGroups.length);
		if (missing < 0) return null;
		middleGroups = new Array<number>(missing).fill(0);
	} else {
		middleGroups = [];
	}

	return [...headGroups, ...middleGroups, ...tailGroups];
}

function isPrivateIPv6(bracketedHost: string): boolean {
	const text = bracketedHost.slice(1, -1); // remove os parênteses rectos
	const groups = parseIPv6Groups(text);
	if (!groups) return true; // não interpretável: preferir bloquear

	const isZero = (from: number, to: number) =>
		groups.slice(from, to).every((g) => g === 0);

	// :: (não especificado) e ::1 (loopback)
	if (isZero(0, 7) && (groups[7] === 0 || groups[7] === 1)) {
		return true;
	}

	// fc00::/7 (unique local, fc00..fdff)
	if ((groups[0] & 0xfe00) === 0xfc00) return true;

	// fe80::/10 (link-local, fe80..febf)
	if ((groups[0] & 0xffc0) === 0xfe80) return true;

	// ::ffff:0:0/96 (IPv4 mapeado) e 64:ff9b::/96 (NAT64): validar o IPv4 embutido
	const prefix =
		isZero(0, 5) && groups[5] === 0xffff ? 'mapped'
		: groups[0] === 0x64 && groups[1] === 0xff9b && isZero(2, 5) && groups[5] === 0
			? 'nat64'
			: null;
	if (prefix) {
		const embedded =
			((groups[6] << 16) | groups[7]) >>> 0;
		return isPrivateIPv4Value(embedded);
	}

	return false;
}

/* ------------------------------------------------------------------ */
/* Recolha                                                             */
/* ------------------------------------------------------------------ */

export type FetchedPage = {
	finalUrl: string;
	status: number;
	contentType: string;
	text: string;
	bytesRead: number;
	contentLength: string | null;
};

/**
 * Recolhe a página: segue redirects manualmente (validando cada destino),
 * impõe timeout e limita o tamanho do corpo.
 */
export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
	let current = rawUrl;
	let response: Response | undefined;

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const attempt = await fetch(current, {
			redirect: 'manual',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: {
				'user-agent': 'Watchly/0.1 (+monitorizacao de paginas)',
				accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
			},
		});

		if ([301, 302, 303, 307, 308].includes(attempt.status)) {
			const location = attempt.headers.get('location');
			if (!location) {
				throw new ScrapeError('Redirecionamento sem destino (Location).');
			}
			current = resolveRedirectLocation(location, current);
			continue;
		}

		response = attempt;
		break;
	}

	if (!response) {
		throw new ScrapeError(
			`Demasiados redirecionamentos (limite: ${MAX_REDIRECTS}).`,
		);
	}

	if (!response.ok) {
		throw new ScrapeError(`A página devolveu o estado HTTP ${response.status}.`, {
			httpStatus: response.status,
			contentLength: response.headers.get('content-length'),
		});
	}

	const contentType = response.headers.get('content-type') ?? '';
	const mediaType = contentType.split(';')[0].trim().toLowerCase();
	if (
		mediaType !== '' &&
		!['text/html', 'application/xhtml+xml', 'text/plain'].includes(mediaType)
	) {
		throw new ScrapeError(`Tipo de conteúdo não suportado: ${mediaType}.`, {
			httpStatus: response.status,
			contentLength: response.headers.get('content-length'),
		});
	}

	const body = await readBodyWithLimit(response);
	return {
		finalUrl: current,
		status: response.status,
		contentType,
		contentLength: response.headers.get('content-length'),
		...body,
	};
}

async function readBodyWithLimit(
	response: Response,
	maxBodyBytes = MAX_BODY_BYTES,
): Promise<{ text: string; bytesRead: number }> {
	if (!response.body) {
		return { text: '', bytesRead: 0 };
	}
	const contentLength = response.headers.get('content-length');
	if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBodyBytes) {
		await response.body.cancel().catch(() => {});
		throw bodyTooLargeError(maxBodyBytes, 0, contentLength);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
	let total = 0;
	const chunks: string[] = [];

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBodyBytes) {
			await reader.cancel().catch(() => {});
			throw bodyTooLargeError(maxBodyBytes, total, contentLength);
		}
		chunks.push(decoder.decode(value, { stream: true }));
	}
	const finalChunk = decoder.decode();
	if (finalChunk) chunks.push(finalChunk);

	return { text: chunks.join(''), bytesRead: total };
}

function bodyTooLargeError(
	maxBodyBytes: number,
	bodyBytesRead: number,
	contentLength: string | null,
): ScrapeError {
	return new ScrapeError(
		`Página demasiado grande: o limite de leitura é ${Math.ceil(maxBodyBytes / 1024)} KiB.`,
		{ contentLength, bodyBytesRead },
	);
}

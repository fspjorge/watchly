import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPage, MAX_BODY_BYTES, ScrapeError, validateMonitorUrl } from './scrape.ts';

describe('validateMonitorUrl', () => {
	it('aceita URLs HTTP e HTTPS normalizando-os', () => {
		expect(validateMonitorUrl('http://exemplo.pt/página')).toBe(
			'http://exemplo.pt/p%C3%A1gina',
		);
		expect(validateMonitorUrl('https://exemplo.pt/')).toBe('https://exemplo.pt/');
	});

	it('rejeita esquemas não HTTP(S)', () => {
		for (const raw of ['ftp://exemplo.pt', 'file:///etc/hosts', 'javascript:alert(1)']) {
			expect(() => validateMonitorUrl(raw)).toThrow(/HTTP ou HTTPS/);
		}
	});

	it('rejeita URLs mal formados', () => {
		expect(() => validateMonitorUrl('not a url')).toThrow(ScrapeError);
		expect(() => validateMonitorUrl('')).toThrow(ScrapeError);
	});

	it('rejeita localhost e domínios internos', () => {
		for (const raw of [
			'http://localhost:8787',
			'http://aplicacao.internal/pag',
			'http://impressora.local',
			'http://papelaria.home.arpa',
		]) {
			expect(() => validateMonitorUrl(raw)).toThrow(/local|próprio servidor|interna/);
		}
	});

	it('rejeita endereços IP privados ou de loopback', () => {
		for (const raw of [
			'http://127.0.0.1/',
			'http://10.0.0.5/',
			'http://192.168.1.20/',
			'http://172.16.0.3/',
			'http://172.31.255.255/',
			'http://169.254.169.254/class',
			'http://0.0.0.0/',
			'http://100.64.0.1/',
		]) {
			expect(() => validateMonitorUrl(raw)).toThrow(/local ou interna/);
		}
	});

	it('aceita endereços IP públicos', () => {
		expect(() => validateMonitorUrl('http://8.8.8.8/')).not.toThrow();
		expect(() => validateMonitorUrl('http://172.32.0.1/')).not.toThrow();
	});

	it('rejeita URLs com credenciais embutidas', () => {
		expect(() => validateMonitorUrl('https://utilizador:senha@exemplo.pt')).toThrow(
			/credenciais/,
		);
	});
});

/* ------------------------------------------------------------------ */
/* Redirects: validação SSRF com fetch simulado                        */
/* ------------------------------------------------------------------ */

describe('fetchPage — cabeçalhos do pedido', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function htmlResponse(): Response {
		return new Response('<p>ok</p>', {
			status: 200,
			headers: { 'content-type': 'text/html' },
		});
	}

	it('envia o User-Agent exclusivamente em ASCII (regra RFC 7230 para valores de cabeçalho)', async () => {
		const captured: HeadersInit[] = [];
		const mock = vi.fn((_url: unknown, init?: { headers?: HeadersInit }) => {
			captured.push(init?.headers ?? {});
			return Promise.resolve(htmlResponse());
		});
		vi.stubGlobal('fetch', mock);

		await fetchPage('https://publico.pt/pagina');

		expect(mock).toHaveBeenCalled();
		for (const headers of captured) {
			const hdr = new Headers(headers);
			const userAgent = hdr.get('user-agent');
			expect(userAgent).toBeTruthy();
			// Valores de cabeçalho aceitáveis: apenas carácter observável ASCII + espaços.
			expect(userAgent).toMatch(/^[\x20-\x7E]+$/);
			expect(userAgent).toContain('Watchly/0.1');
		}
	});
});

describe('fetchPage — validação de destinos de redirect', () => {
	const ORIGIN = 'https://publico.pt/pagina';

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function redirectResponse(location: string): Response {
		return new Response(null, { status: 302, headers: { location } });
	}

	function htmlResponse(body: string): Response {
		return new Response(body, {
			status: 200,
			headers: { 'content-type': 'text/html' },
		});
	}

	function stubFetch(responses: Response[]): ReturnType<typeof vi.fn> {
		const mock = vi.fn((_url: unknown, _init?: unknown) => {
			const next = responses.shift();
			return Promise.resolve(
				next ?? new Response('', { status: 500, headers: { 'content-type': 'text/plain' } }),
			);
		});
		vi.stubGlobal('fetch', mock);
		return mock;
	}

	const requestedUrls = (mock: { mock: { calls: unknown[][] } }): string[] =>
		mock.mock.calls.map((call) => String(call[0]));

	it('bloqueia redirect para localhost sem pedir o destino', async () => {
		const mock = stubFetch([redirectResponse('http://localhost:8787/admin')]);
		await expect(fetchPage(ORIGIN)).rejects.toThrow(
			/local|próprio servidor|interna/,
		);
		// Só o URL inicial correu; o destino localhost nunca foi pedido.
		expect(requestedUrls(mock)).toEqual([ORIGIN]);
	});

	it('bloqueia redirect para 127.0.0.1 (loopback IPv4)', async () => {
		const mock = stubFetch([redirectResponse('http://127.0.0.1/painel')]);
		await expect(fetchPage(ORIGIN)).rejects.toThrow(/local ou interna/);
		expect(requestedUrls(mock)).toEqual([ORIGIN]);
	});

	it('bloqueia redirect para 192.168.1.1 (rede privada IPv4)', async () => {
		const mock = stubFetch([redirectResponse('http://192.168.1.1/config')]);
		await expect(fetchPage(ORIGIN)).rejects.toThrow(/local ou interna/);
		expect(requestedUrls(mock)).toEqual([ORIGIN]);
	});

	it('bloqueia redirect para IPv6 ::1 (loopback IPv6)', async () => {
		const mock = stubFetch([redirectResponse('http://[::1]/')]);
		await expect(fetchPage(ORIGIN)).rejects.toThrow(/local ou interna/);
		expect(requestedUrls(mock)).toEqual([ORIGIN]);
	});

	it('bloqueia redirect para IPv6 com IPv4 privado mapeado (::ffff:127.0.0.1)', async () => {
		const mock = stubFetch([redirectResponse('http://[::ffff:127.0.0.1]/secret')]);
		await expect(fetchPage(ORIGIN)).rejects.toThrow(/local ou interna/);
		expect(requestedUrls(mock)).toEqual([ORIGIN]);
	});

	it('bloqueia redirect para domínio .local e .internal', async () => {
		for (const destination of [
			'http://impressora.local/',
			'http://servidor.internal/pagina',
		]) {
			const mock = stubFetch([redirectResponse(destination)]);
			await expect(fetchPage(ORIGIN)).rejects.toThrow(/local ou interna/);
			expect(requestedUrls(mock)).toEqual([ORIGIN]);
			vi.unstubAllGlobals();
		}
	});

	it('bloqueia redirect com credenciais embutidas', async () => {
		const mock = stubFetch([
			redirectResponse('http://utilizador:senha@publico.pt/painel'),
		]);
		await expect(fetchPage(ORIGIN)).rejects.toThrow(/credenciais/);
		expect(requestedUrls(mock)).toEqual([ORIGIN]);
	});

	it('aceita redirect relativo para destino público', async () => {
		const mock = stubFetch([
			redirectResponse('/relativo?a=1'),
			htmlResponse('<p>Conteúdo final</p>'),
		]);
		const page = await fetchPage(ORIGIN);

		expect(page.finalUrl).toBe('https://publico.pt/relativo?a=1');
		expect(page.text).toContain('Conteúdo final');
		expect(requestedUrls(mock)).toEqual([
			ORIGIN,
			'https://publico.pt/relativo?a=1',
		]);
	});

	it('aceita redirect absoluto entre domínios públicos', async () => {
		const mock = stubFetch([
			redirectResponse('https://outro-publico.pt/destino'),
			htmlResponse('ok'),
		]);
		const page = await fetchPage(ORIGIN);

		expect(page.finalUrl).toBe('https://outro-publico.pt/destino');
		expect(requestedUrls(mock)).toEqual([
			ORIGIN,
			'https://outro-publico.pt/destino',
		]);
	});

	it('rejeita quando os redirects excedem o limite de 5', async () => {
		const responses = Array.from({ length: 6 }, (_, index) =>
			redirectResponse(`https://publico.pt/pass-${index + 1}`),
		);
		const mock = stubFetch(responses);
		await expect(fetchPage(ORIGIN)).rejects.toThrow(/Demasiados redirecionamentos/);

		// Seguiu 5 redirects; o destino do 6.º nunca foi pedido.
		expect(requestedUrls(mock)).toEqual([
			ORIGIN,
			'https://publico.pt/pass-1',
			'https://publico.pt/pass-2',
			'https://publico.pt/pass-3',
			'https://publico.pt/pass-4',
			'https://publico.pt/pass-5',
		]);
	});
});

describe('fetchPage — limite do corpo', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function responseWithBody(
		body: BodyInit | null,
		headers: HeadersInit = {},
		status = 200,
	): Response {
		return new Response(body, {
			status,
			headers: { 'content-type': 'text/html', ...Object.fromEntries(new Headers(headers)) },
		});
	}

	function stub(response: Response): void {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response)));
	}

	it('aceita corpo abaixo do limite', async () => {
		const body = 'x'.repeat(MAX_BODY_BYTES - 1);
		stub(responseWithBody(body));
		const page = await fetchPage('https://publico.pt/');
		expect(page.text).toHaveLength(MAX_BODY_BYTES - 1);
		expect(page.bytesRead).toBe(MAX_BODY_BYTES - 1);
	});

	it('aceita corpo exactamente no limite', async () => {
		const body = 'x'.repeat(MAX_BODY_BYTES);
		stub(responseWithBody(body));
		const page = await fetchPage('https://publico.pt/');
		expect(page.text).toHaveLength(MAX_BODY_BYTES);
		expect(page.bytesRead).toBe(MAX_BODY_BYTES);
	});

	it('cancela a leitura e dá erro explícito ao ultrapassar o limite', async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('x'.repeat(MAX_BODY_BYTES)));
				controller.enqueue(new TextEncoder().encode('x'));
			},
			cancel() {
				cancelled = true;
			},
		});
		stub(responseWithBody(stream));

		await expect(fetchPage('https://publico.pt/')).rejects.toMatchObject({
			message: `Página demasiado grande: o limite de leitura é ${MAX_BODY_BYTES / 1024} KiB.`,
			bodyBytesRead: MAX_BODY_BYTES + 1,
		});
		expect(cancelled).toBe(true);
	});

	it('usa Content-Length para rejeitar cedo, sem o tratar como única protecção', async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		stub(responseWithBody(stream, { 'content-length': String(MAX_BODY_BYTES + 1) }));

		await expect(fetchPage('https://publico.pt/')).rejects.toMatchObject({
			message: expect.stringMatching(/Página demasiado grande/),
			contentLength: String(MAX_BODY_BYTES + 1),
			bodyBytesRead: 0,
		});
		expect(cancelled).toBe(true);
	});

	it('regista HTTP 403 sem consumir o corpo de erro', async () => {
		stub(responseWithBody('bloqueado', { 'content-length': '9' }, 403));
		await expect(fetchPage('https://publico.pt/')).rejects.toMatchObject({
			httpStatus: 403,
			contentLength: '9',
			bodyBytesRead: 0,
			message: 'A página devolveu o estado HTTP 403.',
		});
	});
});

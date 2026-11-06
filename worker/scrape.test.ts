import { describe, expect, it } from 'vitest';

import { ScrapeError, validateMonitorUrl } from './scrape.ts';

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

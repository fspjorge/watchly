import { extractTextFromHtml } from '../worker/extract.ts';
import { sha256Hex } from '../worker/api.ts';
import { fetchPublic, type Resolver } from './ssrf.ts';

export const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
export type CheckResult = {
	outcome: 'initial' | 'unchanged' | 'changed' | 'error';
	message: string;
	content?: string;
	contentHash?: string;
	httpStatus?: number;
	contentType?: string;
	metrics: { durationMs: number; fetchMs: number; extractMs: number; normalizeMs: number; hashMs: number; bytesReceived: number };
};
/** Options are for internal tests only; the HTTP handler never forwards request fields here. */
export type CheckOptions = { resolver?: Resolver; timeoutMs?: number; maxBytes?: number; previousHash?: string };

export async function checkUrl(rawUrl: string, options: CheckOptions = {}): Promise<CheckResult> {
	const started = performance.now();
	const metrics = { durationMs: 0, fetchMs: 0, extractMs: 0, normalizeMs: 0, hashMs: 0, bytesReceived: 0 };
	try {
		const fetchStarted = performance.now();
		const response = await fetchPublic(rawUrl, {
			resolver: options.resolver,
			timeoutMs: options.timeoutMs ?? 8000,
			maxBytes: options.maxBytes ?? MAX_CONTENT_BYTES,
		});
		metrics.fetchMs = performance.now() - fetchStarted;
		metrics.bytesReceived = response.body.length;
		if (response.status < 200 || response.status >= 300) {
			return { outcome: 'error', message: `A página devolveu HTTP ${response.status}.`, httpStatus: response.status, contentType: String(response.headers['content-type'] ?? ''), metrics: { ...metrics, durationMs: performance.now() - started } };
		}
		const extractStarted = performance.now();
		const normalized = extractTextFromHtml(response.body.toString('utf8'));
		metrics.extractMs = performance.now() - extractStarted;
		if (!normalized) throw new Error('A página não devolveu texto utilizável.');
		const hashStarted = performance.now();
		const contentHash = await sha256Hex(normalized);
		metrics.hashMs = performance.now() - hashStarted;
		metrics.durationMs = performance.now() - started;
		const outcome = options.previousHash ? options.previousHash === contentHash ? 'unchanged' : 'changed' : 'initial';
		return { outcome, message: outcome === 'initial' ? 'Referência inicial criada.' : outcome === 'unchanged' ? 'Sem alterações.' : 'Alterações detectadas.', content: normalized, contentHash, httpStatus: response.status, contentType: String(response.headers['content-type'] ?? ''), metrics };
	} catch (error) {
		metrics.durationMs = performance.now() - started;
		return { outcome: 'error', message: error instanceof Error ? error.message : 'Falha na verificação.', metrics };
	}
}

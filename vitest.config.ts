import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Testa apenas módulos do Worker (normalização, extracção, comparação, URLs).
		// Evita o plugin Cloudflare do vite.config.ts, que não se aplica aqui.
		include: ['worker/**/*.test.ts'],
	},
});

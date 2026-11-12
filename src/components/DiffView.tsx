import { useEffect, useState } from 'react';

import { getDiff, type MonitorDiff } from '../api.ts';

type Props = {
	monitorId: string;
	onBack: () => void;
};

/** Legenda: 'removed' = vermelho, 'added' = verde, 'unchanged' = neutro. */
export function DiffView({ monitorId, onBack }: Props) {
	const [diff, setDiff] = useState<MonitorDiff | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;

		getDiff(monitorId)
			.then((data) => {
				if (!cancelled) setDiff(data);
			})
			.catch((cause: unknown) => {
				if (!cancelled) {
					setError(cause instanceof Error ? cause.message : 'Não foi possível obter as diferenças.');
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [monitorId]);

	return (
		<section className="diff-view">
			<button className="btn back" type="button" onClick={onBack}>
				← Voltar às monitorizações
			</button>

			{loading && <p className="loading">A carregar diferenças…</p>}

			{error && <p className="form-error" role="alert">{error}</p>}

			{diff && (
				<div className="card diff-card">
					<header className="diff-header">
						<h2>Diferenças: {diff.monitor.name}</h2>
						<div className="diff-meta">
							<span className="badge removed">− {diff.removedCount} linha(s)</span>
							<span className="badge ok">+ {diff.addedCount} linha(s)</span>
						</div>
						<p className="diff-snapshots">
							Versão anterior: versão #{diff.before.id} ({formatSnapshotDate(diff.before.captured_at)})
							→ versão mais recente: #{diff.after.id} ({formatSnapshotDate(diff.after.captured_at)})
						</p>
						{diff.filteredByKeywords && (
							<p className="diff-snapshots">
								Diferenças filtradas pelas keywords: {diff.keywords.join(', ')}.
							</p>
						)}
					</header>

					{diff.filteredByKeywords && !diff.hasMatchingDiff ? (
						<p className="diff-snapshots">Não há alterações correspondentes às keywords configuradas.</p>
					) : (
						<div className="diff-chunks" role="table" aria-label="Comparações de linhas">
							{diff.chunks.map((chunk, index) => (
								<div key={index} className={`diff-chunk ${chunk.type}`}>
									{chunk.lines.map((line, lineIndex) => (
										<Row key={lineIndex} line={line} type={chunk.type} />
									))}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</section>
	);
}

function Row({ line, type }: { line: string; type: 'unchanged' | 'removed' | 'added' }) {
	const prefix = type === 'removed' ? '−' : type === 'added' ? '+' : ' ';
	return (
		<div className={`diff-line ${type}`} title={LABELS[type]}>
			<span className="line-marker">{prefix}</span>
			<span className="line-text">{line}</span>
		</div>
	);
}

const LABELS = {
	unchanged: 'Linha mantida',
	removed: 'Linha removida',
	added: 'Linha adicionada',
} as const;

function formatSnapshotDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat('pt-PT', {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(date);
}

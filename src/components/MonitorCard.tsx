import { STATUS_LABELS, type Monitor } from '../api.ts';

export type FeedbackKind = 'ok' | 'info' | 'error';

export type MonitorFeedback = {
	kind: FeedbackKind;
	text: string;
};

type Props = {
	monitor: Monitor;
	feedback: MonitorFeedback | null;
	busy: boolean;
	onCheck: (monitor: Monitor) => void;
	onShowDiff: (monitor: Monitor) => void;
};

const STATUS_CLASSES: Record<Monitor['last_status'], string> = {
	pending: 'pending',
	unchanged: 'ok',
	changed: 'alert',
	error: 'error',
};

export function MonitorCard({ monitor, feedback, busy, onCheck, onShowDiff }: Props) {
	// Se a última verificação falhou, o erro registado na base de dados
	// é apresentado sempre que não haja mensagem mais recente.
	const dbError =
		monitor.last_status === 'error' && monitor.last_error
			? { kind: 'error' as const, text: monitor.last_error }
			: null;

	const message = feedback ?? dbError;

	return (
		<li className="card monitor-card">
			<div className="monitor-head">
				<div className="monitor-title">
					<h3>{monitor.name}</h3>
					<a href={monitor.url} target="_blank" rel="noreferrer" className="monitor-url">
						{monitor.url}
					</a>
				</div>
				<span className={`badge ${STATUS_CLASSES[monitor.last_status]}`}>
					{STATUS_LABELS[monitor.last_status]}
				</span>
			</div>

			<p className="monitor-meta">
				Última verificação:{' '}
				<strong>
					{monitor.last_checked_at ? formatDate(monitor.last_checked_at) : 'nunca'}
				</strong>
			</p>

			{message && (
				<p className="monitor-message" data-kind={message.kind}>
					{message.text}
				</p>
			)}

			<div className="monitor-actions">
				<button className="btn" type="button" onClick={() => onCheck(monitor)} disabled={busy}>
					{busy ? 'A verificar…' : 'Verificar agora'}
				</button>
				<button className="btn" type="button" onClick={() => onShowDiff(monitor)}>
					Ver diferenças
				</button>
			</div>
		</li>
	);
}

function formatDate(value: string | null): string {
	if (!value) return 'nunca';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return 'nunca';
	return new Intl.DateTimeFormat('pt-PT', {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(date);
}

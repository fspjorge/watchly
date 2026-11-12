import {
	frequencyLabel,
	formatEpoch,
	STATUS_LABELS,
	type Monitor,
} from '../api.ts';
import { EditMonitorForm } from './EditMonitorForm.tsx';

export type FeedbackKind = 'ok' | 'info' | 'error';

export type MonitorFeedback = {
	kind: FeedbackKind;
	text: string;
};

type Props = {
	monitor: Monitor;
	feedback: MonitorFeedback | null;
	busy: boolean;
	editing: boolean;
	onCheck: (monitor: Monitor) => void;
	onShowDiff: (monitor: Monitor) => void;
	onEdit: (monitor: Monitor) => void;
	onEditDone: () => void;
	onDelete: (monitor: Monitor) => void;
};

const STATUS_CLASSES: Record<Monitor['last_status'], string> = {
	pending: 'pending',
	unchanged: 'ok',
	changed: 'alert',
	filtered: 'pending',
	error: 'error',
};

export function MonitorCard({
	monitor,
	feedback,
	busy,
	editing,
	onCheck,
	onShowDiff,
	onEdit,
	onEditDone,
	onDelete,
}: Props) {
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

			{editing ? (
				<EditMonitorForm
					monitor={monitor}
					onSaved={onEditDone}
					onCancel={onEditDone}
				/>
			) : (
				<>
					<p className="monitor-meta">
						Frequência: <strong>{frequencyLabel(monitor.frequency_minutes)}</strong>
					</p>
					{monitor.keywords && (
						<p className="monitor-meta">
							Keywords: <strong>{monitor.keywords.split('\n').join(', ')}</strong>
						</p>
					)}
					<p className="monitor-meta">
						Última verificação:{' '}
						<strong>
							{monitor.last_checked_at ? formatDate(monitor.last_checked_at) : 'nunca'}
						</strong>
					</p>
					<p className="monitor-meta">
						Próxima verificação:{' '}
						<strong>
							{monitor.next_check_at === null
								? '— (sem verificação automática)'
								: formatEpoch(monitor.next_check_at)}
						</strong>
					</p>

					{message && (
						<p className="monitor-message" data-kind={message.kind}>
							{message.text}
						</p>
					)}

					<div className="monitor-actions">
						<button
							className="btn"
							type="button"
							onClick={() => onCheck(monitor)}
							disabled={busy}
						>
							{busy ? 'A verificar…' : 'Verificar agora'}
						</button>
						<button className="btn" type="button" onClick={() => onShowDiff(monitor)}>
							Ver diferenças
						</button>
						<button className="btn subtle" type="button" onClick={() => onEdit(monitor)}>
							Editar
						</button>
						<button className="btn subtle danger" type="button" onClick={() => onDelete(monitor)}>
							Apagar
						</button>
					</div>
				</>
			)}
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

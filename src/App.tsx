import { useCallback, useEffect, useRef, useState } from 'react';

import {
	checkMonitor,
	deleteMonitor as deleteMonitorApi,
	getMe,
	listMonitors,
	updateEmailNotificationPreference,
	type CheckOutcome,
	type Monitor,
	type User,
} from './api.ts';
import { AddMonitorForm } from './components/AddMonitorForm.tsx';
import { EmailNotificationSettings } from './components/EmailNotificationSettings.tsx';
import { DiffView } from './components/DiffView.tsx';
import { MonitorCard, type MonitorFeedback } from './components/MonitorCard.tsx';
import './App.css';

type View = { kind: 'dashboard' } | { kind: 'diff'; monitorId: string };

function App() {
	const [view, setView] = useState<View>({ kind: 'dashboard' });
	const [user, setUser] = useState<User | null>(null);
	const [monitors, setMonitors] = useState<Monitor[]>([]);
	const [reloadKey, setReloadKey] = useState(0);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<Record<string, MonitorFeedback>>({});
	const timers = useRef<number[]>([]);

	const clearTimers = useCallback(() => {
		for (const timer of timers.current) window.clearTimeout(timer);
		timers.current = [];
	}, []);

	// Arranque: perfil (/api/me) e monitorizações em paralelo (Promise.all),
	// para que uma resposta não deixe dados antigos renderizados sob outra
	// identidade. Qualquer 401/403 (aqui ou mais tarde, por via do evento
	// 'watchly:auth-error') limpa o utilizador e a lista: nada é apresentado.
	useEffect(() => {
		let active = true;
		const onAuthError = (event: Event) => {
			if (!active) return;
			const message =
				event instanceof CustomEvent && typeof event.detail === 'string'
					? event.detail
					: 'A tua sessão terminou. Volta a autenticar-te.';
			setUser(null);
			setMonitors([]);
			setLoadError(message);
		};
		window.addEventListener('watchly:auth-error', onAuthError);
		(async () => {
			try {
				const [me, data] = await Promise.all([getMe(), listMonitors()]);
				if (!active) return;
				setUser(me);
				setMonitors(data);
				setLoadError(null);
			} catch (cause) {
				if (!active) return;
				setUser(null);
				setLoadError(
					cause instanceof Error
						? cause.message
						: 'Não foi possível carregar os teus dados. Volta a autenticar-te.',
				);
			} finally {
				if (active) setLoading(false);
			}
		})();

		return () => {
			active = false;
			window.removeEventListener('watchly:auth-error', onAuthError);
		};
	}, [reloadKey]);

	useEffect(() => clearTimers, [clearTimers]);

	const refresh = () => setReloadKey((key) => key + 1);

	const setMonitorFeedback = (id: string, value: MonitorFeedback | null) => {
		setFeedback((previous) => {
			const next = { ...previous };
			if (value) next[id] = value;
			else delete next[id];
			return next;
		});
	};

	const removeFeedbackAfter = (id: string, ms: number) => {
		const timer = window.setTimeout(() => setMonitorFeedback(id, null), ms);
		timers.current.push(timer);
	};

	const handleAdded = (_monitorId: string) => {
		// Após adicionar, recarrega a lista: a nova monitorização surge "Por verificar".
		refresh();
	};

	const handleCheck = async (monitor: Monitor) => {
		setBusyId(monitor.id);
		setMonitorFeedback(monitor.id, null);
		try {
			const result = await checkMonitor(monitor.id);
			setMonitorFeedback(
				monitor.id,
				feedbackFor(result.outcome, result.message),
			);
			refresh();
			removeFeedbackAfter(
				monitor.id,
				result.outcome === 'changed' ? 8000 : 6000,
			);
		} catch (cause) {
			setMonitorFeedback(monitor.id, {
				kind: 'error',
				text: cause instanceof Error ? cause.message : 'A verificação falhou.',
			});
			refresh();
		} finally {
			setBusyId(null);
		}
	};

	const handleDelete = (monitor: Monitor) => {
		const confirmed = window.confirm(
			`Apagar "${monitor.name}"? As versões guardadas desta página serão também apagadas. Esta operação é irreversível.`,
		);
		if (!confirmed) return;

		setBusyId(monitor.id);
		(async () => {
			try {
				await deleteMonitorApi(monitor.id);
				setMonitorFeedback(monitor.id, null);
			} catch (cause) {
				setMonitorFeedback(monitor.id, {
					kind: 'error',
					text: cause instanceof Error ? cause.message : 'Não foi possível apagar.',
				});
			} finally {
				setBusyId(null);
				refresh();
			}
		})();
	};

	const handleEditDone = () => {
		setEditingId(null);
		refresh();
	};

	const handleEmailPreference = async (enabled: boolean) => {
		const saved = await updateEmailNotificationPreference(enabled);
		setUser((current) => current ? { ...current, email_notifications_enabled: saved } : current);
	};

	if (view.kind === 'diff') {
		return (
			<main className="app">
				<Header user={user} />
				<DiffView
					key={view.monitorId}
					monitorId={view.monitorId}
					onBack={() => setView({ kind: 'dashboard' })}
				/>
			</main>
		);
	}

	return (
		<main className="app">
			<Header user={user} />

			{loadError && (
				<p className="auth-error" role="alert">
					{loadError}
				</p>
			)}

			{user && (
				<EmailNotificationSettings
					enabled={user.email_notifications_enabled}
					onChange={handleEmailPreference}
				/>
			)}

			{user && (
				<section className="panel card">
					<h2>Nova monitorização</h2>
					<p className="panel-hint">
						Indica um nome e o endereço da página (HTTP ou HTTPS) que pretendes vigiar.
					</p>
					<AddMonitorForm onAdded={handleAdded} />
				</section>
			)}

			{user && (
				<section className="panel">
					<h2>Páginas monitorizadas</h2>

					{loading && <p className="loading">A carregar…</p>}

					{!loading && monitors.length === 0 && (
						<p className="empty">Ainda não tens monitorizações. Adiciona a primeira acima.</p>
					)}

					<ul className="monitor-list">
						{monitors.map((monitor) => (
							<MonitorCard
								key={monitor.id}
								monitor={monitor}
								feedback={feedback[monitor.id] ?? null}
								busy={busyId === monitor.id}
								editing={editingId === monitor.id}
								onCheck={handleCheck}
								onShowDiff={(mon) => setView({ kind: 'diff', monitorId: mon.id })}
								onEdit={(mon) => setEditingId(mon.id)}
								onEditDone={handleEditDone}
								onDelete={handleDelete}
							/>
						))}
					</ul>
				</section>
			)}
		</main>
	);
}

function feedbackFor(outcome: CheckOutcome, message: string): MonitorFeedback {
	switch (outcome) {
		case 'initial':
			return { kind: 'info', text: message };
		case 'unchanged':
			return { kind: 'ok', text: message };
		case 'changed':
			return { kind: 'info', text: message };
		case 'filtered':
			return { kind: 'info', text: message };
		case 'error':
			return { kind: 'error', text: message };
	}
}

function Header({ user }: { user: User | null }) {
	return (
		<header className="app-header">
			<div className="app-header-center">
				<h1 className="brand">Watchly</h1>
				<p className="app-subtitle">Vigia alterações em páginas da Internet</p>
			</div>
			{user && (
				<div className="user-info" title={user.email}>
					<span className="user-name">{user.name ?? user.email}</span>
					<span className="user-email">{user.email}</span>
				</div>
			)}
			{/* Navegação nativa (sem AJAX): deixa o Cloudflare Access terminar a sessão. */}
			<a
				className="logout-link"
				href="/cdn-cgi/access/logout"
				title="Terminar sessão"
				aria-label="Terminar sessão"
			>
				<svg viewBox="0 0 24 24" role="img" aria-hidden="true" focusable="false">
					<path d="M10 3h4a2 2 0 0 1 2 2v3h-2V5h-4v14h4v-3h2v3a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
					<path d="M20.3 12l-3.3 3.3-1.41-1.41L17.47 12.2H8v-2h9.47l-1.88-1.88L17 6.9z" />
				</svg>
			</a>
		</header>
	);
}

export default App;

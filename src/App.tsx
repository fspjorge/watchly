import { useCallback, useEffect, useRef, useState } from 'react';

import {
	checkMonitor,
	listMonitors,
	type CheckOutcome,
	type Monitor,
} from './api.ts';
import { AddMonitorForm } from './components/AddMonitorForm.tsx';
import { DiffView } from './components/DiffView.tsx';
import { MonitorCard, type MonitorFeedback } from './components/MonitorCard.tsx';
import './App.css';

type View = { kind: 'dashboard' } | { kind: 'diff'; monitorId: string };

function App() {
	const [view, setView] = useState<View>({ kind: 'dashboard' });
	const [monitors, setMonitors] = useState<Monitor[]>([]);
	const [reloadKey, setReloadKey] = useState(0);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<Record<string, MonitorFeedback>>({});
	const timers = useRef<number[]>([]);

	const clearTimers = useCallback(() => {
		for (const timer of timers.current) window.clearTimeout(timer);
		timers.current = [];
	}, []);

	// Carrega (ou recarrega) a lista apenas quando reloadKey muda;
	// todas as actualizações de estado acontecem depois do await.
	useEffect(() => {
		let active = true;
		listMonitors()
			.then((data) => {
				if (active) setMonitors(data);
			})
			.catch((cause: unknown) => {
				if (active) {
					setLoadError(
						cause instanceof Error
							? cause.message
							: 'Não foi possível carregar as monitorizações.',
					);
				}
			})
			.finally(() => {
				if (active) setLoading(false);
			});

		return () => {
			active = false;
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

	if (view.kind === 'diff') {
		return (
			<main className="app">
				<Header />
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
			<Header />

			<section className="panel card">
				<h2>Nova monitorização</h2>
				<p className="panel-hint">
					Indica um nome e o endereço da página (HTTP ou HTTPS) que pretendes vigiar.
				</p>
				<AddMonitorForm onAdded={handleAdded} />
			</section>

			<section className="panel">
				<h2>Páginas monitorizadas</h2>

				{loading && <p className="loading">A carregar…</p>}

				{loadError && (
					<p className="form-error" role="alert">
						{loadError}
					</p>
				)}

				{!loading && !loadError && monitors.length === 0 && (
					<p className="empty">Ainda não há monitorizações. Adiciona a primeira acima.</p>
				)}

				<ul className="monitor-list">
					{monitors.map((monitor) => (
						<MonitorCard
							key={monitor.id}
							monitor={monitor}
							feedback={feedback[monitor.id] ?? null}
							busy={busyId === monitor.id}
							onCheck={handleCheck}
							onShowDiff={(mon) =>
								setView({ kind: 'diff', monitorId: mon.id })
							}
						/>
					))}
				</ul>
			</section>
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
		case 'error':
			return { kind: 'error', text: message };
	}
}

function Header() {
	return (
		<header className="app-header">
			<h1 className="brand">Watchly</h1>
			<p className="app-subtitle">Vigia alterações em páginas da Internet</p>
		</header>
	);
}

export default App;

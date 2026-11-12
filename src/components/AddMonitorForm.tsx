import { useState } from 'react';

import { addMonitor, FREQUENCY_SELECT_OPTIONS } from '../api.ts';

type Props = {
	onAdded: (monitorId: string) => void;
};

export function AddMonitorForm({ onAdded }: Props) {
	const [name, setName] = useState('');
	const [url, setUrl] = useState('');
	const [frequency, setFrequency] = useState('');
	const [keywords, setKeywords] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setError(null);
		setSubmitting(true);
		try {
			const frequencyMinutes = frequency === '' ? null : Number(frequency);
			const monitor = await addMonitor(name, url, frequencyMinutes, keywords);
			setName('');
			setUrl('');
			setFrequency('');
			setKeywords('');
			onAdded(monitor.id);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Não foi possível guardar.');
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<form className="add-form" onSubmit={handleSubmit}>
			<div className="form-row">
				<label className="field">
					<span>Nome da monitorização</span>
					<input
						type="text"
						placeholder="Loja de frutas"
						value={name}
						onChange={(e) => setName(e.target.value)}
						disabled={submitting}
						maxLength={120}
						required
					/>
				</label>
				<label className="field grows">
					<span>URL</span>
					<input
						type="url"
						placeholder="https://exemplo.pt/preços"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						disabled={submitting}
						required
					/>
				</label>
				<label className="field">
					<span>Frequência</span>
					<select
						value={frequency}
						onChange={(e) => setFrequency(e.target.value)}
						disabled={submitting}
					>
						{FREQUENCY_SELECT_OPTIONS.map((option) => (
							<option key={option.value || 'manual'} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</label>
				<label className="field">
					<span>Keywords (opcional)</span>
					<textarea
						value={keywords}
						onChange={(e) => setKeywords(e.target.value)}
						disabled={submitting}
						maxLength={1000}
						rows={2}
						placeholder={'Preço\nDisponível'}
					/>
				</label>
				<button className="btn primary" type="submit" disabled={submitting}>
					{submitting ? 'A guardar…' : 'Adicionar'}
				</button>
			</div>
			{error && <p className="form-error" role="alert">{error}</p>}
		</form>
	);
}

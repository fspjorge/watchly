import { useState } from 'react';

import { updateMonitor, FREQUENCY_SELECT_OPTIONS, type Monitor } from '../api.ts';

type Props = {
	monitor: Monitor;
	onSaved: () => void;
	onCancel: () => void;
};

export function EditMonitorForm({ monitor, onSaved, onCancel }: Props) {
	const [name, setName] = useState(monitor.name);
	const [url, setUrl] = useState(monitor.url);
	const [frequency, setFrequency] = useState<string>(
		monitor.frequency_minutes === null ? '' : String(monitor.frequency_minutes),
	);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setError(null);
		setSaving(true);
		try {
			const input: { name?: string; url?: string; frequency_minutes?: number | null } = {};
			if (name !== monitor.name) input.name = name;
			if (url !== monitor.url) input.url = url;
			const frequencyValue = frequency === '' ? null : Number(frequency);
			if (frequencyValue !== monitor.frequency_minutes) {
				input.frequency_minutes = frequencyValue;
			}
			if (Object.keys(input).length === 0) {
				onCancel();
				return;
			}
			await updateMonitor(monitor.id, input);
			onSaved();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Não foi possível guardar as alterações.');
		} finally {
			setSaving(false);
		}
	};

	return (
		<form className="edit-form" onSubmit={handleSubmit}>
			<p className="edit-title">Editar monitorização</p>
			{url !== monitor.url && (
				<p className="edit-url-note">
					Ao alterar o URL, as versões antigas ficam guardadas e a nova página recebe uma
					referência inicial em branco.
				</p>
			)}
			<div className="form-row">
				<label className="field">
					<span>Nome</span>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						disabled={saving}
						maxLength={120}
						required
					/>
				</label>
				<label className="field grows">
					<span>URL</span>
					<input
						type="url"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						disabled={saving}
						required
					/>
				</label>
				<label className="field">
					<span>Frequência</span>
					<select
						value={frequency}
						onChange={(e) => setFrequency(e.target.value)}
						disabled={saving}
					>
						{FREQUENCY_SELECT_OPTIONS.map((option) => (
							<option key={option.value || 'manual'} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</label>
				<button className="btn" type="button" onClick={onCancel} disabled={saving}>
					Cancelar
				</button>
				<button className="btn primary" type="submit" disabled={saving}>
					{saving ? 'A guardar…' : 'Guardar'}
				</button>
			</div>
			{error && <p className="form-error" role="alert">{error}</p>}
		</form>
	);
}

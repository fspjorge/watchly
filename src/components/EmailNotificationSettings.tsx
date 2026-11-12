import { useState } from 'react';

type Props = {
	enabled: boolean;
	onChange: (enabled: boolean) => Promise<void>;
};

export function EmailNotificationSettings({ enabled, onChange }: Props) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const handleChange = async (value: boolean) => {
		setBusy(true);
		setError(null);
		try {
			await onChange(value);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Não foi possível guardar a preferência.');
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="panel card email-settings" id="settings">
			<h2>Notificações por e-mail</h2>
			<p className="panel-hint">Recebe uma mensagem quando uma verificação detecta alterações ou inicia um novo incidente de erro.</p>
			<label className="email-settings-toggle">
				<input
					type="checkbox"
					checked={enabled}
					disabled={busy}
					onChange={(event) => void handleChange(event.target.checked)}
				/>
				<span>Enviar-me notificações de alterações e erros</span>
			</label>
			{error && <p className="form-error" role="alert">{error}</p>}
		</section>
	);
}

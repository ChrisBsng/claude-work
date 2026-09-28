export function renderLanding(root) {
	root.innerHTML = `
		<h1>Pausen Check-In/Check-Out</h1>
		<p class="muted">Interaktive Anwesenheits- und Pausenerfassung für Kurse.</p>
		<div class="card">
			<p>Diese Seite hat für sich genommen keine Funktion. Nutze:</p>
			<ul>
				<li>den <strong>Check-in-Link</strong> bzw. QR-Code deines Kurses, um dich ein-/auszuchecken</li>
				<li>den <strong>Dashboard-Link</strong> deines Kurses, um den Live-Status zu sehen</li>
				<li>den <a href="/admin">Admin-Bereich</a>, um einen neuen Kurs anzulegen</li>
			</ul>
		</div>
	`;
}

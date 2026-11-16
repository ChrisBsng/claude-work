import { call, esc } from "/api.js";
import { bindRootDownloads, requirementsHtml, rootsHtml } from "/views/student-shared.js";

// Startseite: Überblick, Mindestanforderungen, Stammzertifikate (öffentlich) und die zwei
// getrennten Einstiege – jeweils mit eigener Seite und eigener Anmeldung.
export async function renderHome(root) {
	const roots = await call("/api/student/roots").then((r) => r.roots).catch(() => []);
	root.innerHTML = `
		<header class="page-head">
			<span class="badge-pill">Zwischenzertifikate für Klassen</span>
			<h1>Schul-<span>CA</span></h1>
			<p>Stammzertifikat herunterladen, ein Zwischenzertifikat beantragen oder den Stand eines bestehenden Antrags abrufen und verwalten.</p>
		</header>

		<div class="entry-grid">
			<section class="card entry">
				<h2>Neues Zwischenzertifikat beantragen</h2>
				<p class="muted">Du möchtest ein Zwischenzertifikat für deine Klasse? Hier reichst du deinen CSR ein.</p>
				<p class="small">Anmeldung mit <strong>Schulpasswort</strong> und Captcha.</p>
				<a class="button-link" href="/beantragen">Zum Antrag →</a>
			</section>
			<section class="card entry">
				<h2>Status prüfen, Zertifikat abrufen &amp; verwalten</h2>
				<p class="muted">Du hast bereits einen Antrag gestellt? Hier siehst du den Stand, lädst dein Zertifikat herunter und verwaltest deine Zwischenzertifizierungsstelle.</p>
				<p class="small">Anmeldung mit <strong>Abruf-Code</strong> und Captcha – kein Schulpasswort nötig.</p>
				<a class="button-link" href="/abruf">Zum Abruf →</a>
			</section>
		</div>

		${requirementsHtml()}
		${rootsHtml(roots)}`;
	bindRootDownloads(root);
}

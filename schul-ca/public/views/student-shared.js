import { call, download, esc, formatDay } from "/api.js";

export const STATUS_LABELS = {
	pending: "Wartet auf Verifikation und Freigabe",
	approved: "Freigegeben – Zertifikat wird erzeugt",
	rejected: "Abgelehnt",
	issued: "Zertifikat ausgestellt",
};

export const TOKEN_KEY = "schulCa.studentToken";
export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

// Kopf einer Unterseite mit Rücksprung zur Startseite.
export function subpageHead(badge, title, intro = "") {
	return `
		<p class="crumbs"><a href="/">← Startseite</a></p>
		<header class="page-head">
			<span class="badge-pill">${esc(badge)}</span>
			<h1>${title}</h1>
			${intro ? `<p>${intro}</p>` : ""}
		</header>`;
}

export function bindRootDownloads(root) {
	root.querySelectorAll("[data-dl]").forEach((btn) =>
		btn.addEventListener("click", () => download(`/api/student/roots/${btn.dataset.dl}/download?format=${btn.dataset.format}`).catch((e) => alert(e.message))),
	);
}

export function requirementsHtml() {
	return `
		<section class="card">
			<h2>Mindestanforderungen an den CSR</h2>
			<ul class="req">
				<li><strong>Format:</strong> PKCS#10-CSR im PEM-Format (<code>-----BEGIN CERTIFICATE REQUEST-----</code>), höchstens 16 KB.</li>
				<li><strong>Schlüssel:</strong> RSA mit mindestens <strong>2048 Bit</strong> oder EC auf der Kurve <strong>P-256, P-384 oder P-521</strong>. Andere Schlüsseltypen (z. B. Ed25519, RSA-PSS) werden abgelehnt.</li>
				<li><strong>Signatur:</strong> Der CSR muss mit dem zugehörigen privaten Schlüssel selbst signiert sein (Proof of Possession). Beschädigte oder veränderte CSRs werden abgelehnt.</li>
				<li><strong>Common Name:</strong> Der CSR muss einen <code>CN</code> enthalten, der die Klasse eindeutig bezeichnet (z. B. <code>FI-25a</code>).</li>
				<li><strong>Private Key:</strong> bleibt bei euch – es wird nur der CSR hochgeladen, <strong>niemals</strong> die <code>.key</code>-Datei.</li>
				<li><strong>Inhalt des Zertifikats:</strong> Der öffentliche Schlüssel kommt aus dem CSR. Organisation, Land usw. sowie alle Erweiterungen (CA-Zertifikat, Pfadlänge, Namensbeschränkungen, Laufzeit) legt die Schule per Vorlage fest; im CSR angeforderte Erweiterungen werden ignoriert.</li>
				<li><strong>Zugang:</strong> Zum <em>Beantragen</em> brauchst du das Schulpasswort. Zum späteren <em>Abrufen, Prüfen und Verwalten</em> genügt der Abruf-Code, den du beim Beantragen erhältst.</li>
				<li><strong>Kontaktangaben (Pflicht):</strong> Beim Einreichen sind <strong>Kontaktperson</strong> und ein <strong>Kontaktweg</strong> (E-Mail, Teams oder Telefon) anzugeben. Darüber meldet sich die Administration zur Verifikation.</li>
				<li><strong>Freigabe:</strong> Jeder CSR wird von der Administration geprüft und kann mit Begründung abgelehnt werden.</li>
			</ul>
		</section>`;
}

export function rootsHtml(roots) {
	const list = roots.length
		? roots
				.map(
					(r) => `<div class="root-item">
				<div>
					<strong>${esc(r.name)}</strong>
					<div class="muted small">${esc(r.subject)}</div>
					<div class="muted small">${esc(r.keyAlgorithm)} · gültig bis ${esc(formatDay(r.notAfter))}</div>
					<div class="muted small mono">SHA-256: ${esc(r.fingerprint)}</div>
				</div>
				<div class="actions">
					<button class="secondary" data-dl="${r.id}" data-format="crt">.crt</button>
					<button class="secondary" data-dl="${r.id}" data-format="pem">.pem</button>
					<button class="secondary" data-dl="${r.id}" data-format="der">.cer (DER)</button>
				</div>
			</div>`,
				)
				.join("")
		: `<p class="muted">Aktuell ist kein Stammzertifikat verfügbar.</p>`;
	return `<section class="card"><h2>Stammzertifikate herunterladen</h2>${list}</section>`;
}


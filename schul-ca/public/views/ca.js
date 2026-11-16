import { call, download, esc, formatDay } from "/api.js";
import { mountCaptcha } from "/captcha.js";
import { caBase, renderCertTable } from "/views/ca-shared.js";

// Klassen-Seite /ca/<Token>: öffentlich, ohne Anmeldung. Nur Downloads, Tabelle und neue Anfragen.
// Die Verwaltung (Inhaber) liegt bewusst auf einer eigenen Seite: /ca/<Token>/verwalten.
export async function renderCa(root, token) {
	const base = caBase(token);
	let data;
	try {
		data = await call(base);
	} catch (e) {
		root.innerHTML = `<header class="page-head"><span class="badge-pill">Zwischenzertifizierungsstelle</span><h1>Nicht <span>gefunden</span></h1><p>${esc(e.message)}</p></header>
			<p style="text-align:center"><a href="/">Zur Startseite</a></p>`;
		return;
	}

	const permitted = data.permittedDns.length ? data.permittedDns.map((d) => `<code>${esc(d)}</code>`).join(" ") : "keine Einschränkung";
	root.innerHTML = `
		<p class="crumbs"><a href="/">← Startseite</a></p>
		<header class="page-head">
			<span class="badge-pill">Zwischenzertifizierungsstelle</span>
			<h1>${esc(data.name)}</h1>
			<p class="mono small">${esc(data.subject)}</p>
		</header>

		<section class="card">
			<h2>Zwischenzertifikat</h2>
			<dl>
				<dt>Gültig</dt><dd>${esc(formatDay(data.notBefore))} – ${esc(formatDay(data.notAfter))}</dd>
				<dt>Seriennummer</dt><dd class="mono small">${esc(data.serialNumber)}</dd>
				<dt>Stammzertifikat</dt><dd>${esc(data.rootName)}</dd>
				<dt>Erlaubte Domains</dt><dd>${permitted}</dd>
			</dl>
			<div class="actions">
				<button data-ca="pem">Zwischenzertifikat (.pem)</button>
				<button class="secondary" data-ca="chain">Kette mit Root (.pem)</button>
				<button class="secondary" data-ca="der">DER (.cer)</button>
			</div>
		</section>

		<section class="card">
			<h2>Zertifikate dieser Zwischenzertifizierungsstelle</h2>
			<div id="certTable"></div>
		</section>

		<section class="card">
			<h2>Neues Zertifikat anfordern</h2>
			<p class="notice">Jede Anfrage wird vom Inhaber dieser Zwischenzertifizierungsstelle geprüft und freigegeben. Erst danach erscheint das Zertifikat oben in der Tabelle zum Download.</p>
			<nav class="tabs" id="reqTabs">
				<button data-rt="quick" class="active">Quick-Zertifikat</button>
				<button data-rt="csr">Eigenen CSR einreichen</button>
			</nav>

			<form id="quickForm" autocomplete="off">
				<p class="muted small">Der Schlüssel und der CSR werden hier für dich erzeugt (EC P-256). Du kannst den <strong>privaten Schlüssel nur ein einziges Mal</strong> herunterladen – er wird nicht gespeichert.</p>
				<div class="grid">
					<label>Common Name (CN) *<input name="cn" required maxlength="64" placeholder="web.klasse.example" /></label>
					<label>E-Mail (E) *<input name="email" type="email" required maxlength="120" placeholder="vorname.nachname@schule.example" /></label>
				</div>
				<label>SAN – Hostnamen / IPs / E-Mail (kommagetrennt) *<input name="san" required placeholder="web.klasse.example, 192.0.2.10" /></label>
				<label>Dein Name (für den Inhaber)<input name="requester" maxlength="80" /></label>
				<p class="fixed-ou">Abteilung (OU): <strong>${esc(data.fixedOu)}</strong> <span class="muted small">– fest aus dem Zwischenzertifikat übernommen, wird nicht abgefragt.</span></p>
				<p class="muted small">Die E-Mail-Adresse ist Pflicht: Der Inhaber der Zwischenzertifizierungsstelle muss dich als Antragsteller identifizieren können. Organisation, Land und Ort werden automatisch aus dem Zwischenzertifikat übernommen.</p>
				<div data-captcha></div>
				<p class="error" data-error role="alert"></p>
				<button type="submit">Quick-Zertifikat anfordern</button>
			</form>

			<form id="csrForm" hidden>
				<label>CSR (PEM) – einfügen oder Datei wählen
					<textarea name="csr" rows="7" required spellcheck="false" placeholder="-----BEGIN CERTIFICATE REQUEST-----"></textarea>
				</label>
				<input type="file" id="csrFile" accept=".csr,.pem,.txt,.req" />
				<div class="grid">
					<label>E-Mail (E) *<input name="email" type="email" required maxlength="120" placeholder="vorname.nachname@schule.example" /></label>
					<label>Dein Name (für den Inhaber)<input name="requester" maxlength="80" /></label>
				</div>
				<p class="fixed-ou">Abteilung (OU): <strong>${esc(data.fixedOu)}</strong> <span class="muted small">– fest aus dem Zwischenzertifikat übernommen, wird nicht abgefragt.</span></p>
				<p class="muted small">Die E-Mail-Adresse ist Pflicht (Identifizierung des Antragstellers). Organisation, Land und Ort werden aus dem Zwischenzertifikat übernommen. Eine im CSR enthaltene OU wird ignoriert. SAN-Einträge werden aus dem CSR übernommen und vom Inhaber geprüft. Nur den CSR hochladen, <strong>niemals den Private Key</strong>.</p>
				<div data-captcha></div>
				<p class="error" data-error role="alert"></p>
				<button type="submit">CSR einreichen</button>
			</form>
			<div id="quickResult"></div>
		</section>

<p class="owner-link small muted">Du bist Inhaber dieser Zwischenzertifizierungsstelle? <a href="/ca/${esc(token)}/verwalten">Zur Verwaltung →</a></p>`;

	// ---- Downloads Zwischenzertifikat
	root.querySelectorAll("[data-ca]").forEach((b) =>
		b.addEventListener("click", () => download(`${base}/ca-certificate?format=${b.dataset.ca}`).catch((e) => alert(e.message))),
	);

	// ---- Tabelle
	const refreshPublic = async () => {
		data = await call(base);
		renderCertTable(root.querySelector("#certTable"), data.certificates, { base });
	};
	renderCertTable(root.querySelector("#certTable"), data.certificates, { base });

	// ---- Anfrage-Formulare
	const quickForm = root.querySelector("#quickForm");
	const csrForm = root.querySelector("#csrForm");
	const captchas = { quick: mountCaptcha(quickForm.querySelector("[data-captcha]")), csr: mountCaptcha(csrForm.querySelector("[data-captcha]")) };
	root.querySelectorAll("[data-rt]").forEach((b) =>
		b.addEventListener("click", () => {
			root.querySelectorAll("[data-rt]").forEach((x) => x.classList.toggle("active", x === b));
			quickForm.hidden = b.dataset.rt !== "quick";
			csrForm.hidden = b.dataset.rt !== "csr";
		}),
	);
	csrForm.querySelector("#csrFile").addEventListener("change", async (e) => {
		const f = e.target.files[0];
		if (f && f.size <= 16 * 1024) csrForm.csr.value = await f.text();
	});

	quickForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const err = quickForm.querySelector("[data-error]");
		err.textContent = "";
		try {
			const res = await call(`${base}/quick`, {
				method: "POST",
				body: { cn: quickForm.cn.value, san: quickForm.san.value, email: quickForm.email.value, requester: quickForm.requester.value, ...captchas.quick.values() },
			});
			showQuickResult(root.querySelector("#quickResult"), res, quickForm.cn.value);
			quickForm.reset();
			quickForm.hidden = true;
			root.querySelector("#reqTabs").hidden = true;
			await refreshPublic();
		} catch (e) {
			err.textContent = e.message;
		}
		captchas.quick.reload();
	});

	csrForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const err = csrForm.querySelector("[data-error]");
		err.textContent = "";
		try {
			await call(`${base}/requests`, { method: "POST", body: { csrPem: csrForm.csr.value, email: csrForm.email.value, requester: csrForm.requester.value, ...captchas.csr.values() } });
			csrForm.reset();
			err.innerHTML = `<span class="ok">CSR eingereicht. Der Inhaber prüft die Anfrage – danach erscheint das Zertifikat in der Tabelle.</span>`;
			await refreshPublic();
		} catch (e) {
			err.textContent = e.message;
		}
		captchas.csr.reload();
	});
}

// Bestätigungsmaske des Quick-Zertifikats: Der Private Key liegt nur hier im Speicher.
function showQuickResult(host, res, cn) {
	let key = res.privateKeyPem;
	host.innerHTML = `
		<div class="code-box">
			<p><strong>Quick-Anfrage eingereicht.</strong> Dein privater Schlüssel für <code>${esc(cn)}</code> wurde erzeugt.</p>
			<p class="notice" style="border-left-color:var(--color-warn)">⚠️ Der private Schlüssel wird <strong>nicht auf dem Server gespeichert</strong> und kann <strong>nur jetzt einmal</strong> heruntergeladen werden. Ohne ihn ist das spätere Zertifikat nicht nutzbar. Das Zertifikat erscheint nach der Freigabe in der Tabelle oben.</p>
			<p class="muted small">SAN: ${esc(res.san)} · Schlüssel: ${esc(res.keyInfo)}</p>
			<div class="actions">
				<button id="keyDl">Privaten Schlüssel herunterladen</button>
				<button class="secondary" id="keyClose" hidden>Schließen</button>
			</div>
			<p class="ok" id="keyDone"></p>
		</div>`;
	host.querySelector("#keyDl").addEventListener("click", (e) => {
		if (!key) return;
		const url = URL.createObjectURL(new Blob([key], { type: "application/x-pem-file" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `${cn.replace(/[^A-Za-z0-9._-]+/g, "_") || "quick"}.key`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 5000);
		e.target.disabled = true;
		e.target.textContent = "Heruntergeladen";
		host.querySelector("#keyDone").textContent = "Der Schlüssel wurde heruntergeladen. Bitte sicher aufbewahren – ein erneuter Abruf ist nicht möglich.";
		host.querySelector("#keyClose").hidden = false;
	});
	host.querySelector("#keyClose").addEventListener("click", () => {
		key = null; // Schlüssel aus dem Speicher entfernen
		res.privateKeyPem = null;
		host.innerHTML = "";
		const tabs = document.querySelector("#reqTabs");
		if (tabs) tabs.hidden = false;
		const f = document.querySelector("#quickForm");
		if (f) f.hidden = false;
	});
}

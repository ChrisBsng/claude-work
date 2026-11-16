import { call, download, esc, formatDay, formatDate } from "/api.js";

const TOKEN_KEY = "schulCa.studentToken";
const STATUS_LABELS = {
	pending: "Wartet auf Verifikation und Freigabe",
	approved: "Freigegeben – Zertifikat wird erzeugt",
	rejected: "Abgelehnt",
	issued: "Zertifikat ausgestellt",
};

const getToken = () => sessionStorage.getItem(TOKEN_KEY);
const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

// Seite = öffentlicher Teil (Anforderungen, Root-Downloads) + geschützter Teil
// (CSR-Upload, Abruf), der erst nach Passwort + Captcha erscheint.
export async function renderStudent(root) {
	let loggedIn = false;
	if (getToken()) {
		try {
			await call("/api/student/session", { token: getToken() });
			loggedIn = true;
		} catch {
			clearToken();
		}
	}
	const [roots, info] = await Promise.all([
		call("/api/student/roots").then((r) => r.roots).catch(() => []),
		call("/api/student/public").catch(() => ({ passwordHint: "", enabled: false })),
	]);

	root.innerHTML = `
		<header class="page-head">
			<span class="badge-pill">Zwischenzertifikate für Klassen</span>
			<h1>Schul-<span>CA</span></h1>
			<p>Stammzertifikat herunterladen, Zertifikatsanforderung (CSR) einreichen und das Zwischenzertifikat deiner Klasse abrufen.</p>
			${loggedIn ? `<p><button class="secondary" id="logout">Abmelden</button></p>` : ""}
		</header>
		${requirementsHtml()}
		${rootsHtml(roots)}
		<div id="protected"></div>`;

	root.querySelector("#logout")?.addEventListener("click", () => {
		clearToken();
		renderStudent(root);
	});
	root.querySelectorAll("[data-dl]").forEach((btn) =>
		btn.addEventListener("click", () => download(`/api/student/roots/${btn.dataset.dl}/download?format=${btn.dataset.format}`).catch((e) => alert(e.message))),
	);

	const box = root.querySelector("#protected");
	if (loggedIn) renderPortal(root, box, roots);
	else renderLogin(root, box, info);
}

function requirementsHtml() {
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
				<li><strong>Kontaktangaben (Pflicht):</strong> Beim Einreichen sind <strong>Kontaktperson</strong> und ein <strong>Kontaktweg</strong> (E-Mail, Teams oder Telefon) anzugeben. Darüber meldet sich die Administration zur Verifikation.</li>
				<li><strong>Freigabe:</strong> Jeder CSR wird von der Administration geprüft und kann mit Begründung abgelehnt werden.</li>
			</ul>
		</section>`;
}

function rootsHtml(roots) {
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

async function renderLogin(root, box, info) {
	box.innerHTML = `
		<section class="card narrow">
			<h2>CSR einreichen &amp; Zertifikat abrufen</h2>
			${
				info.enabled
					? `<p class="muted small">Dafür bitte mit dem Schulpasswort anmelden.</p>
			<form id="login" autocomplete="off">
				<label>Anmeldepasswort
					<input type="password" name="password" required />
				</label>
				${info.passwordHint ? `<p class="hint">💡 ${esc(info.passwordHint)}</p>` : ""}
				<div class="captcha-row">
					<div id="captcha" class="captcha" aria-live="polite">…</div>
					<button type="button" class="secondary" id="reload" title="Neues Captcha">↻</button>
				</div>
				<label>Zeichen aus dem Bild
					<input type="text" name="captcha" required autocomplete="off" autocapitalize="characters" maxlength="8" />
				</label>
				<p class="error" id="error" role="alert"></p>
				<button type="submit">Anmelden</button>
			</form>`
					: `<p>Der Bereich zum Einreichen ist noch nicht freigeschaltet. Bitte wende dich an die Administration.</p>`
			}
		</section>`;
	if (!info.enabled) return;

	let captchaToken = "";
	const loadCaptcha = async () => {
		const c = box.querySelector("#captcha");
		try {
			const res = await call("/api/student/captcha");
			captchaToken = res.token;
			c.innerHTML = res.svg;
		} catch (e) {
			c.textContent = e.message;
		}
		box.querySelector('[name="captcha"]').value = "";
	};
	box.querySelector("#reload").addEventListener("click", loadCaptcha);
	loadCaptcha();

	box.querySelector("#login").addEventListener("submit", async (event) => {
		event.preventDefault();
		const form = event.currentTarget;
		const err = box.querySelector("#error");
		err.textContent = "";
		try {
			const { token } = await call("/api/student/login", {
				method: "POST",
				body: { password: form.password.value, captchaToken, captchaAnswer: form.captcha.value },
			});
			sessionStorage.setItem(TOKEN_KEY, token);
			renderStudent(root);
		} catch (e) {
			err.textContent = e.message;
			form.password.select();
			loadCaptcha();
		}
	});
}

function renderPortal(root, box, roots) {
	const token = getToken();
	const onAuthError = (e) => {
		if (e.status === 401) {
			clearToken();
			renderStudent(root);
			return true;
		}
		return false;
	};

	box.innerHTML = `
		<section class="card">
			<h2>CSR hochladen</h2>
			<details class="help">
				<summary>Wie erzeuge ich einen CSR?</summary>
				<p>Mit OpenSSL (der Schlüssel bleibt bei dir):</p>
				<pre>openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \\
  -keyout klasse.key -out klasse.csr -subj "/CN=Klasse FI-25"</pre>
			</details>
			<form id="upload">
				<label>Stammzertifikat, von dem ausgestellt werden soll
					<select name="rootId" required>${roots.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</select>
				</label>
				<label>Klasse / Bezeichnung
					<input type="text" name="label" required maxlength="80" placeholder="z. B. FI-25a" />
				</label>
				<fieldset class="contact">
					<legend>Kontakt für die Verifikation (Pflicht)</legend>
					<p class="notice">ℹ️ Bevor ein Zwischenzertifikat ausgestellt wird, <strong>prüft die Administration die Anfrage</strong> und nimmt dazu über den angegebenen Kontaktweg Kontakt mit der Kontaktperson auf. Bitte nur Angaben machen, unter denen die Person in der Schulzeit erreichbar ist. Ohne erfolgreiche Verifikation wird kein Zertifikat ausgestellt. Die Daten werden ausschließlich für diese Prüfung verwendet.</p>
					<label>Kontaktperson (Vor- und Nachname)
						<input type="text" name="contactPerson" required minlength="2" maxlength="80" autocomplete="name" placeholder="z. B. Max Mustermann" />
					</label>
					<div class="grid">
						<label>Kontaktweg
							<select name="contactMethod" required>
								<option value="">– wählen –</option>
								<option value="email">E-Mail</option>
								<option value="teams">Microsoft Teams</option>
								<option value="phone">Telefon</option>
							</select>
						</label>
						<label><span id="contactDetailLabel">Kontaktangabe</span>
							<input type="text" name="contactDetail" required minlength="3" maxlength="120" placeholder="zuerst Kontaktweg wählen" />
						</label>
					</div>
				</fieldset>
				<label>CSR (PEM) – einfügen oder Datei wählen
					<textarea name="csr" rows="8" required placeholder="-----BEGIN CERTIFICATE REQUEST-----" spellcheck="false"></textarea>
				</label>
				<input type="file" id="csrFile" accept=".csr,.pem,.txt,.req" />
				<p class="error" id="uploadError" role="alert"></p>
				<button type="submit" ${roots.length ? "" : "disabled"}>CSR einreichen</button>
			</form>
			<div id="codeBox" hidden></div>
		</section>

		<section class="card">
			<h2>Status prüfen &amp; Zertifikat abrufen</h2>
			<form id="lookup" class="inline-form">
				<input type="text" name="code" required placeholder="Abruf-Code, z. B. K7QM-4TXD-9WPB-2HNC" autocomplete="off" autocapitalize="characters" />
				<button type="submit">Status prüfen</button>
			</form>
			<p class="error" id="lookupError" role="alert"></p>
			<div id="lookupResult"></div>
		</section>`;

	const contactForm = box.querySelector("#upload");
	const CONTACT_HINTS = {
		email: ["E-Mail-Adresse", "vorname.nachname@schule.example", "email"],
		teams: ["Teams-Name oder -Adresse", "z. B. Name in Teams oder Teams-Adresse", "text"],
		phone: ["Telefonnummer", "z. B. 0123 456789", "tel"],
	};
	contactForm.contactMethod.addEventListener("change", () => {
		const [label, placeholder, type] = CONTACT_HINTS[contactForm.contactMethod.value] ?? ["Kontaktangabe", "zuerst Kontaktweg wählen", "text"];
		box.querySelector("#contactDetailLabel").textContent = label;
		contactForm.contactDetail.placeholder = placeholder;
		contactForm.contactDetail.type = type;
	});

	box.querySelector("#csrFile").addEventListener("change", async (event) => {
		const file = event.target.files[0];
		if (!file) return;
		if (file.size > 16 * 1024) {
			box.querySelector("#uploadError").textContent = "Die Datei ist zu groß – ist das wirklich ein CSR?";
			return;
		}
		box.querySelector('[name="csr"]').value = await file.text();
	});

	box.querySelector("#upload").addEventListener("submit", async (event) => {
		event.preventDefault();
		const form = event.currentTarget;
		const err = box.querySelector("#uploadError");
		err.textContent = "";
		if (/PRIVATE KEY/.test(form.csr.value)) {
			err.textContent = "Das sieht nach einem Private Key aus! Bitte nur den CSR (BEGIN CERTIFICATE REQUEST) einreichen.";
			return;
		}
		try {
			const result = await call("/api/student/csrs", {
				method: "POST",
				token,
				body: {
					rootId: Number(form.rootId.value),
					label: form.label.value,
					csrPem: form.csr.value,
					contactPerson: form.contactPerson.value,
					contactMethod: form.contactMethod.value,
					contactDetail: form.contactDetail.value,
				},
			});
			form.reset();
			form.contactMethod.dispatchEvent(new Event("change"));
			const codeBox = box.querySelector("#codeBox");
			codeBox.hidden = false;
			codeBox.innerHTML = `
				<div class="code-box">
					<p><strong>CSR eingereicht.</strong> Dein Abruf-Code (wird nur jetzt einmalig angezeigt – bitte notieren!):</p>
					<div class="code mono">${esc(result.code)}</div>
					<p class="muted small">${esc(result.subject)} · ${esc(result.keyInfo)}</p>
					<p class="notice">Die Administration verifiziert deine Anfrage nun über den angegebenen Kontaktweg. Danach wird das Zertifikat ausgestellt.</p>
					<button class="secondary" id="copyCode">Code kopieren</button>
				</div>`;
			codeBox.querySelector("#copyCode").addEventListener("click", async (e) => {
				try {
					await navigator.clipboard.writeText(result.code);
					e.target.textContent = "Kopiert!";
				} catch {
					// Zwischenablage nicht verfügbar – Code steht als Text da.
				}
			});
			box.querySelector('#lookup [name="code"]').value = result.code;
		} catch (e) {
			if (!onAuthError(e)) err.textContent = e.message;
		}
	});

	box.querySelector("#lookup").addEventListener("submit", async (event) => {
		event.preventDefault();
		const code = event.currentTarget.code.value;
		const err = box.querySelector("#lookupError");
		const out = box.querySelector("#lookupResult");
		err.textContent = "";
		out.innerHTML = "";
		try {
			const r = await call("/api/student/csrs/lookup", { method: "POST", token, body: { code } });
			out.innerHTML = `
				<div class="status status-${esc(r.status)}">${esc(STATUS_LABELS[r.status] ?? r.status)}</div>
				${r.status === "rejected" ? `<div class="reject-note"><strong>Grund der Ablehnung:</strong> ${esc(r.rejectReason || "(keine Begründung angegeben)")}<br><span class="muted small">Du kannst einen korrigierten CSR erneut einreichen.</span></div>` : ""}
				<dl>
					<dt>Bezeichnung</dt><dd>${esc(r.label)}</dd>
					<dt>Stammzertifikat</dt><dd>${esc(r.rootName)}</dd>
					<dt>Eingereicht</dt><dd>${esc(formatDate(r.submittedAt))}</dd>
					${r.status === "issued" ? `<dt>Gültig bis</dt><dd>${esc(formatDay(r.notAfter))}</dd>` : ""}
				</dl>
				${
					r.status === "issued"
						? `<div class="actions">
							<button data-cert="chain">Zertifikatskette (.pem)</button>
							<button class="secondary" data-cert="pem">Nur Zertifikat (.pem)</button>
							<button class="secondary" data-cert="der">DER (.cer)</button>
						</div>`
						: ""
				}`;
			out.querySelectorAll("[data-cert]").forEach((btn) =>
				btn.addEventListener("click", () =>
					download("/api/student/csrs/certificate", { method: "POST", token, body: { code, format: btn.dataset.cert } }).catch((e) => alert(e.message)),
				),
			);
		} catch (e) {
			if (!onAuthError(e)) err.textContent = e.message;
		}
	});
}

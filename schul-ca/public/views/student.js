import { call, download, esc, formatDay, formatDate } from "/api.js";

const TOKEN_KEY = "schulCa.studentToken";
const STATUS_LABELS = {
	pending: "Wartet auf Freigabe",
	approved: "Freigegeben – Zertifikat wird erzeugt",
	rejected: "Abgelehnt",
	issued: "Zertifikat ausgestellt",
};

const getToken = () => sessionStorage.getItem(TOKEN_KEY);
const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

export async function renderStudent(root) {
	if (getToken()) {
		try {
			await call("/api/student/roots", { token: getToken() });
			return renderPortal(root);
		} catch {
			clearToken();
		}
	}
	renderLogin(root);
}

async function renderLogin(root) {
	const info = await call("/api/student/public").catch(() => ({ passwordHint: "", enabled: false }));
	root.innerHTML = `
		<h1>Schul-CA</h1>
		<p class="muted">Zwischenzertifikate für Klassen</p>
		<div class="card narrow">
			${
				info.enabled
					? `<form id="login" autocomplete="off">
				<label>Anmeldepasswort
					<input type="password" name="password" required autofocus />
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
					: `<p>Diese Seite ist noch nicht freigeschaltet. Bitte wende dich an die Administration.</p>`
			}
		</div>
		<p class="footer"><a href="/admin">Administration</a></p>`;
	if (!info.enabled) return;

	let captchaToken = "";
	const loadCaptcha = async () => {
		const box = root.querySelector("#captcha");
		try {
			const c = await call("/api/student/captcha");
			captchaToken = c.token;
			box.innerHTML = c.svg;
		} catch (e) {
			box.textContent = e.message;
		}
		const input = root.querySelector('[name="captcha"]');
		if (input) input.value = "";
	};
	root.querySelector("#reload").addEventListener("click", loadCaptcha);
	loadCaptcha();

	root.querySelector("#login").addEventListener("submit", async (event) => {
		event.preventDefault();
		const form = event.currentTarget;
		const err = root.querySelector("#error");
		err.textContent = "";
		try {
			const { token } = await call("/api/student/login", {
				method: "POST",
				body: { password: form.password.value, captchaToken, captchaAnswer: form.captcha.value },
			});
			sessionStorage.setItem(TOKEN_KEY, token);
			renderPortal(root);
		} catch (e) {
			err.textContent = e.message;
			form.password.select();
			loadCaptcha();
		}
	});
}

async function renderPortal(root) {
	const token = getToken();
	let roots = [];
	try {
		roots = (await call("/api/student/roots", { token })).roots;
	} catch (e) {
		clearToken();
		return renderLogin(root);
	}

	const rootList = roots.length
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

	root.innerHTML = `
		<div class="topbar"><h1>Schul-CA</h1><button class="secondary" id="logout">Abmelden</button></div>

		<section class="card">
			<h2>1 · Stammzertifikat herunterladen</h2>
			${rootList}
		</section>

		<section class="card">
			<h2>2 · CSR hochladen</h2>
			<details class="help">
				<summary>Wie erzeuge ich einen CSR?</summary>
				<p>Mit OpenSSL (Schlüssel bleibt bei dir – nur den CSR hochladen, <strong>niemals den .key</strong>):</p>
				<pre>openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \\
  -keyout klasse.key -out klasse.csr -subj "/CN=Klasse FI-25"</pre>
				<p class="muted small">Erlaubt sind RSA ab 2048 Bit und EC (P-256/P-384/P-521). Gewünschte Felder wie Organisation legt die Administration per Template fest.</p>
			</details>
			<form id="upload">
				<label>Stammzertifikat, von dem ausgestellt werden soll
					<select name="rootId" required>${roots.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</select>
				</label>
				<label>Klasse / Bezeichnung
					<input type="text" name="label" required maxlength="80" placeholder="z. B. FI-25a" />
				</label>
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
			<h2>3 · Zertifikat abrufen</h2>
			<form id="lookup" class="inline-form">
				<input type="text" name="code" required placeholder="Abruf-Code, z. B. K7QM-4TXD-9WPB-2HNC" autocomplete="off" autocapitalize="characters" />
				<button type="submit">Status prüfen</button>
			</form>
			<p class="error" id="lookupError" role="alert"></p>
			<div id="lookupResult"></div>
		</section>`;

	root.querySelector("#logout").addEventListener("click", () => {
		clearToken();
		renderLogin(root);
	});

	const onAuthError = (e) => {
		if (e.status === 401) {
			clearToken();
			renderLogin(root);
			return true;
		}
		return false;
	};

	root.querySelectorAll("[data-dl]").forEach((btn) =>
		btn.addEventListener("click", () =>
			download(`/api/student/roots/${btn.dataset.dl}/download?format=${btn.dataset.format}`, { token }).catch((e) => !onAuthError(e) && alert(e.message)),
		),
	);

	root.querySelector("#csrFile").addEventListener("change", async (event) => {
		const file = event.target.files[0];
		if (!file) return;
		if (file.size > 16 * 1024) {
			root.querySelector("#uploadError").textContent = "Die Datei ist zu groß – ist das wirklich ein CSR?";
			return;
		}
		root.querySelector('[name="csr"]').value = await file.text();
	});

	root.querySelector("#upload").addEventListener("submit", async (event) => {
		event.preventDefault();
		const form = event.currentTarget;
		const err = root.querySelector("#uploadError");
		err.textContent = "";
		if (/PRIVATE KEY/.test(form.csr.value)) {
			err.textContent = "Das sieht nach einem Private Key aus! Bitte nur den CSR (BEGIN CERTIFICATE REQUEST) einreichen.";
			return;
		}
		try {
			const result = await call("/api/student/csrs", {
				method: "POST",
				token,
				body: { rootId: Number(form.rootId.value), label: form.label.value, csrPem: form.csr.value },
			});
			form.reset();
			const box = root.querySelector("#codeBox");
			box.hidden = false;
			box.innerHTML = `
				<div class="code-box">
					<p><strong>CSR eingereicht.</strong> Dein Abruf-Code (wird nur jetzt einmalig angezeigt – bitte notieren!):</p>
					<div class="code mono" id="theCode">${esc(result.code)}</div>
					<p class="muted small">${esc(result.subject)} · ${esc(result.keyInfo)}</p>
					<button class="secondary" id="copyCode">Code kopieren</button>
				</div>`;
			box.querySelector("#copyCode").addEventListener("click", async (e) => {
				try {
					await navigator.clipboard.writeText(result.code);
					e.target.textContent = "Kopiert!";
				} catch {
					// Zwischenablage nicht verfügbar – Code steht als Text da.
				}
			});
			root.querySelector('#lookup [name="code"]').value = result.code;
		} catch (e) {
			if (!onAuthError(e)) err.textContent = e.message;
		}
	});

	root.querySelector("#lookup").addEventListener("submit", async (event) => {
		event.preventDefault();
		const code = event.currentTarget.code.value;
		const err = root.querySelector("#lookupError");
		const out = root.querySelector("#lookupResult");
		err.textContent = "";
		out.innerHTML = "";
		try {
			const r = await call("/api/student/csrs/lookup", { method: "POST", token, body: { code } });
			out.innerHTML = `
				<div class="status status-${esc(r.status)}">${esc(STATUS_LABELS[r.status] ?? r.status)}</div>
				<dl>
					<dt>Bezeichnung</dt><dd>${esc(r.label)}</dd>
					<dt>Stammzertifikat</dt><dd>${esc(r.rootName)}</dd>
					<dt>Eingereicht</dt><dd>${esc(formatDate(r.submittedAt))}</dd>
					${r.status === "issued" ? `<dt>Gültig bis</dt><dd>${esc(formatDay(r.notAfter))}</dd>` : ""}
					${r.rejectReason ? `<dt>Begründung</dt><dd>${esc(r.rejectReason)}</dd>` : ""}
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

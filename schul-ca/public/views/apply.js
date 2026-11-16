import { call, esc } from "/api.js";
import { mountCaptcha } from "/captcha.js";
import { clearToken, getToken, requirementsHtml, rootsHtml, subpageHead, TOKEN_KEY } from "/views/student-shared.js";

// Seite /beantragen: Schulpasswort + Captcha, danach CSR-Upload.
export async function renderApplyPage(root) {
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
		${subpageHead("Neues Zwischenzertifikat", "Zwischenzertifikat <span>beantragen</span>", loggedIn ? "Reiche deinen CSR ein. Die Administration prüft und gibt ihn frei." : "")}
		${loggedIn ? requirementsHtml() : ""}
		<section class="card" id="apply"></section>`;
	const box = root.querySelector("#apply");
	if (loggedIn) renderApplyForm(root, box, roots);
	else renderApplyLogin(root, box, info);
}


async function renderApplyForm(root, box, roots) {

	const onAuthError = (e) => {
		if (e.status === 401) {
			clearToken();
			renderApplyPage(root);
			return true;
		}
		return false;
	};
	const token = getToken();

	box.innerHTML = `
		<div class="card-head"><h2>CSR einreichen</h2><button class="secondary" id="logout">Abmelden</button></div>
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
		<div id="codeBox" hidden></div>`;

	box.querySelector("#logout").addEventListener("click", () => {
		clearToken();
		renderApplyPage(root);
	});

	const form = box.querySelector("#upload");
	const CONTACT_HINTS = {
		email: ["E-Mail-Adresse", "vorname.nachname@schule.example", "email"],
		teams: ["Teams-Name oder -Adresse", "z. B. Name in Teams oder Teams-Adresse", "text"],
		phone: ["Telefonnummer", "z. B. 0123 456789", "tel"],
	};
	form.contactMethod.addEventListener("change", () => {
		const [label, placeholder, type] = CONTACT_HINTS[form.contactMethod.value] ?? ["Kontaktangabe", "zuerst Kontaktweg wählen", "text"];
		box.querySelector("#contactDetailLabel").textContent = label;
		form.contactDetail.placeholder = placeholder;
		form.contactDetail.type = type;
	});

	box.querySelector("#csrFile").addEventListener("change", async (event) => {
		const file = event.target.files[0];
		if (!file) return;
		if (file.size > 16 * 1024) {
			box.querySelector("#uploadError").textContent = "Die Datei ist zu groß – ist das wirklich ein CSR?";
			return;
		}
		form.csr.value = await file.text();
	});

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
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
					<p class="notice">Die Administration verifiziert deine Anfrage nun über den angegebenen Kontaktweg. Danach wird das Zertifikat ausgestellt. Den Stand siehst du auf der Seite „Status prüfen" mit diesem Code (zusammen mit einem Captcha, ohne Schulpasswort).</p>
					<div class="actions"><button class="secondary" id="copyCode">Code kopieren</button><a class="button-link" href="/abruf">Zum Abruf →</a></div>
				</div>`;
			codeBox.querySelector("#copyCode").addEventListener("click", async (e) => {
				try {
					await navigator.clipboard.writeText(result.code);
					e.target.textContent = "Kopiert!";
				} catch {
					// Zwischenablage nicht verfügbar – Code steht als Text da.
				}
			});
		} catch (e) {
			if (!onAuthError(e)) err.textContent = e.message;
		}
	});
}

async function renderApplyLogin(root, box, info) {
	box.innerHTML = `
		<h2>Anmeldung</h2>
		${
			info.enabled
				? `<p class="muted small">Zum Beantragen bitte mit dem Schulpasswort anmelden.</p>
		<form id="login" autocomplete="off" class="narrow-form">
			<label>Anmeldepasswort
				<input type="password" name="password" required />
			</label>
			${info.passwordHint ? `<p class="hint">💡 ${esc(info.passwordHint)}</p>` : ""}
			<div data-captcha></div>
			<p class="error" id="error" role="alert"></p>
			<button type="submit">Anmelden</button>
		</form>`
				: `<p>Das Beantragen ist noch nicht freigeschaltet. Bitte wende dich an die Administration.</p>`
		}`;
	if (!info.enabled) return;

	const captcha = mountCaptcha(box.querySelector("[data-captcha]"));
	box.querySelector("#login").addEventListener("submit", async (event) => {
		event.preventDefault();
		const form = event.currentTarget;
		const err = box.querySelector("#error");
		err.textContent = "";
		try {
			const { token } = await call("/api/student/login", { method: "POST", body: { password: form.password.value, ...captcha.values() } });
			sessionStorage.setItem(TOKEN_KEY, token);
			renderApplyPage(root);
		} catch (e) {
			err.textContent = e.message;
			form.password.select();
			captcha.reload();
		}
	});
}


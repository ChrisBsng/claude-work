import { call, download, esc, formatDate, formatDay, siteUrl } from "/api.js";
import { mountCaptcha } from "/captcha.js";
import { STATUS_LABELS, subpageHead } from "/views/student-shared.js";

// Seite /abruf: Abruf-Code + Captcha (kein Schulpasswort), danach Status, Download und Verwalten.
export function renderPickupPage(root) {
	root.innerHTML = `
		${subpageHead("Abruf", "Status prüfen &amp; Zertifikat <span>abrufen</span>", "Mit dem Abruf-Code, den du beim Beantragen erhalten hast.")}
		<section class="card" id="pickup"></section>`;
	renderPickupForm(root.querySelector("#pickup"));
}

function renderPickupForm(box) {
	box.innerHTML = `
		<h2>Abruf-Code eingeben</h2>
		<p class="muted small">Dafür brauchst du <strong>kein Schulpasswort</strong>, nur den Abruf-Code, den du beim Beantragen erhalten hast.</p>
		<form id="pickupForm" autocomplete="off" class="narrow-form">
			<label>Abruf-Code
				<input type="text" name="code" required placeholder="z. B. K7QM-4TXD-9WPB-2HNC" autocomplete="off" autocapitalize="characters" />
			</label>
			<div data-captcha></div>
			<p class="error" id="pickupError" role="alert"></p>
			<button type="submit">Status prüfen</button>
		</form>
		<div id="pickupResult"></div>`;
	const captcha = mountCaptcha(box.querySelector("[data-captcha]"));
	const out = box.querySelector("#pickupResult");
	const err = box.querySelector("#pickupError");

	box.querySelector("#pickupForm").addEventListener("submit", async (event) => {
		event.preventDefault();
		const code = event.currentTarget.code.value;
		err.textContent = "";
		out.innerHTML = "";
		try {
			const r = await call("/api/student/csrs/lookup", { method: "POST", body: { code, ...captcha.values() } });
			showPickupResult(out, r, code);
		} catch (e) {
			err.textContent = e.message;
		}
		captcha.reload();
	});
}

function showPickupResult(out, r, code) {
	const token = r.pickupToken;
	out.innerHTML = `
		<div class="status status-${esc(r.status)}">${esc(STATUS_LABELS[r.status] ?? r.status)}</div>
		${r.status === "rejected" ? `<div class="reject-note"><strong>Grund der Ablehnung:</strong> ${esc(r.rejectReason || "(keine Begründung angegeben)")}<br><span class="muted small">Du kannst auf der Seite „Beantragen" einen korrigierten CSR erneut einreichen.</span></div>` : ""}
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
				</div>
				<div class="manage-box">
					<label class="check"><input type="checkbox" id="manage" ${r.management?.enabled ? "checked" : ""} /> Ich möchte die Zwischenzertifizierungsstelle hier verwalten.</label>
					<p class="muted small">Dafür wird eine eigene Seite für deine Klasse angelegt. Mitschüler können dort ohne Anmeldung CSRs einreichen oder ein Quick-Zertifikat anfordern und deine ausgestellten Zertifikate herunterladen. Du gibst jede Anfrage frei; den Schlüssel deiner Zwischen-CA kannst du dort dauerhaft hinterlegen oder bei jeder Freigabe neu hochladen.</p>
					<div id="manageInfo"></div>
				</div>`
				: ""
		}`;
	const expired = (e) => {
		if (e.status === 401) {
			out.innerHTML = `<p class="error">Die Abruf-Sitzung ist abgelaufen. Bitte Abruf-Code und Captcha erneut eingeben.</p>`;
			return true;
		}
		return false;
	};
	out.querySelectorAll("[data-cert]").forEach((btn) =>
		btn.addEventListener("click", () =>
			download("/api/student/csrs/certificate", { method: "POST", token, body: { format: btn.dataset.cert } }).catch((e) => !expired(e) && alert(e.message)),
		),
	);
	renderManage(out, r, token, expired);
}

function renderManage(out, r, pickupToken, expired) {
	const checkbox = out.querySelector("#manage");
	const info = out.querySelector("#manageInfo");
	if (!checkbox) return;
	const show = (t) => {
		if (!t) {
			info.innerHTML = "";
			return;
		}
		const url = siteUrl(`/ca/${t}`);
		// Abruf-Sitzung für den Inhaber-Bereich weitergeben (nur in diesem Tab, nur im Arbeitsspeicher der Sitzung)
		sessionStorage.setItem(`schulCa.owner.${t}`, pickupToken);
		info.innerHTML = `
			<p class="notice"><strong>Adresse für deine Klasse:</strong><br><a href="${esc(url)}" class="mono">${esc(url)}</a><br>
			<span class="muted small">Diese Adresse kannst du an die Klasse weitergeben. Den Abruf-Code bitte <strong>nicht</strong> weitergeben – er schaltet den Inhaber-Bereich frei (zusammen mit einem Captcha).</span></p>
			<div class="actions"><a class="button-link" href="${esc(url)}/verwalten">Verwaltung öffnen</a><a class="button-link secondary" href="${esc(url)}">Klassen-Seite ansehen</a><button type="button" class="secondary" id="copyUrl">Adresse kopieren</button></div>`;
		info.querySelector("#copyUrl").addEventListener("click", async (e) => {
			try {
				await navigator.clipboard.writeText(url);
				e.target.textContent = "Kopiert!";
			} catch {
				// Zwischenablage nicht verfügbar – Adresse steht als Text da.
			}
		});
	};
	show(r.management?.token);
	checkbox.addEventListener("change", async () => {
		const enable = checkbox.checked;
		if (!enable && !confirm("Verwaltung deaktivieren? Die Klassen-Seite, alle Anfragen und ein hinterlegter Schlüssel werden gelöscht. Bereits ausgestellte Zertifikate bleiben gültig.")) {
			checkbox.checked = true;
			return;
		}
		try {
			const res = await call("/api/student/csrs/manage", { method: "POST", token: pickupToken, body: { enable } });
			show(res.token);
		} catch (e) {
			checkbox.checked = !enable;
			if (!expired(e)) alert(e.message);
		}
	});
}

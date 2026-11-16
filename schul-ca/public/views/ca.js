import { call, download, esc, formatDate, formatDay } from "/api.js";
import { mountCaptcha } from "/captcha.js";

const STATUS = { pending: "Offen", issued: "Ausgestellt", rejected: "Abgelehnt" };
const KIND = { csr: "CSR", quick: "Quick" };
const ownerKey = (token) => `schulCa.owner.${token}`;

export async function renderCa(root, token) {
	const base = `/api/ca/${encodeURIComponent(token)}`;
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
					<label>Abteilung / Klasse (OU) *<input name="ou" required maxlength="64" placeholder="z. B. FI-25a" /></label>
				</div>
				<label>SAN – Hostnamen / IPs / E-Mail (kommagetrennt) *<input name="san" required placeholder="web.klasse.example, 192.0.2.10" /></label>
				<div class="grid">
					<label>E-Mail (E) *<input name="email" type="email" required maxlength="120" placeholder="vorname.nachname@schule.example" /></label>
					<label>Dein Name (für den Inhaber)<input name="requester" maxlength="80" /></label>
				</div>
				<p class="muted small">OU und E-Mail sind Pflicht: Der Inhaber der Zwischenzertifizierungsstelle muss dich als Antragsteller identifizieren können. Organisation, Land und Ort werden automatisch aus dem Zwischenzertifikat übernommen.</p>
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
					<label>Abteilung / Klasse (OU) *<input name="ou" required maxlength="64" placeholder="z. B. FI-25a" /></label>
					<label>E-Mail (E) *<input name="email" type="email" required maxlength="120" placeholder="vorname.nachname@schule.example" /></label>
				</div>
				<label>Dein Name (für den Inhaber)<input name="requester" maxlength="80" /></label>
				<p class="muted small">OU und E-Mail sind Pflicht (Identifizierung des Antragstellers). Organisation, Land und Ort werden aus dem Zwischenzertifikat übernommen. SAN-Einträge werden aus dem CSR übernommen und vom Inhaber geprüft. Nur den CSR hochladen, <strong>niemals den Private Key</strong>.</p>
				<div data-captcha></div>
				<p class="error" data-error role="alert"></p>
				<button type="submit">CSR einreichen</button>
			</form>
			<div id="quickResult"></div>
		</section>

		<section class="card" id="ownerBox">
			<details id="ownerDetails">
				<summary><strong>Inhaber-Bereich</strong> – Anfragen freigeben, Schlüssel verwalten</summary>
				<div id="ownerContent"></div>
			</details>
		</section>`;

	// ---- Downloads Zwischenzertifikat
	root.querySelectorAll("[data-ca]").forEach((b) =>
		b.addEventListener("click", () => download(`${base}/ca-certificate?format=${b.dataset.ca}`).catch((e) => alert(e.message))),
	);

	// ---- Tabelle
	const renderTable = (certs, host, { owner = false, onAction } = {}) => {
		if (!certs.length) {
			host.innerHTML = `<p class="muted">Noch keine Anfragen.</p>`;
			return;
		}
		host.innerHTML = `<div class="table-wrap"><table>
			<thead><tr><th>Art</th><th>Common Name</th><th>OU</th><th>SAN</th><th>Status</th><th>Gültig bis</th><th></th></tr></thead>
			<tbody>${certs
				.map(
					(c) => `<tr>
				<td>${esc(KIND[c.kind] ?? c.kind)}${owner && c.requester ? `<div class="muted small">${esc(c.requester)}</div>` : ""}</td>
				<td><strong>${esc(c.cn)}</strong>${owner && c.email ? `<div class="muted small">${esc(c.email)}</div>` : ""}</td>
				<td class="small">${esc(c.ou || "–")}</td>
				<td class="small mono">${esc(c.san || "–")}</td>
				<td><span class="badge status-${esc(c.status)}">${esc(STATUS[c.status] ?? c.status)}</span>${c.rejectReason ? `<div class="muted small">${esc(c.rejectReason)}</div>` : ""}</td>
				<td class="small">${esc(c.status === "issued" ? formatDay(c.notAfter) : "–")}</td>
				<td class="actions">${owner ? ownerActions(c) : certDownloads(c)}</td></tr>`,
				)
				.join("")}</tbody></table></div>`;
		host.querySelectorAll("[data-dl]").forEach((b) =>
			b.addEventListener("click", () => download(`${base}/certificates/${b.dataset.id}?format=${b.dataset.dl}`).catch((e) => alert(e.message))),
		);
		host.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => onAction?.(b.dataset.act, Number(b.dataset.id))));
	};
	const certDownloads = (c) =>
		c.status === "issued"
			? `<button class="secondary" data-dl="pem" data-id="${c.id}">.pem</button><button class="secondary" data-dl="chain" data-id="${c.id}">Kette</button><button class="secondary" data-dl="fullchain" data-id="${c.id}">+ Root</button><button class="secondary" data-dl="der" data-id="${c.id}">DER</button>`
			: "";
	const ownerActions = (c) =>
		[
			c.status !== "issued" ? `<button data-act="review" data-id="${c.id}">Prüfen</button>` : `<button class="secondary" data-dl="chain" data-id="${c.id}">Kette</button>`,
			`<button class="danger secondary" data-act="delete" data-id="${c.id}">Löschen</button>`,
		].join("");

	const refreshPublic = async () => {
		data = await call(base);
		renderTable(data.certificates, root.querySelector("#certTable"));
	};
	renderTable(data.certificates, root.querySelector("#certTable"));

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
				body: { cn: quickForm.cn.value, ou: quickForm.ou.value, san: quickForm.san.value, email: quickForm.email.value, requester: quickForm.requester.value, ...captchas.quick.values() },
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
			await call(`${base}/requests`, { method: "POST", body: { csrPem: csrForm.csr.value, ou: csrForm.ou.value, email: csrForm.email.value, requester: csrForm.requester.value, ...captchas.csr.values() } });
			csrForm.reset();
			err.innerHTML = `<span class="ok">CSR eingereicht. Der Inhaber prüft die Anfrage – danach erscheint das Zertifikat in der Tabelle.</span>`;
			await refreshPublic();
		} catch (e) {
			err.textContent = e.message;
		}
		captchas.csr.reload();
	});

	// ---- Inhaber-Bereich
	const ownerDetails = root.querySelector("#ownerDetails");
	let ownerCode = sessionStorage.getItem(ownerKey(token)) ?? "";
	async function fetchOwner(path, { method = "GET", body } = {}) {
		const res = await fetch(`${base}/owner${path}`, {
			method,
			headers: { "X-Owner-Code": ownerCode, ...(body ? { "Content-Type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		const json = await res.json().catch(() => null);
		if (!res.ok) throw Object.assign(new Error(json?.error ?? `Fehler ${res.status}`), { status: res.status });
		return json;
	}

	const renderOwnerLocked = (message = "") => {
		root.querySelector("#ownerContent").innerHTML = `
			<form id="unlock" class="inline-form" style="margin-top:12px">
				<input name="code" required placeholder="Abruf-Code der Zwischenzertifizierungsstelle" value="${esc(ownerCode)}" autocomplete="off" autocapitalize="characters" />
				<button type="submit">Entsperren</button>
			</form>
			<p class="error">${esc(message)}</p>
			<p class="muted small">Den Abruf-Code hast du beim Einreichen deines CSR erhalten. Er schützt diesen Bereich – bitte nicht an die Klasse weitergeben, nur die Adresse dieser Seite.</p>`;
		root.querySelector("#unlock").addEventListener("submit", (e) => {
			e.preventDefault();
			ownerCode = e.currentTarget.code.value;
			loadOwner();
		});
	};

	async function loadOwner() {
		let state;
		try {
			state = await fetchOwner("");
		} catch (e) {
			sessionStorage.removeItem(ownerKey(token));
			return renderOwnerLocked(e.status === 401 ? "Abruf-Code ungültig." : e.message);
		}
		sessionStorage.setItem(ownerKey(token), ownerCode);
		const host = root.querySelector("#ownerContent");
		host.innerHTML = `
			<h3 style="margin-top:16px">Anfragen</h3>
			<div id="ownerTable"></div>
			<div id="reviewBox"></div>
			<h3 style="margin-top:24px">Schlüssel der Zwischenzertifizierungsstelle</h3>
			<p>${state.keyStored ? "✅ <strong>Schlüssel ist hinterlegt</strong> – Freigaben werden sofort ausgestellt." : "Kein Schlüssel hinterlegt – bei jeder Freigabe muss der Private Key hochgeladen werden."}</p>
			<p class="notice">Ein hinterlegter Schlüssel wird verschlüsselt gespeichert, kann aber technisch von den Betreibern dieses Dienstes entschlüsselt werden. Wer das nicht möchte, lädt ihn bei jeder Freigabe erneut hoch – er wird dabei nur im Arbeitsspeicher verwendet und nicht gespeichert.</p>
			${
				state.keyStored
					? `<button class="danger secondary" id="keyDelete">Hinterlegten Schlüssel löschen</button>`
					: `<form id="keyForm"><label>Private Key (PKCS#8, unverschlüsselt)<textarea name="key" rows="5" spellcheck="false" placeholder="-----BEGIN PRIVATE KEY-----" required></textarea></label>
					<p class="error" data-error></p><button type="submit">Schlüssel dauerhaft hinterlegen</button></form>`
			}`;

		const act = async (what, id) => {
			if (what === "delete") {
				if (confirm("Diese Anfrage löschen?")) {
					await fetchOwner(`/requests/${id}`, { method: "DELETE" }).catch((e) => alert(e.message));
					await loadOwner();
					await refreshPublic();
				}
				return;
			}
			const req = state.requests.find((r) => r.id === id);
			openReview(req, state);
		};
		renderTable(state.requests, host.querySelector("#ownerTable"), { owner: true, onAction: act });

		host.querySelector("#keyDelete")?.addEventListener("click", async () => {
			if (!confirm("Hinterlegten Schlüssel löschen?")) return;
			await fetchOwner("/key", { method: "DELETE" }).catch((e) => alert(e.message));
			loadOwner();
		});
		host.querySelector("#keyForm")?.addEventListener("submit", async (e) => {
			e.preventDefault();
			const f = e.currentTarget;
			try {
				await fetchOwner("/key", { method: "PUT", body: { keyPem: f.key.value } });
				loadOwner();
			} catch (err) {
				f.querySelector("[data-error]").textContent = err.message;
			}
		});
	}

	function openReview(req, state) {
		const box = root.querySelector("#reviewBox");
		box.innerHTML = `
			<form class="card" id="reviewForm">
				<h3>Anfrage prüfen: ${esc(req.cn)}</h3>
				<p class="notice">Vor der Freigabe prüfen, ob die Anfrage berechtigt ist (${esc(KIND[req.kind])}${req.requester ? ` von ${esc(req.requester)}` : ""}). Die SAN-Einträge müssen innerhalb der erlaubten Domains liegen.</p>
				<h4>Antragsteller (Pflicht)</h4>
				<div class="grid">
					<label>Common Name (CN)<input name="cn" required maxlength="64" value="${esc(req.cn)}" /></label>
					<label>Abteilung / Klasse (OU) *<input name="ou" required maxlength="64" value="${esc(req.ou)}" /></label>
					<label>E-Mail (E) *<input name="email" type="email" required maxlength="120" value="${esc(req.email)}" /></label>
				</div>
				<h4>Organisation &amp; Standort (aus dem Zwischenzertifikat, anpassbar)</h4>
				<div class="grid">
					<label>Organisation (O)<input name="O" maxlength="64" value="${esc(state.defaults.O)}" /></label>
					<label>Land (C)<input name="C" maxlength="2" value="${esc(state.defaults.C)}" /></label>
					<label>Bundesland (ST)<input name="ST" maxlength="64" value="${esc(state.defaults.ST)}" /></label>
					<label>Ort (L)<input name="L" maxlength="64" value="${esc(state.defaults.L)}" /></label>
				</div>
				<h4>Laufzeit</h4>
				<div class="grid">
					<label>Gültigkeit (Tage, max. ${state.maxValidityDays})<input name="validityDays" type="number" min="1" max="${state.maxValidityDays}" value="${state.defaultValidityDays}" required /></label>
				</div>
				<p class="muted small">Die Laufzeit kann nicht länger sein als die Restlaufzeit der Zwischenzertifizierungsstelle (${state.maxValidityDays} Tage${state.maxValidityDays >= 825 ? ", Maximum" : ""}).</p>
				<label>SAN (kommagetrennt)<input name="san" value="${esc(req.san)}" /></label>
				${state.keyStored ? "" : `<label>Private Key der Zwischenzertifizierungsstelle (PKCS#8) – wird nicht gespeichert<textarea name="key" rows="4" spellcheck="false" required placeholder="-----BEGIN PRIVATE KEY-----"></textarea></label>`}
				<label>Ablehnungsgrund (nur beim Ablehnen)<input name="reason" maxlength="300" /></label>
				<p class="error" data-error></p>
				<div class="actions"><button type="submit" data-do="approve">Freigeben &amp; ausstellen</button><button type="button" class="danger" data-do="reject">Ablehnen</button><button type="button" class="secondary" data-do="close">Schließen</button></div>
			</form>`;
		box.scrollIntoView({ behavior: "smooth" });
		const form = box.querySelector("#reviewForm");
		const fail = (e) => (form.querySelector("[data-error]").textContent = e.message);
		form.addEventListener("submit", async (e) => {
			e.preventDefault();
			try {
				const res = await fetchOwner(`/requests/${req.id}/approve`, {
					method: "POST",
					body: {
						cn: form.cn.value, ou: form.ou.value, email: form.email.value, san: form.san.value, validityDays: Number(form.validityDays.value),
						subject: { O: form.O.value, C: form.C.value, ST: form.ST.value, L: form.L.value },
						...(form.key ? { keyPem: form.key.value } : {}),
					},
				});
				await loadOwner();
				await refreshPublic();
			} catch (err) {
				fail(err);
			}
		});
		form.querySelector('[data-do="reject"]').addEventListener("click", async () => {
			try {
				await fetchOwner(`/requests/${req.id}/reject`, { method: "POST", body: { reason: form.reason.value } });
				await loadOwner();
				await refreshPublic();
			} catch (err) {
				fail(err);
			}
		});
		form.querySelector('[data-do="close"]').addEventListener("click", () => (box.innerHTML = ""));
	}

	if (ownerCode) {
		ownerDetails.open = location.hash === "#owner" || Boolean(ownerCode);
		loadOwner();
	} else {
		renderOwnerLocked();
		ownerDetails.open = location.hash === "#owner";
	}
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

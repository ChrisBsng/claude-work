import { call, download, esc, formatDate, formatDay } from "/api.js";

const TOKEN_KEY = "schulCa.adminToken";
const STATUS_LABELS = { pending: "Offen", approved: "Freigegeben", rejected: "Abgelehnt", issued: "Ausgestellt" };
const TABS = [
	["csrs", "CSRs"],
	["roots", "Stammzertifikate"],
	["templates", "Templates"],
	["settings", "Einstellungen"],
];

let token = sessionStorage.getItem(TOKEN_KEY);
let activeTab = "csrs";

function setToken(value) {
	token = value;
	if (value) sessionStorage.setItem(TOKEN_KEY, value);
	else sessionStorage.removeItem(TOKEN_KEY);
}

const api = (path, options = {}) => call(`/api/admin${path}`, { ...options, token });
const apiDownload = (path, options = {}) => download(`/api/admin${path}`, { ...options, token });

export async function renderAdmin(root) {
	if (token) {
		try {
			await api("/settings");
			return renderShell(root);
		} catch {
			setToken(null);
		}
	}
	renderLogin(root);
}

function renderLogin(root) {
	root.innerHTML = `
		<header class="page-head"><span class="badge-pill">Administration</span><h1>Schul-<span>CA</span></h1></header>
		<div class="card narrow" style="margin-inline:auto">
			<form id="login">
				<label>Admin-Passwort <input type="password" name="password" required autofocus /></label>
				<p class="error" id="error" role="alert"></p>
				<button type="submit">Anmelden</button>
			</form>
		</div>
		<p class="muted small" style="text-align:center"><a href="/">Zur Schüleransicht</a></p>`;
	root.querySelector("#login").addEventListener("submit", async (event) => {
		event.preventDefault();
		try {
			const res = await call("/api/admin/login", { method: "POST", body: { password: event.currentTarget.password.value } });
			setToken(res.token);
			renderShell(root);
		} catch (e) {
			root.querySelector("#error").textContent = e.message;
		}
	});
}

function renderShell(root) {
	root.innerHTML = `
		<header class="page-head">
			<span class="badge-pill">Administration</span>
			<h1>Schul-<span>CA</span></h1>
			<div class="actions" style="justify-content:center"><a href="/" class="button-link secondary">Schüleransicht</a><button class="secondary" id="logout">Abmelden</button></div>
		</header>
		<nav class="tabs">${TABS.map(([id, label]) => `<button data-tab="${id}" class="${id === activeTab ? "active" : ""}">${label}</button>`).join("")}</nav>
		<div id="panel"></div>`;
	root.querySelector("#logout").addEventListener("click", () => {
		setToken(null);
		renderLogin(root);
	});
	root.querySelectorAll("[data-tab]").forEach((b) =>
		b.addEventListener("click", () => {
			activeTab = b.dataset.tab;
			renderShell(root);
		}),
	);
	const panel = root.querySelector("#panel");
	const views = { csrs: renderCsrs, roots: renderRoots, templates: renderTemplates, settings: renderSettings };
	views[activeTab](panel, root).catch((e) => handleError(e, root, panel));
}

function handleError(e, root, panel) {
	if (e.status === 401) {
		setToken(null);
		return renderLogin(root);
	}
	panel.innerHTML = `<p class="error">${esc(e.message)}</p>`;
}

const run = async (fn, root, rerender) => {
	try {
		await fn();
		await rerender();
	} catch (e) {
		if (e.status === 401) {
			setToken(null);
			renderLogin(root);
		} else alert(e.message);
	}
};

// ---- CSRs ---------------------------------------------------------------------

let csrFilter = "pending";

async function renderCsrs(panel, root) {
	const [{ csrs }, { templates }] = await Promise.all([api(csrFilter ? `/csrs?status=${csrFilter}` : "/csrs"), api("/templates")]);
	const filters = [["pending", "Offen"], ["approved", "Freigegeben"], ["issued", "Ausgestellt"], ["rejected", "Abgelehnt"], ["", "Alle"]];
	panel.innerHTML = `
		<div class="filters">${filters.map(([v, l]) => `<button class="chip ${v === csrFilter ? "active" : ""}" data-filter="${v}">${l}</button>`).join("")}</div>
		${
			csrs.length
				? `<table>
			<thead><tr><th></th><th>Klasse</th><th>Kontakt</th><th>Subject (CSR)</th><th>Key</th><th>Stamm-CA</th><th>Eingereicht</th><th>Status</th><th></th></tr></thead>
			<tbody>${csrs
				.map(
					(c) => `<tr data-row="${c.id}">
				<td class="expander">${c.management ? `<button class="expand" data-expand="${c.id}" aria-expanded="false" title="Verwaltete Zertifikate anzeigen">+</button>` : ""}</td>
				<td><strong>${esc(c.label)}</strong>${c.management ? `<div class="muted small">${c.management.requests} verwaltete Zertifikate</div>` : ""}</td><td class="small">${esc(c.contactPerson || "–")}<br><span class="muted">${esc(contactLabel(c))}</span></td><td class="small">${esc(c.subject)}</td><td class="small">${esc(c.keyInfo)}</td>
				<td class="small">${esc(c.rootName)}</td><td class="small">${esc(formatDate(c.submittedAt))}</td>
				<td><span class="badge status-${esc(c.status)}">${esc(STATUS_LABELS[c.status])}</span></td>
				<td><button class="secondary" data-open="${c.id}">Öffnen</button></td></tr>`,
				)
				.join("")}</tbody></table>`
				: `<p class="muted">Keine CSRs in dieser Ansicht.</p>`
		}
		<div id="detail"></div>`;
	panel.querySelectorAll("[data-filter]").forEach((b) =>
		b.addEventListener("click", () => {
			csrFilter = b.dataset.filter;
			renderShell(root);
		}),
	);
	panel.querySelectorAll("[data-expand]").forEach((b) =>
		b.addEventListener("click", async () => {
			const row = b.closest("tr");
			const open = b.getAttribute("aria-expanded") === "true";
			row.nextElementSibling?.matches(".leaf-row") && row.nextElementSibling.remove();
			b.setAttribute("aria-expanded", String(!open));
			b.textContent = open ? "+" : "−";
			if (open) return;
			const detail = document.createElement("tr");
			detail.className = "leaf-row";
			detail.innerHTML = `<td></td><td colspan="8"><p class="muted small">Lädt…</p></td>`;
			row.after(detail);
			try {
				const { leaves } = await api(`/csrs/${b.dataset.expand}/leaves`);
				detail.firstElementChild.nextElementSibling.innerHTML = leaves.length
					? `<table class="sub"><thead><tr><th>Art</th><th>CN</th><th>OU</th><th>E-Mail</th><th>SAN</th><th>Antragsteller</th><th>Status</th><th>Gültig bis</th></tr></thead><tbody>${leaves
							.map(
								(l) => `<tr><td>${l.kind === "quick" ? "Quick" : "CSR"}</td><td><strong>${esc(l.cn)}</strong></td><td class="small">${esc(l.ou || "–")}</td><td class="small">${esc(l.email || "–")}</td><td class="small mono">${esc(l.san || "–")}</td><td class="small">${esc(l.requester || "–")}</td><td><span class="badge status-${esc(l.status)}">${esc(STATUS_LABELS[l.status] ?? l.status)}</span>${l.rejectReason ? `<div class="muted small">${esc(l.rejectReason)}</div>` : ""}</td><td class="small">${esc(l.status === "issued" ? formatDay(l.notAfter) : "–")}</td></tr>`,
							)
							.join("")}</tbody></table>`
					: `<p class="muted small">Für diese Zwischenzertifizierungsstelle gibt es noch keine Anfragen.</p>`;
			} catch (e) {
				detail.firstElementChild.nextElementSibling.innerHTML = `<p class="error">${esc(e.message)}</p>`;
			}
		}),
	);
	panel.querySelectorAll("[data-open]").forEach((b) =>
		b.addEventListener("click", async () => {
			const { csr } = await api(`/csrs/${b.dataset.open}`).catch((e) => (alert(e.message), {}));
			if (csr) renderCsrDetail(panel.querySelector("#detail"), csr, templates, root);
		}),
	);
}

const CONTACT_METHOD_LABELS = { email: "E-Mail", teams: "Teams", phone: "Telefon" };
function contactLabel(c) {
	return c.contactMethod ? `${CONTACT_METHOD_LABELS[c.contactMethod] ?? c.contactMethod}: ${c.contactDetail}` : "";
}

const SUBJECT_FIELDS = [
	["CN", "Common Name (CN)"], ["O", "Organisation (O)"], ["OU", "Abteilung (OU)"], ["C", "Land (C)"], ["ST", "Bundesland (ST)"], ["L", "Ort (L)"],
];

function renderCsrDetail(box, csr, templates, root) {
	const rerender = () => renderShell(root);
	const editable = csr.status === "pending" || csr.status === "approved" || csr.status === "rejected";
	const templateFields = (t) => ({ C: t?.subjectCountry, ST: t?.subjectState, L: t?.subjectLocality, O: t?.subjectOrg, OU: t?.subjectOrgUnit });
	const initialSubject = csr.approvedSubject ?? null;

	box.innerHTML = `
		<div class="card detail">
			<h2>${esc(csr.label)} <span class="badge status-${esc(csr.status)}">${esc(STATUS_LABELS[csr.status])}</span></h2>
			<dl>
				<dt>Kontaktperson</dt><dd>${esc(csr.contactPerson || "– (vor Einführung der Pflichtangabe eingereicht)")}</dd>
				${csr.contactMethod ? `<dt>Kontaktweg</dt><dd>${esc(contactLabel(csr))}</dd>` : ""}
				<dt>Subject im CSR</dt><dd>${esc(csr.subject)}</dd>
				<dt>Schlüssel</dt><dd>${esc(csr.keyInfo)}</dd>
				<dt>Stammzertifikat</dt><dd>${esc(csr.rootName)}</dd>
				<dt>Eingereicht</dt><dd>${esc(formatDate(csr.submittedAt))}</dd>
				${csr.templateName ? `<dt>Template</dt><dd>${esc(csr.templateName)}</dd>` : ""}
				${csr.rejectReason ? `<dt>Ablehnungsgrund</dt><dd>${esc(csr.rejectReason)}</dd>` : ""}
				${csr.management ? `<dt>Verwaltung</dt><dd>aktiv · <a href="/ca/${esc(csr.management.token)}" target="_blank" rel="noopener">Klassen-Seite</a> · ${csr.management.requests} Anfragen · Schlüssel ${csr.management.keyStored ? "hinterlegt" : "nicht hinterlegt"}</dd>` : ""}
				${csr.status === "issued" ? `<dt>Seriennummer</dt><dd class="mono small">${esc(csr.serialNumber)}</dd><dt>Gültig</dt><dd>${esc(formatDay(csr.notBefore))} – ${esc(formatDay(csr.notAfter))}</dd>` : ""}
			</dl>
			<details><summary>CSR (PEM)</summary><pre>${esc(csr.csrPem)}</pre></details>
			${
				editable
					? `<form id="approve">
				<h3>Freigabe</h3>
				<p class="notice">Vor der Freigabe die Anfrage über den angegebenen Kontaktweg verifizieren.</p>
				<label>Template
					<select name="templateId" required>
						<option value="">– wählen –</option>
						${templates.map((t) => `<option value="${t.id}" ${t.id === csr.templateId ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
					</select>
				</label>
				<div class="grid">${SUBJECT_FIELDS.map(([k, l]) => `<label>${l}<input name="subject.${k}" value="${esc(initialSubject?.[k] ?? csr.csrFields?.[k] ?? "")}" /></label>`).join("")}</div>
				<label>Gültigkeit (Tage)<input type="number" name="validityDays" min="1" max="3650" value="${csr.approvedValidityDays ?? ""}" /></label>
				<p class="muted small">Beim Wechsel des Templates werden dessen Subject-Felder und Gültigkeit eingetragen; danach sind alle Felder frei editierbar. Alle weiteren Zertifikatsinhalte (Schlüssel) stammen aus dem CSR, Erweiterungen aus dem Template – im CSR angeforderte Extensions werden ignoriert.</p>
				<div class="actions">
					<button type="submit" data-issue="1">Freigeben &amp; Zertifikat erzeugen</button>
					<button type="submit" class="secondary" data-issue="0">Nur freigeben</button>
					${csr.status === "approved" ? `<button type="button" id="issueNow">Zertifikat jetzt erzeugen</button>` : ""}
					
				</div>
			</form>
			<div class="reject-box">
				<h3>Ablehnen</h3>
				<label>Begründung (wird dem Schüler beim Abruf angezeigt)
					<textarea id="rejectReason" rows="3" maxlength="300" placeholder="z. B. Bitte die Klassenbezeichnung im Common Name angeben."></textarea>
				</label>
				<button type="button" class="danger" id="reject">CSR ablehnen</button>
			</div>`
					: ""
			}
			${
				csr.status === "issued"
					? `<div class="actions">
				<button data-cert="chain">Kette (.pem)</button><button class="secondary" data-cert="pem">Zertifikat (.pem)</button><button class="secondary" data-cert="der">DER (.cer)</button>
			</div>`
					: ""
			}
			<div class="actions">${csr.management ? `<button class="secondary" id="unmanage">Verwaltung deaktivieren</button>` : ""}<button class="danger secondary" id="delete">CSR löschen</button></div>
		</div>`;
	box.scrollIntoView({ behavior: "smooth" });

	const form = box.querySelector("#approve");
	if (form) {
		const applyTemplate = () => {
			const t = templates.find((x) => String(x.id) === form.templateId.value);
			if (!t) return;
			const fields = templateFields(t);
			for (const [k, v] of Object.entries(fields)) if (v) form[`subject.${k}`].value = v;
			form.validityDays.value = t.validityDays;
		};
		form.templateId.addEventListener("change", applyTemplate);
		let issueFlag = false;
		form.querySelectorAll("button[data-issue]").forEach((b) => b.addEventListener("click", () => (issueFlag = b.dataset.issue === "1")));
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const subject = {};
			for (const [k] of SUBJECT_FIELDS) subject[k] = form[`subject.${k}`].value;
			run(
				async () => {
					const res = await api(`/csrs/${csr.id}/approve`, {
						method: "POST",
						body: { templateId: Number(form.templateId.value), validityDays: Number(form.validityDays.value) || undefined, subject, issue: issueFlag },
					});
					if (res.truncated) alert("Hinweis: Die Laufzeit wurde auf das Ablaufdatum des Stammzertifikats gekürzt.");
				},
				root,
				rerender,
			);
		});
		box.querySelector("#issueNow")?.addEventListener("click", () =>
			run(async () => {
				const res = await api(`/csrs/${csr.id}/issue`, { method: "POST" });
				if (res.truncated) alert("Hinweis: Die Laufzeit wurde auf das Ablaufdatum des Stammzertifikats gekürzt.");
			}, root, rerender),
		);
		box.querySelector("#reject").addEventListener("click", () => {
			const reason = box.querySelector("#rejectReason").value.trim();
			if (!reason && !confirm("Ohne Begründung ablehnen?")) return;
			run(() => api(`/csrs/${csr.id}/reject`, { method: "POST", body: { reason } }), root, rerender);
		});
	}
	box.querySelectorAll("[data-cert]").forEach((b) => b.addEventListener("click", () => apiDownload(`/csrs/${csr.id}/certificate?format=${b.dataset.cert}`).catch((e) => alert(e.message))));
	box.querySelector("#unmanage")?.addEventListener("click", () => {
		if (confirm("Verwaltung deaktivieren? Klassen-Seite, Anfragen und ein hinterlegter Schlüssel werden gelöscht.")) {
			run(() => api(`/csrs/${csr.id}/management`, { method: "DELETE" }), root, rerender);
		}
	});
	box.querySelector("#delete").addEventListener("click", () => {
		if (confirm(`CSR „${csr.label}“ endgültig löschen? Das ausgestellte Zertifikat (falls vorhanden) bleibt gültig, ist aber nicht mehr abrufbar.`)) {
			run(() => api(`/csrs/${csr.id}`, { method: "DELETE" }), root, rerender);
		}
	});
}

// ---- Stammzertifikate ---------------------------------------------------------

async function renderRoots(panel, root) {
	const { roots } = await api("/roots");
	const rerender = () => renderShell(root);
	panel.innerHTML = `
		<table>
			<thead><tr><th>Name</th><th>Subject</th><th>Schlüssel</th><th>Gültig bis</th><th>CSRs</th><th>Aktiv</th><th></th></tr></thead>
			<tbody>${
				roots.length
					? roots
							.map(
								(r) => `<tr>
				<td><strong>${esc(r.name)}</strong><div class="muted small mono">${esc(r.fingerprint)}</div></td>
				<td class="small">${esc(r.subject)}</td><td class="small">${esc(r.keyAlgorithm)}</td><td class="small">${esc(formatDay(r.notAfter))}</td>
				<td>${r.csrCount}</td>
				<td><input type="checkbox" data-active="${r.id}" ${r.isActive ? "checked" : ""} title="Für Schüler sichtbar"/></td>
				<td class="actions"><button class="secondary" data-dl="${r.id}">PEM</button><button class="danger secondary" data-del="${r.id}" data-name="${esc(r.name)}">Löschen</button></td></tr>`,
							)
							.join("")
					: `<tr><td colspan="7" class="muted">Noch kein Stammzertifikat hinterlegt.</td></tr>`
			}</tbody>
		</table>

		<div class="card-wrap">
			<form class="card" id="import">
				<h3>Root-CA importieren (offline erzeugt)</h3>
				<label>Anzeigename<input name="name" required maxlength="80" /></label>
				<label>Zertifikat (PEM)<textarea name="certPem" rows="5" required spellcheck="false" placeholder="-----BEGIN CERTIFICATE-----"></textarea></label>
				<label>Private Key (PKCS#8, unverschlüsselt)<textarea name="keyPem" rows="5" required spellcheck="false" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></label>
				<p class="muted small">Der Key wird mit AES-256-GCM verschlüsselt gespeichert (Schlüssel aus dem Worker-Secret <code>MASTER_SECRET</code>) und verlässt den Server nie. Bei Bedarf umwandeln: <code>openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem</code></p>
				<p class="error" data-error></p>
				<button type="submit">Importieren</button>
			</form>
		</div>`;

	panel.querySelectorAll("[data-active]").forEach((c) =>
		c.addEventListener("change", () => run(() => api(`/roots/${c.dataset.active}`, { method: "PATCH", body: { isActive: c.checked } }), root, rerender)),
	);
	panel.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => apiDownload(`/roots/${b.dataset.dl}/certificate`).catch((e) => alert(e.message))));
	panel.querySelectorAll("[data-del]").forEach((b) =>
		b.addEventListener("click", () => {
			if (confirm(`Stammzertifikat „${b.dataset.name}“ inkl. Private Key löschen?`)) run(() => api(`/roots/${b.dataset.del}`, { method: "DELETE" }), root, rerender);
		}),
	);
	const submit = (formId, path, build) =>
		panel.querySelector(formId).addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = event.currentTarget;
			const err = form.querySelector("[data-error]");
			err.textContent = "";
			const button = form.querySelector("button[type=submit]");
			button.disabled = true;
			button.textContent = "Bitte warten…";
			try {
				await api(path, { method: "POST", body: build(form) });
				rerender();
			} catch (e) {
				if (e.status === 401) {
					setToken(null);
					return renderLogin(root);
				}
				err.textContent = e.message;
				button.disabled = false;
				button.textContent = "Importieren";
			}
		});
	submit("#import", "/roots/import", (f) => ({ name: f.name.value, certPem: f.certPem.value, keyPem: f.keyPem.value }));
}

// ---- Templates ----------------------------------------------------------------

async function renderTemplates(panel, root) {
	const { templates } = await api("/templates");
	const rerender = () => renderShell(root);
	let editing = null;

	const formHtml = (t) => `
		<form class="card" id="tplForm">
			<h3>${t ? "Template bearbeiten" : "Neues Template"}</h3>
			<div class="grid">
				<label>Name<input name="name" required value="${esc(t?.name)}" /></label>
				<label>Gültigkeit (Tage)<input type="number" name="validityDays" min="1" max="3650" required value="${t?.validityDays ?? 365}" /></label>
				<label>Max. Pfadlänge (leer = unbegrenzt)<input type="number" name="pathLen" min="0" max="10" value="${t?.pathLen ?? 0}" /></label>
			</div>
			<h4>Subject-Felder (überschreiben den CSR-Inhalt, leer = aus dem CSR)</h4>
			<div class="grid">
				<label>Organisation (O)<input name="subjectOrg" value="${esc(t?.subjectOrg)}" /></label>
				<label>Abteilung (OU)<input name="subjectOrgUnit" value="${esc(t?.subjectOrgUnit)}" /></label>
				<label>Land (C)<input name="subjectCountry" maxlength="2" value="${esc(t?.subjectCountry)}" /></label>
				<label>Bundesland (ST)<input name="subjectState" value="${esc(t?.subjectState)}" /></label>
				<label>Ort (L)<input name="subjectLocality" value="${esc(t?.subjectLocality)}" /></label>
			</div>
			<h4>Erweiterungen</h4>
			<p class="muted small">Immer gesetzt: BasicConstraints (CA:TRUE, kritisch), KeyUsage keyCertSign + cRLSign, Subject-/Authority-Key-Identifier.</p>
			<label>Name Constraints – erlaubte DNS-Domains (Komma-getrennt, leer = keine Einschränkung)
				<input name="permittedDns" placeholder="schule.example, .intern.schule.example" value="${esc(t?.permittedDns)}" />
			</label>
			<div class="grid">
				<label>CRL-URL (optional)<input name="crlUrl" type="url" value="${esc(t?.crlUrl)}" /></label>
				<label>AIA CA-Issuers-URL (optional)<input name="aiaUrl" type="url" value="${esc(t?.aiaUrl)}" /></label>
			</div>
			<p class="error" data-error></p>
			<div class="actions"><button type="submit">Speichern</button>${t ? `<button type="button" class="secondary" id="cancel">Abbrechen</button>` : ""}</div>
		</form>`;

	const draw = () => {
		panel.innerHTML = `
			<table>
				<thead><tr><th>Name</th><th>Gültigkeit</th><th>Pfadlänge</th><th>Subject</th><th>Name Constraints</th><th></th></tr></thead>
				<tbody>${
					templates.length
						? templates
								.map(
									(t) => `<tr><td><strong>${esc(t.name)}</strong></td><td>${t.validityDays} Tage</td><td>${t.pathLen ?? "∞"}</td>
					<td class="small">${esc([t.subjectCountry && `C=${t.subjectCountry}`, t.subjectOrg && `O=${t.subjectOrg}`, t.subjectOrgUnit && `OU=${t.subjectOrgUnit}`].filter(Boolean).join(", ") || "–")}</td>
					<td class="small">${esc(t.permittedDns || "–")}</td>
					<td class="actions"><button class="secondary" data-edit="${t.id}">Bearbeiten</button><button class="danger secondary" data-del="${t.id}" data-name="${esc(t.name)}">Löschen</button></td></tr>`,
								)
								.join("")
						: `<tr><td colspan="6" class="muted">Noch keine Templates.</td></tr>`
				}</tbody>
			</table>
			${formHtml(editing)}`;
		panel.querySelectorAll("[data-edit]").forEach((b) =>
			b.addEventListener("click", () => {
				editing = templates.find((t) => String(t.id) === b.dataset.edit);
				draw();
				panel.querySelector("#tplForm").scrollIntoView({ behavior: "smooth" });
			}),
		);
		panel.querySelectorAll("[data-del]").forEach((b) =>
			b.addEventListener("click", () => {
				if (confirm(`Template „${b.dataset.name}“ löschen?`)) run(() => api(`/templates/${b.dataset.del}`, { method: "DELETE" }), root, rerender);
			}),
		);
		panel.querySelector("#cancel")?.addEventListener("click", () => {
			editing = null;
			draw();
		});
		panel.querySelector("#tplForm").addEventListener("submit", async (event) => {
			event.preventDefault();
			const f = event.currentTarget;
			const body = Object.fromEntries(["name", "subjectOrg", "subjectOrgUnit", "subjectCountry", "subjectState", "subjectLocality", "permittedDns", "crlUrl", "aiaUrl"].map((k) => [k, f[k].value]));
			body.validityDays = Number(f.validityDays.value);
			body.pathLen = f.pathLen.value === "" ? null : Number(f.pathLen.value);
			try {
				await api(editing ? `/templates/${editing.id}` : "/templates", { method: editing ? "PUT" : "POST", body });
				rerender();
			} catch (e) {
				if (e.status === 401) {
					setToken(null);
					return renderLogin(root);
				}
				f.querySelector("[data-error]").textContent = e.message;
			}
		});
	};
	draw();
}

// ---- Einstellungen ------------------------------------------------------------

async function renderSettings(panel, root) {
	const settings = await api("/settings");
	panel.innerHTML = `
		<div class="two-col">
			<form class="card" id="studentForm">
				<h3>Schüler-Anmeldung</h3>
				<p class="muted small">Passwort: ${settings.studentPasswordSet ? "gesetzt (wird nur als PBKDF2-Hash gespeichert)" : "<strong>noch nicht gesetzt – die Schülerseite ist gesperrt</strong>"}</p>
				<label>Neues Schülerpasswort<input type="text" name="studentPassword" autocomplete="off" minlength="6" placeholder="leer lassen = unverändert" /></label>
				<label>Passworthinweis (wird auf der Anmeldeseite angezeigt)
					<textarea name="passwordHint" rows="3" maxlength="300">${esc(settings.passwordHint)}</textarea>
				</label>
				<p class="error" data-error></p><p class="ok" data-ok></p>
				<button type="submit">Speichern</button>
			</form>
			<form class="card" id="adminForm">
				<h3>Admin-Passwort ändern</h3>
				<p class="muted small">${settings.adminPasswordFromEnv ? "Aktuell gilt noch das Start-Passwort aus dem Secret <code>ADMIN_PASSWORD</code>. Nach dem Ändern wird stattdessen der gespeicherte Hash verwendet." : "Gespeichert als PBKDF2-Hash."}</p>
				<label>Aktuelles Passwort<input type="password" name="currentAdminPassword" required autocomplete="current-password" /></label>
				<label>Neues Passwort (min. 10 Zeichen)<input type="password" name="adminPassword" required minlength="10" autocomplete="new-password" /></label>
				<p class="error" data-error></p><p class="ok" data-ok></p>
				<button type="submit">Passwort ändern</button>
			</form>
		</div>`;
	const bind = (id, build, after) =>
		panel.querySelector(id).addEventListener("submit", async (event) => {
			event.preventDefault();
			const f = event.currentTarget;
			f.querySelector("[data-error]").textContent = "";
			f.querySelector("[data-ok]").textContent = "";
			try {
				const res = await api("/settings", { method: "PUT", body: build(f) });
				if (res.token) setToken(res.token);
				after?.(f);
				f.querySelector("[data-ok]").textContent = "Gespeichert.";
			} catch (e) {
				if (e.status === 401) {
					setToken(null);
					return renderLogin(root);
				}
				f.querySelector("[data-error]").textContent = e.message;
			}
		});
	bind("#studentForm", (f) => ({ passwordHint: f.passwordHint.value, ...(f.studentPassword.value ? { studentPassword: f.studentPassword.value } : {}) }), (f) => (f.studentPassword.value = ""));
	bind("#adminForm", (f) => ({ adminPassword: f.adminPassword.value, currentAdminPassword: f.currentAdminPassword.value }), (f) => f.reset());
}

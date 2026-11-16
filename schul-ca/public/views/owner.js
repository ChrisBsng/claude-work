import { call, esc, formatDay } from "/api.js";
import { mountCaptcha } from "/captcha.js";
import { caBase, KIND, ownerKey, renderCertTable } from "/views/ca-shared.js";

// Inhaber-Seite /ca/<Token>/verwalten: eigene Seite, eigene Anmeldung (Abruf-Code + Captcha
// bzw. Abruf-Sitzung aus dem Abruf). Anfragen freigeben/ablehnen, Schlüssel der Zwischen-CA verwalten.
export async function renderOwner(root, token) {
	const base = caBase(token);
	let data;
	try {
		data = await call(base);
	} catch (e) {
		root.innerHTML = `<header class="page-head"><span class="badge-pill">Verwaltung</span><h1>Nicht <span>gefunden</span></h1><p>${esc(e.message)}</p></header>
			<p style="text-align:center"><a href="/">Zur Startseite</a></p>`;
		return;
	}
	root.innerHTML = `
		<p class="crumbs"><a href="/">← Startseite</a> · <a href="/ca/${esc(token)}">Klassen-Seite ansehen</a></p>
		<header class="page-head">
			<span class="badge-pill">Verwaltung</span>
			<h1>${esc(data.name)}</h1>
			<p class="mono small">${esc(data.subject)} · gültig bis ${esc(formatDay(data.notAfter))}</p>
		</header>
		<section class="card" id="ownerContent"></section>`;
	const content = root.querySelector("#ownerContent");

	let ownerToken = sessionStorage.getItem(ownerKey(token)) ?? "";
	async function fetchOwner(path, { method = "GET", body } = {}) {
		const res = await fetch(`${base}/owner${path}`, {
			method,
			headers: { Authorization: `Bearer ${ownerToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		const json = await res.json().catch(() => null);
		if (!res.ok) throw Object.assign(new Error(json?.error ?? `Fehler ${res.status}`), { status: res.status });
		return json;
	}

	const renderOwnerLocked = (message = "") => {
		content.innerHTML = `
			<form id="unlock" class="narrow-form" style="margin-top:12px" autocomplete="off">
				<label>Abruf-Code der Zwischenzertifizierungsstelle
					<input name="code" required placeholder="z. B. K7QM-4TXD-9WPB-2HNC" autocomplete="off" autocapitalize="characters" />
				</label>
				<div data-captcha></div>
				<p class="error" data-error>${esc(message)}</p>
				<button type="submit">Entsperren</button>
			</form>
			<p class="muted small">Den Abruf-Code hast du beim Beantragen deines Zwischenzertifikats erhalten. Er schützt diesen Bereich – bitte nicht an die Klasse weitergeben, nur die Adresse dieser Seite.</p>`;
		const captcha = mountCaptcha(root.querySelector("#unlock [data-captcha]"));
		root.querySelector("#unlock").addEventListener("submit", async (e) => {
			e.preventDefault();
			const f = e.currentTarget;
			try {
				const res = await call(`${base}/owner/login`, { method: "POST", body: { code: f.code.value, ...captcha.values() } });
				ownerToken = res.ownerToken;
				loadOwner();
			} catch (err) {
				f.querySelector("[data-error]").textContent = err.message;
				captcha.reload();
			}
		});
	};

	async function loadOwner() {
		let state;
		try {
			state = await fetchOwner("");
		} catch (e) {
			sessionStorage.removeItem(ownerKey(token));
			ownerToken = "";
			return renderOwnerLocked(e.status === 401 ? "Die Inhaber-Sitzung ist abgelaufen oder ungültig. Bitte erneut mit Abruf-Code und Captcha anmelden." : e.message);
		}
		sessionStorage.setItem(ownerKey(token), ownerToken);
		const host = content;
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
				}
				return;
			}
			const req = state.requests.find((r) => r.id === id);
			openReview(req, state);
		};
		renderCertTable(host.querySelector("#ownerTable"), state.requests, { base, owner: true, onAction: act });

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
					<label>E-Mail (E) *<input name="email" type="email" required maxlength="120" value="${esc(req.email)}" /></label>
				</div>
				<h4>Abteilung, Organisation &amp; Standort (aus dem Zwischenzertifikat, anpassbar)</h4>
				<div class="grid">
					<label>Abteilung (OU)<input name="ou" maxlength="64" value="${esc(req.ou || state.defaults.OU)}" /></label>
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
			} catch (err) {
				fail(err);
			}
		});
		form.querySelector('[data-do="reject"]').addEventListener("click", async () => {
			try {
				await fetchOwner(`/requests/${req.id}/reject`, { method: "POST", body: { reason: form.reason.value } });
				await loadOwner();
			} catch (err) {
				fail(err);
			}
		});
		form.querySelector('[data-do="close"]').addEventListener("click", () => (box.innerHTML = ""));
	}

	if (ownerToken) loadOwner();
	else renderOwnerLocked();
}

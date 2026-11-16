import { download, esc, formatDay } from "/api.js";

export const STATUS = { pending: "Offen", issued: "Ausgestellt", rejected: "Abgelehnt" };
export const KIND = { csr: "CSR", quick: "Quick" };
export const ownerKey = (token) => `schulCa.owner.${token}`;
export const caBase = (token) => `/api/ca/${encodeURIComponent(token)}`;

const certDownloads = (c) =>
	c.status === "issued"
		? `<button class="secondary" data-dl="pem" data-id="${c.id}">.pem</button><button class="secondary" data-dl="chain" data-id="${c.id}">Kette</button><button class="secondary" data-dl="fullchain" data-id="${c.id}">+ Root</button><button class="secondary" data-dl="der" data-id="${c.id}">DER</button>`
		: "";
const ownerActions = (c) =>
	[
		c.status !== "issued" ? `<button data-act="review" data-id="${c.id}">Prüfen</button>` : `<button class="secondary" data-dl="chain" data-id="${c.id}">Kette</button>`,
		`<button class="danger secondary" data-act="delete" data-id="${c.id}">Löschen</button>`,
	].join("");

// Tabelle der Anfragen/Zertifikate – öffentlich (Downloads) oder für den Inhaber (Aktionen).
export function renderCertTable(host, certs, { base, owner = false, onAction } = {}) {
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
}

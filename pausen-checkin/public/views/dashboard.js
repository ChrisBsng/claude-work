import { api } from "/api.js";
import { renderBrandHeader } from "/brandHeader.js";
import { getBaseUrl } from "/baseUrl.js";

// 15s statt 5s, zusätzlich pausiert via Page Visibility API (siehe unten),
// um die D1-Lesekosten des Live-Pollings spürbar zu senken.
const POLL_INTERVAL_MS = 15000;
const STATUS_LABELS = { present: "Anwesend", on_break: "In der Pause", unknown: "Unbekannt" };
// Ab dieser Teilnehmerzahl wird die Live-Tabelle auf zwei Spalten
// aufgeteilt, damit auch größere Kurse (bis ~30 Teilnehmer) ohne langes
// Scrollen auf einen Blick überschaubar bleiben.
const TWO_COLUMN_THRESHOLD = 12;

function budgetBarClass(usedMinutes, dailyBudget) {
	const remaining = dailyBudget - usedMinutes;
	if (remaining <= 0) return "empty";
	if (remaining <= dailyBudget * 0.2) return "low";
	return "";
}

function participantRow(participant, dailyBudget, hasBreakTracking, justReturned) {
	const rowClass = justReturned ? ' class="just-returned"' : "";
	if (!hasBreakTracking) {
		return `
			<tr${rowClass}>
				<td>${participant.name}</td>
				<td><span class="status-badge ${participant.status}">${STATUS_LABELS[participant.status]}</span></td>
			</tr>
		`;
	}
	const percent = Math.min(100, (participant.usedMinutesToday / dailyBudget) * 100);
	return `
		<tr${rowClass}>
			<td>${participant.name}</td>
			<td><span class="status-badge ${participant.status}">${STATUS_LABELS[participant.status]}</span></td>
			<td>
				<div class="budget-bar ${budgetBarClass(participant.usedMinutesToday, dailyBudget)}">
					<span style="width: ${percent}%"></span>
				</div>
			</td>
			<td>
				${
					participant.overMinutesToday > 0
						? `<span class="budget-overage">+${participant.overMinutesToday} Min. über Budget</span>`
						: `${participant.remainingMinutesToday} / ${dailyBudget} Min.`
				}
			</td>
		</tr>
	`;
}

function participantTable(participants, dailyBudget, hasBreakTracking, justReturnedIds) {
	return `
		<table>
			<thead><tr><th>Name</th><th>Status</th>${hasBreakTracking ? "<th>Pausenbudget</th><th></th>" : ""}</tr></thead>
			<tbody>${participants.map((p) => participantRow(p, dailyBudget, hasBreakTracking, justReturnedIds.has(p.id))).join("")}</tbody>
		</table>
	`;
}

function formatShortDate(dateStr) {
	const [, m, d] = dateStr.split("-");
	return `${d}.${m}.`;
}

function formatLongDate(dateStr) {
	return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("de-DE", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
}

async function loadDayDetail(dashboardToken, course, date, container) {
	container.innerHTML = `<p class="muted">Lädt ${formatLongDate(date)}…</p>`;
	try {
		const { participants } = await api.getDashboardDayDetail(dashboardToken, date);
		container.innerHTML = `
			<div class="card">
				<h3>${formatLongDate(date)}</h3>
				${
					participants.length === 0
						? '<p class="muted">Keine Teilnehmer.</p>'
						: `<table>
							<thead><tr><th>Name</th><th>Pausenzeit</th></tr></thead>
							<tbody>
								${participants
									.map(
										(p) => `
									<tr>
										<td>${p.name}</td>
										<td>
											<div class="budget-bar ${budgetBarClass(p.usedMinutes, course.dailyBreakBudgetMinutes)}">
												<span style="width: ${Math.min(100, (p.usedMinutes / course.dailyBreakBudgetMinutes) * 100)}%"></span>
											</div>
											${p.usedMinutes} / ${course.dailyBreakBudgetMinutes} Min.
											${
												p.usedMinutes > course.dailyBreakBudgetMinutes
													? `<span class="budget-overage"> (+${p.usedMinutes - course.dailyBreakBudgetMinutes} Min. über Budget)</span>`
													: ""
											}
										</td>
									</tr>`,
									)
									.join("")}
							</tbody>
						</table>`
				}
			</div>
		`;
	} catch (error) {
		container.innerHTML = `<p class="error">${error.message}</p>`;
	}
}

async function renderHistorySection(container, dashboardToken, course) {
	let availableDays = [];
	try {
		({ days: availableDays } = await api.getDashboardDays(dashboardToken));
	} catch {
		container.innerHTML = "";
		return;
	}

	if (availableDays.length === 0) {
		container.innerHTML = "";
		return;
	}

	container.innerHTML = `
		<h2>Verlauf</h2>
		<div class="card">
			<p class="muted">Nur Tage mit erfassten Daten werden angezeigt.</p>
			<div id="calendar-grid" class="link-row"></div>
			<div id="day-detail" style="margin-top: 14px;"></div>
		</div>
	`;

	const grid = container.querySelector("#calendar-grid");
	const detail = container.querySelector("#day-detail");

	availableDays.forEach((date) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "secondary";
		button.textContent = formatShortDate(date);
		button.addEventListener("click", () => loadDayDetail(dashboardToken, course, date, detail));
		grid.appendChild(button);
	});
}

export async function renderDashboard(root, dashboardToken) {
	root.innerHTML = `<p class="muted">Lädt…</p>`;

	let course;
	try {
		({ course } = await api.getDashboard(dashboardToken));
	} catch (error) {
		root.innerHTML = `<h1>Nicht gefunden</h1><p class="error">${error.message}</p>`;
		return;
	}
	document.title = course.name;

	const checkinUrl = `${await getBaseUrl()}/k/${course.checkinCode}`;
	// Merkt sich den zuletzt gesehenen Status je Teilnehmer, um einen
	// Wechsel "In der Pause" -> "Anwesend" zwischen zwei Abfragen zu
	// erkennen (siehe justReturnedIds unten in loadLive).
	const previousStatusById = new Map();
	root.innerHTML = `
		${renderBrandHeader(course)}
		<nav class="top">
			<div>
				<h1 id="course-name"></h1>
				<p class="muted" id="course-meta"></p>
			</div>
			<div class="qr-box">
				<img src="/api/checkin/${course.checkinCode}/qrcode.svg" alt="QR-Code für Check-in" />
				<code>${checkinUrl}</code>
			</div>
		</nav>

		<div class="card" id="live-table"></div>
		<div id="history-section"></div>
	`;

	async function loadLive() {
		let data;
		try {
			data = await api.getDashboard(dashboardToken);
		} catch (error) {
			// Nur bei einem einzelnen fehlgeschlagenen Poll NICHT die ganze Seite
			// durch eine Fehlermeldung ersetzen: das würde die Elemente zerstören,
			// die der nächste erfolgreiche Poll aktualisiert, und die Anzeige
			// bliebe dauerhaft hängen, bis manuell neu geladen wird. Stattdessen
			// einfach beim nächsten Intervall erneut versuchen.
			console.error("Dashboard-Update fehlgeschlagen, nächster Versuch beim nächsten Poll:", error);
			return false;
		}

		root.querySelector("#course-name").textContent = data.course.name;
		root.querySelector("#course-meta").textContent = data.course.hasBreakTracking
			? `Start: ${data.course.startDate} · Laufzeit: ${data.course.durationDays} Tag(e) · Tägl. Pausenbudget: ${data.course.dailyBreakBudgetMinutes} Min.`
			: `Start: ${data.course.startDate} · Laufzeit: ${data.course.durationDays} Tag(e)`;

		// Jemand, der zwischen der letzten und dieser Abfrage von "In der
		// Pause" auf "Anwesend" gewechselt ist, hat gerade (angeblich)
		// eingecheckt – dessen Zeile bekommt die Aufmerksamkeits-Animation.
		const justReturnedIds = new Set();
		data.participants.forEach((p) => {
			if (previousStatusById.get(p.id) === "on_break" && p.status === "present") {
				justReturnedIds.add(p.id);
			}
			previousStatusById.set(p.id, p.status);
		});

		const liveTable = root.querySelector("#live-table");
		if (data.participants.length === 0) {
			liveTable.innerHTML = '<p class="muted">Noch niemand eingecheckt.</p>';
		} else if (data.participants.length > TWO_COLUMN_THRESHOLD) {
			// Zwei Spalten (je ~halb so viele Zeilen), damit auch größere
			// Kurse ohne langes Scrollen übersichtlich bleiben.
			const mid = Math.ceil(data.participants.length / 2);
			const left = data.participants.slice(0, mid);
			const right = data.participants.slice(mid);
			liveTable.innerHTML = `
				<div class="dashboard-columns">
					${participantTable(left, data.course.dailyBreakBudgetMinutes, data.course.hasBreakTracking, justReturnedIds)}
					${participantTable(right, data.course.dailyBreakBudgetMinutes, data.course.hasBreakTracking, justReturnedIds)}
				</div>
			`;
		} else {
			liveTable.innerHTML = participantTable(
				data.participants,
				data.course.dailyBreakBudgetMinutes,
				data.course.hasBreakTracking,
				justReturnedIds,
			);
		}
		return true;
	}

	await loadLive();
	if (course.hasBreakTracking) {
		await renderHistorySection(root.querySelector("#history-section"), dashboardToken, course);
	}

	// Bewusst kein Pausieren über die Page Visibility API: der serverseitige
	// Edge-Cache (siehe dashboard.ts, DASHBOARD_CACHE_SECONDS) deckelt die
	// D1-Kosten bereits unabhängig vom Poll-Verhalten des Clients. Eine
	// zusätzliche Client-Pause hätte hier nur noch Zuverlässigkeitsrisiko
	// ohne nennenswerten Kostenvorteil (document.hidden kehrt nicht in jeder
	// Browser-/OS-Kombination zuverlässig zurück auf "sichtbar", wodurch das
	// Dashboard sonst unbemerkt hängenbleiben kann).
	setInterval(loadLive, POLL_INTERVAL_MS);
}

import { api } from "/api.js";

const POLL_INTERVAL_MS = 5000;

function budgetBarClass(usedMinutes, dailyBudget) {
	const remaining = dailyBudget - usedMinutes;
	if (remaining <= 0) return "empty";
	if (remaining <= dailyBudget * 0.2) return "low";
	return "";
}

function participantRow(participant, dailyBudget) {
	const isPresent = participant.status === "present";
	const percent = Math.min(100, (participant.usedMinutesToday / dailyBudget) * 100);
	return `
		<tr>
			<td>${participant.name}</td>
			<td><span class="status-badge ${participant.status}">${isPresent ? "Anwesend" : "In der Pause"}</span></td>
			<td>
				<div class="budget-bar ${budgetBarClass(participant.usedMinutesToday, dailyBudget)}">
					<span style="width: ${percent}%"></span>
				</div>
			</td>
			<td>${participant.remainingMinutesToday} / ${dailyBudget} Min.</td>
		</tr>
	`;
}

function courseDateRange(startDate, durationDays) {
	const [y, m, d] = startDate.split("-").map(Number);
	const dates = [];
	for (let i = 0; i < durationDays; i++) {
		const date = new Date(Date.UTC(y, m - 1, d));
		date.setUTCDate(date.getUTCDate() + i);
		dates.push(date.toISOString().slice(0, 10));
	}
	return dates;
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
	container.innerHTML = `
		<h2>Verlauf</h2>
		<div class="card">
			<div id="calendar-grid" class="link-row"></div>
			<div id="day-detail" style="margin-top: 14px;"></div>
		</div>
	`;

	let availableDays = [];
	try {
		({ days: availableDays } = await api.getDashboardDays(dashboardToken));
	} catch {
		// Kalender ohne Datenindikator anzeigen, falls die Abfrage fehlschlägt
	}

	const grid = container.querySelector("#calendar-grid");
	const detail = container.querySelector("#day-detail");
	const todayLocal = new Date().toISOString().slice(0, 10);

	courseDateRange(course.startDate, course.durationDays).forEach((date) => {
		const hasData = availableDays.includes(date);
		const button = document.createElement("button");
		button.type = "button";
		button.className = "secondary";
		button.textContent = formatShortDate(date);
		if (date > todayLocal) {
			button.disabled = true;
			button.title = "Liegt in der Zukunft";
		}
		if (hasData) {
			button.style.borderColor = "var(--color-present)";
			button.style.fontWeight = "700";
		}
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

	const checkinUrl = `${window.location.origin}/k/${course.checkinCode}`;
	root.innerHTML = `
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
			root.innerHTML = `<h1>Nicht gefunden</h1><p class="error">${error.message}</p>`;
			return false;
		}

		root.querySelector("#course-name").textContent = data.course.name;
		root.querySelector("#course-meta").textContent =
			`Start: ${data.course.startDate} · Laufzeit: ${data.course.durationDays} Tag(e) · Tägl. Pausenbudget: ${data.course.dailyBreakBudgetMinutes} Min.`;

		const liveTable = root.querySelector("#live-table");
		liveTable.innerHTML =
			data.participants.length === 0
				? '<p class="muted">Noch niemand eingecheckt.</p>'
				: `<table>
					<thead><tr><th>Name</th><th>Status</th><th>Pausenbudget</th><th></th></tr></thead>
					<tbody>${data.participants.map((p) => participantRow(p, data.course.dailyBreakBudgetMinutes)).join("")}</tbody>
				</table>`;
		return true;
	}

	await loadLive();
	await renderHistorySection(root.querySelector("#history-section"), dashboardToken, course);
	setInterval(loadLive, POLL_INTERVAL_MS);
}

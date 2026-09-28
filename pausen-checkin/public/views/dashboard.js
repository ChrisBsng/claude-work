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

export async function renderDashboard(root, dashboardToken) {
	root.innerHTML = `<p class="muted">Lädt…</p>`;

	async function load() {
		let data;
		try {
			data = await api.getDashboard(dashboardToken);
		} catch (error) {
			root.innerHTML = `<h1>Nicht gefunden</h1><p class="error">${error.message}</p>`;
			return false;
		}

		const { course, participants } = data;
		const checkinUrl = `${window.location.origin}/k/${course.checkinCode}`;

		root.innerHTML = `
			<nav class="top">
				<div>
					<h1>${course.name}</h1>
					<p class="muted">
						Start: ${course.startDate} · Laufzeit: ${course.durationDays} Tag(e) ·
						Tägl. Pausenbudget: ${course.dailyBreakBudgetMinutes} Min.
					</p>
				</div>
				<div class="qr-box">
					<img src="/api/checkin/${course.checkinCode}/qrcode.svg" alt="QR-Code für Check-in" />
					<code>${checkinUrl}</code>
				</div>
			</nav>

			<div class="card">
				${
					participants.length === 0
						? '<p class="muted">Noch niemand eingecheckt.</p>'
						: `<table>
							<thead>
								<tr><th>Name</th><th>Status</th><th>Pausenbudget</th><th></th></tr>
							</thead>
							<tbody>${participants.map((p) => participantRow(p, course.dailyBreakBudgetMinutes)).join("")}</tbody>
						</table>`
				}
			</div>
		`;
		return true;
	}

	await load();
	setInterval(load, POLL_INTERVAL_MS);
}

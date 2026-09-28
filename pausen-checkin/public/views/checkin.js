import { api } from "/api.js";

const POLL_INTERVAL_MS = 5000;

function tokenKey(checkinCode) {
	return `pausenCheckin.access.${checkinCode}`;
}

function budgetBarClass(budget) {
	if (budget.remainingMinutesToday <= 0) return "empty";
	if (budget.remainingMinutesToday <= budget.dailyBreakBudgetMinutes * 0.2) return "low";
	return "";
}

export async function renderCheckin(root, checkinCode) {
	root.innerHTML = `<p class="muted">Lädt…</p>`;

	let course;
	try {
		({ course } = await api.getCourseByCheckinCode(checkinCode));
	} catch (error) {
		root.innerHTML = `<h1>Nicht gefunden</h1><p class="error">${error.message}</p>`;
		return;
	}

	const storedToken = localStorage.getItem(tokenKey(checkinCode));
	if (storedToken) {
		try {
			const me = await api.getMe(checkinCode, storedToken);
			renderStatus(root, checkinCode, course, storedToken, me);
			return;
		} catch {
			localStorage.removeItem(tokenKey(checkinCode));
		}
	}

	renderRegistration(root, checkinCode, course);
}

function renderRegistration(root, checkinCode, course) {
	root.innerHTML = `
		<h1>${course.name}</h1>
		<p class="muted">Tägliches Pausenbudget: ${course.dailyBreakBudgetMinutes} Minuten</p>
		<div class="card">
			<h2>Anmelden</h2>
			<form id="register-form">
				<label for="name">Dein Name</label>
				<input type="text" id="name" required autofocus />
				<div id="register-error"></div>
				<button type="submit">Loslegen</button>
			</form>
		</div>
	`;

	root.querySelector("#register-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		const errorBox = root.querySelector("#register-error");
		const name = root.querySelector("#name").value.trim();
		try {
			const result = await api.registerParticipant(checkinCode, name);
			localStorage.setItem(tokenKey(checkinCode), result.accessToken);
			renderStatus(root, checkinCode, course, result.accessToken, result);
		} catch (error) {
			errorBox.textContent = error.message;
			errorBox.className = "error";
		}
	});
}

function renderStatus(root, checkinCode, course, accessToken, data) {
	let pollTimer = null;
	let toggleInFlight = false;

	function paint({ participant, budget }) {
		const isPresent = participant.status === "present";
		root.innerHTML = `
			<h1>${course.name}</h1>
			<div class="card center">
				<p class="muted">Angemeldet als</p>
				<h2>${participant.name}</h2>
				<p><span class="status-badge ${participant.status}">${isPresent ? "Anwesend" : "In der Pause"}</span></p>

				<p class="muted" style="margin-top: 20px;">
					Pausenbudget heute: ${budget.usedMinutesToday} / ${course.dailyBreakBudgetMinutes} Min. verbraucht
				</p>
				<div class="budget-bar ${budgetBarClass({ ...budget, dailyBreakBudgetMinutes: course.dailyBreakBudgetMinutes })}">
					<span style="width: ${Math.min(100, (budget.usedMinutesToday / course.dailyBreakBudgetMinutes) * 100)}%"></span>
				</div>
				<p>${budget.remainingMinutesToday} Minuten übrig</p>

				<button type="button" id="toggle" class="toggle-button ${participant.status}">
					${isPresent ? "Pause beginnen" : "Zurück von der Pause"}
				</button>
			</div>
		`;

		root.querySelector("#toggle").addEventListener("click", async () => {
			if (toggleInFlight) return;
			toggleInFlight = true;
			const button = root.querySelector("#toggle");
			button.disabled = true;
			try {
				const result = await api.toggleCheckin(checkinCode, accessToken);
				paint(result);
			} catch (error) {
				if (error.status === 401 || error.status === 404) {
					localStorage.removeItem(tokenKey(checkinCode));
					clearInterval(pollTimer);
					renderRegistration(root, checkinCode, course);
					return;
				}
				button.disabled = false;
			} finally {
				toggleInFlight = false;
			}
		});
	}

	paint(data);

	pollTimer = setInterval(async () => {
		if (toggleInFlight) return;
		try {
			const me = await api.getMe(checkinCode, accessToken);
			paint(me);
		} catch (error) {
			if (error.status === 401 || error.status === 404) {
				localStorage.removeItem(tokenKey(checkinCode));
				clearInterval(pollTimer);
				renderRegistration(root, checkinCode, course);
			}
		}
	}, POLL_INTERVAL_MS);
}

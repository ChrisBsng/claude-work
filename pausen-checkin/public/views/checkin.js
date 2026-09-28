import { api } from "/api.js";
import { renderBrandHeader } from "/brandHeader.js";

const POLL_INTERVAL_MS = 5000;

function tokenKey(checkinCode) {
	return `pausenCheckin.access.${checkinCode}`;
}

function budgetBarClass(usedMinutes, dailyBudget) {
	const remaining = dailyBudget - usedMinutes;
	if (remaining <= 0) return "empty";
	if (remaining <= dailyBudget * 0.2) return "low";
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

	renderLogin(root, checkinCode, course);
}

async function renderLogin(root, checkinCode, course) {
	let names = [];
	let groups = [];
	try {
		({ names } = await api.getCheckinParticipantNames(checkinCode));
	} catch {
		// Ohne Namensliste geht es auch, dann eben nur Freitext-Eingabe.
	}
	try {
		({ groups } = await api.getCheckinGroups(checkinCode));
	} catch {
		// Ohne Gruppenliste geht es auch, dann eben nur Freitext-Eingabe.
	}

	const hasNames = names.length > 0;
	const hasGroups = groups.length > 0;

	root.innerHTML = `
		${renderBrandHeader(course)}
		<h1>${course.name}</h1>
		${course.hasBreakTracking ? `<p class="muted">Tägliches Pausenbudget: ${course.dailyBreakBudgetMinutes} Minuten</p>` : ""}
		<div class="card">
			<h2>Anmelden</h2>
			<form id="login-form">
				${
					hasNames
						? `<label for="name-select">Dein Name</label>
						<select id="name-select">
							<option value="">-- Auswählen --</option>
							${names.map((n) => `<option value="${n}">${n}</option>`).join("")}
							<option value="__new__">Ich bin neu / nicht in der Liste</option>
						</select>
						<div id="new-name-wrapper" hidden>
							<label for="new-name">Dein Name</label>
							<input type="text" id="new-name" />
						</div>`
						: `<label for="new-name">Dein Name</label>
						<input type="text" id="new-name" autofocus required />`
				}

				<div id="group-field-wrapper" ${hasNames ? "hidden" : ""}>
					${
						hasGroups
							? `<label for="group-select">Deine Gruppe</label>
							<select id="group-select">
								<option value="">-- Auswählen --</option>
								${groups.map((g) => `<option value="${g}">${g}</option>`).join("")}
								<option value="__new__">Neue Gruppe / nicht in der Liste</option>
							</select>
							<div id="new-group-wrapper" hidden>
								<label for="new-group">Neue Gruppe</label>
								<input type="text" id="new-group" />
							</div>`
							: `<label for="new-group">Deine Gruppe</label>
							<input type="text" id="new-group" />`
					}
				</div>

				<label for="password">Passwort</label>
				<input type="password" id="password" minlength="4" required />
				<p class="muted">
					Neu hier? Vergib jetzt ein Passwort. Schon registriert? Gib dein Passwort ein
					${hasNames ? "(hast du noch keins, wird dein jetziges als neues Passwort übernommen)" : ""}.
				</p>

				<div id="login-error"></div>
				<button type="submit">Anmelden</button>
			</form>
		</div>
	`;

	const nameSelect = root.querySelector("#name-select");
	const newNameWrapper = root.querySelector("#new-name-wrapper");
	const groupFieldWrapper = root.querySelector("#group-field-wrapper");
	if (nameSelect) {
		nameSelect.addEventListener("change", () => {
			const isNew = nameSelect.value === "__new__";
			newNameWrapper.hidden = !isNew;
			groupFieldWrapper.hidden = !isNew;
			if (isNew) root.querySelector("#new-name").focus();
		});
	}

	const groupSelect = root.querySelector("#group-select");
	const newGroupWrapper = root.querySelector("#new-group-wrapper");
	if (groupSelect) {
		groupSelect.addEventListener("change", () => {
			const isNew = groupSelect.value === "__new__";
			newGroupWrapper.hidden = !isNew;
			if (isNew) root.querySelector("#new-group").focus();
		});
	}

	root.querySelector("#login-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		const errorBox = root.querySelector("#login-error");
		errorBox.textContent = "";

		const isNewParticipant = !hasNames || nameSelect.value === "__new__";
		const name = (isNewParticipant ? root.querySelector("#new-name")?.value : nameSelect.value)?.trim();
		const group = isNewParticipant
			? (groupSelect && groupSelect.value !== "__new__" ? groupSelect.value : root.querySelector("#new-group")?.value)?.trim()
			: undefined;
		const password = root.querySelector("#password").value;

		if (!name) {
			errorBox.textContent = "Bitte einen Namen angeben.";
			errorBox.className = "error";
			return;
		}
		if (isNewParticipant && !group) {
			errorBox.textContent = "Bitte eine Gruppe angeben.";
			errorBox.className = "error";
			return;
		}

		try {
			const result = await api.loginParticipant(checkinCode, name, password, group);
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
	let actionInFlight = false;

	async function performToggle(explicitStatus) {
		if (actionInFlight) return;
		actionInFlight = true;
		try {
			const result = await api.toggleCheckin(checkinCode, accessToken, explicitStatus);
			paint(result);
		} catch (error) {
			if (error.status === 401 || error.status === 404) {
				localStorage.removeItem(tokenKey(checkinCode));
				clearInterval(pollTimer);
				renderLogin(root, checkinCode, course);
				return;
			}
		} finally {
			actionInFlight = false;
		}
	}

	function paint({ participant, budget }) {
		const statusLabel = { present: "Anwesend", on_break: "In der Pause", unknown: "Unbekannt" }[participant.status];

		let actionHtml;
		if (participant.status === "unknown") {
			actionHtml = `
				<p class="muted" style="margin-top: 20px;">Noch keine Aktion heute – wie startest du?</p>
				<div class="choice-row">
					<button type="button" id="choose-present">Ich bin da</button>
					<button type="button" id="choose-break" class="secondary">Ich mache Pause</button>
				</div>
			`;
		} else {
			const isPresent = participant.status === "present";
			const budgetHtml = course.hasBreakTracking
				? `
				<p class="muted" style="margin-top: 20px;">
					Pausenbudget heute: ${budget.usedMinutesToday} / ${course.dailyBreakBudgetMinutes} Min. verbraucht
				</p>
				<div class="budget-bar ${budgetBarClass(budget.usedMinutesToday, course.dailyBreakBudgetMinutes)}">
					<span style="width: ${Math.min(100, (budget.usedMinutesToday / course.dailyBreakBudgetMinutes) * 100)}%"></span>
				</div>
				<p>${budget.remainingMinutesToday} Minuten übrig</p>
			`
				: "";
			actionHtml = `
				${budgetHtml}
				<button type="button" id="toggle" class="toggle-button ${participant.status}">
					${isPresent ? "Pause beginnen" : "Zurück von der Pause"}
				</button>
			`;
		}

		root.innerHTML = `
			${renderBrandHeader(course)}
			<h1>${course.name}</h1>
			<div class="card center">
				<p class="muted">Angemeldet als</p>
				<h2>${participant.name}</h2>
				<p><span class="status-badge ${participant.status}">${statusLabel}</span></p>
				${actionHtml}
			</div>
		`;

		root.querySelector("#toggle")?.addEventListener("click", () => performToggle());
		root.querySelector("#choose-present")?.addEventListener("click", () => performToggle("present"));
		root.querySelector("#choose-break")?.addEventListener("click", () => performToggle("on_break"));
	}

	paint(data);

	pollTimer = setInterval(async () => {
		if (actionInFlight) return;
		try {
			const me = await api.getMe(checkinCode, accessToken);
			paint(me);
		} catch (error) {
			if (error.status === 401 || error.status === 404) {
				localStorage.removeItem(tokenKey(checkinCode));
				clearInterval(pollTimer);
				renderLogin(root, checkinCode, course);
			}
		}
	}, POLL_INTERVAL_MS);
}

import { api } from "/api.js";
import { renderBrandHeader } from "/brandHeader.js";
import { MAX_TEXT_INPUT_LENGTH, truncateLabel } from "/textUtils.js";

// 15s statt 5s, zusätzlich pausiert via Page Visibility API (siehe unten),
// um die D1-Lesekosten des Live-Pollings spürbar zu senken.
const POLL_INTERVAL_MS = 15000;

function tokenKey(checkinCode) {
	return `pausenCheckin.access.${checkinCode}`;
}

function budgetBarClass(usedMinutes, dailyBudget) {
	const remaining = dailyBudget - usedMinutes;
	if (remaining <= 0) return "empty";
	if (remaining <= dailyBudget * 0.2) return "low";
	return "";
}

function formatDurationShort(minutes) {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (h === 0) return `${m} min`;
	if (m === 0) return `${h} h`;
	return `${h} h ${m} min`;
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
	document.title = course.name;

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
							${names.map((n) => `<option value="${n}" title="${n}">${truncateLabel(n)}</option>`).join("")}
							<option value="__new__">Ich bin neu / nicht in der Liste</option>
						</select>
						<div id="new-name-wrapper" hidden>
							<label for="new-name">Dein Name (Vorname Nachname)</label>
							<input type="text" id="new-name" placeholder="Vorname Nachname" maxlength="${MAX_TEXT_INPUT_LENGTH}" />
						</div>`
						: `<label for="new-name">Dein Name (Vorname Nachname)</label>
						<input type="text" id="new-name" placeholder="Vorname Nachname" maxlength="${MAX_TEXT_INPUT_LENGTH}" autofocus required />`
				}

				<div id="group-field-wrapper" ${hasNames ? "hidden" : ""}>
					${
						hasGroups
							? `<label for="group-select">Deine Gruppe</label>
							<select id="group-select">
								<option value="">-- Auswählen --</option>
								${groups.map((g) => `<option value="${g}" title="${g}">${truncateLabel(g)}</option>`).join("")}
								<option value="__new__">Neue Gruppe / nicht in der Liste</option>
							</select>
							<div id="new-group-wrapper" hidden>
								<label for="new-group">Neue Gruppe</label>
								<input type="text" id="new-group" maxlength="${MAX_TEXT_INPUT_LENGTH}" />
							</div>`
							: `<label for="new-group">Deine Gruppe</label>
							<input type="text" id="new-group" maxlength="${MAX_TEXT_INPUT_LENGTH}" />`
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
	let currentData = data;

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

	function paint(newData) {
		currentData = newData;
		const { participant, budget } = newData;
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
				${
					budget.overMinutesToday > 0
						? `<p class="budget-overage">Budget um ${budget.overMinutesToday} Min. überschritten</p>`
						: `<p>${budget.remainingMinutesToday} Minuten übrig</p>`
				}
			`
				: "";
			actionHtml = `
				${budgetHtml}
				<button type="button" id="toggle" class="toggle-button ${participant.status}">
					${isPresent ? "Pause beginnen" : "Zurück von der Pause"}
				</button>
			`;
		}

		const worklogHtml = course.hasWorklogTracking
			? `<button type="button" class="secondary" id="open-worklog" style="margin-top: 20px;">Erfasse Worklog</button>`
			: "";

		root.innerHTML = `
			${renderBrandHeader(course)}
			<h1>${course.name}</h1>
			<div class="card center">
				<p class="muted">Angemeldet als</p>
				<h2>${participant.name}</h2>
				<p><span class="status-badge ${participant.status}">${statusLabel}</span></p>
				${actionHtml}
				${worklogHtml}
			</div>
		`;

		root.querySelector("#toggle")?.addEventListener("click", () => performToggle());
		root.querySelector("#choose-present")?.addEventListener("click", () => performToggle("present"));
		root.querySelector("#choose-break")?.addEventListener("click", () => performToggle("on_break"));
		root.querySelector("#open-worklog")?.addEventListener("click", () => {
			clearInterval(pollTimer);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			renderWorklogPanel(root, checkinCode, course, accessToken, () => renderStatus(root, checkinCode, course, accessToken, currentData));
		});
	}

	paint(data);

	async function refresh() {
		if (actionInFlight) return;
		try {
			const me = await api.getMe(checkinCode, accessToken);
			paint(me);
		} catch (error) {
			if (error.status === 401 || error.status === 404) {
				localStorage.removeItem(tokenKey(checkinCode));
				clearInterval(pollTimer);
				document.removeEventListener("visibilitychange", onVisibilityChange);
				renderLogin(root, checkinCode, course);
			}
		}
	}

	// Im Hintergrund (Tab minimiert/gewechselt) wird nicht gepollt – spart
	// D1-Lesekosten. Beim Zurückkehren sofort aktualisieren, statt bis zum
	// nächsten Intervall zu warten.
	function onVisibilityChange() {
		if (!document.hidden) refresh();
	}
	document.addEventListener("visibilitychange", onVisibilityChange);

	pollTimer = setInterval(() => {
		if (document.hidden) return;
		refresh();
	}, POLL_INTERVAL_MS);
}

async function renderWorklogPanel(root, checkinCode, course, accessToken, onBack) {
	root.innerHTML = `
		${renderBrandHeader(course)}
		<h1>${course.name}</h1>
		<div class="card">
			<button type="button" class="secondary" id="worklog-back">← Zurück</button>
			<h2>Worklog erfassen</h2>
			<div id="worklog-body"><p class="muted">Lädt…</p></div>
		</div>
	`;
	root.querySelector("#worklog-back").addEventListener("click", onBack);

	const body = root.querySelector("#worklog-body");

	let daysData;
	try {
		daysData = await api.getWorklogDays(checkinCode, accessToken);
	} catch (error) {
		body.innerHTML = `<p class="error">${error.message}</p>`;
		return;
	}

	const { dailyWorklogMinutes, today, days } = daysData;

	if (days.length === 0) {
		body.innerHTML = `<p class="muted">Für diesen Kurs sind noch keine Projekttage hinterlegt.</p>`;
		return;
	}

	const sortedDays = [...days].sort((a, b) => (a.date < b.date ? 1 : -1));
	let tasks = [];
	try {
		({ tasks } = await api.getWorklogTasks(checkinCode, accessToken));
	} catch {
		// Aufgaben-Vorschläge sind optional.
	}

	function dayOptionLabel(day) {
		const [y, m, d] = day.date.split("-");
		const label = `${d}.${m}.${y}`;
		const suffix = day.date === today ? " (heute)" : "";
		const mark = day.isComplete ? "✓" : "✗";
		return `${mark} ${label}${suffix} – ${formatDurationShort(day.totalMinutes)} / ${formatDurationShort(dailyWorklogMinutes)}`;
	}

	const initialDate = sortedDays.find((d) => d.date === today)?.date ?? sortedDays[0].date;

	body.innerHTML = `
		<label for="worklog-day-select">Vergangene Projekttage</label>
		<select id="worklog-day-select">
			${sortedDays
				.map((day) => {
					const label = dayOptionLabel(day);
					return `<option value="${day.date}" title="${label}" ${day.date === initialDate ? "selected" : ""}>${truncateLabel(label, 60)}</option>`;
				})
				.join("")}
		</select>

		<div id="worklog-day-detail" style="margin-top: 16px;"><p class="muted">Lädt…</p></div>
	`;

	const daySelect = body.querySelector("#worklog-day-select");
	daySelect.addEventListener("change", () => loadDay(daySelect.value));

	async function loadDay(date) {
		const detail = body.querySelector("#worklog-day-detail");
		detail.innerHTML = `<p class="muted">Lädt…</p>`;
		let dayData;
		try {
			dayData = await api.getWorklogDay(checkinCode, accessToken, date);
		} catch (error) {
			detail.innerHTML = `<p class="error">${error.message}</p>`;
			return;
		}
		renderDayDetail(detail, date, dayData);
	}

	function renderDayDetail(detail, date, dayData) {
		const { entries, totalMinutes, targetMinutes, isComplete } = dayData;

		const entriesHtml = entries.length
			? entries
					.map(
						(entry) => `
						<div class="worklog-entry-row" data-entry-id="${entry.id}">
							<span class="task">${entry.task}</span>
							<span>${formatDurationShort(entry.minutes)}</span>
							<button type="button" class="secondary" data-delete="${entry.id}">Löschen</button>
						</div>
					`,
					)
					.join("")
			: `<p class="muted">Noch keine Einträge für diesen Tag.</p>`;

		const taskOptions = tasks.length
			? `<select id="worklog-task-select">
					<option value="__new__">-- Neuer Task --</option>
					${tasks.map((t) => `<option value="${t}" title="${t}">${truncateLabel(t)}</option>`).join("")}
				</select>
				<div id="worklog-new-task-wrapper">
					<input type="text" id="worklog-new-task" placeholder="Task beschreiben" maxlength="${MAX_TEXT_INPUT_LENGTH}" />
				</div>`
			: `<input type="text" id="worklog-new-task" placeholder="Task beschreiben" maxlength="${MAX_TEXT_INPUT_LENGTH}" />`;

		detail.innerHTML = `
			<p class="worklog-total-badge ${isComplete ? "is-complete" : "is-incomplete"}">
				${formatDurationShort(totalMinutes)} von ${formatDurationShort(targetMinutes)} erfasst
			</p>
			${entriesHtml}

			<h3 style="margin-top: 16px;">Neuer Eintrag</h3>
			<label>Task</label>
			${taskOptions}

			<div style="display: flex; gap: 10px; margin-top: 10px;">
				<div>
					<label for="worklog-hours">Stunden</label>
					<input type="number" id="worklog-hours" min="0" step="1" value="0" style="width: 80px;" />
				</div>
				<div>
					<label for="worklog-minutes">Minuten</label>
					<input type="number" id="worklog-minutes" min="0" max="59" step="5" value="0" style="width: 80px;" />
				</div>
			</div>
			<div id="worklog-entry-error"></div>
			<button type="button" id="worklog-add">Eintrag hinzufügen</button>
		`;

		const taskSelect = detail.querySelector("#worklog-task-select");
		const newTaskWrapper = detail.querySelector("#worklog-new-task-wrapper");
		if (taskSelect) {
			taskSelect.addEventListener("change", () => {
				const isNew = taskSelect.value === "__new__";
				newTaskWrapper.hidden = !isNew;
				if (isNew) detail.querySelector("#worklog-new-task").focus();
			});
		}

		detail.querySelectorAll("[data-delete]").forEach((button) => {
			button.addEventListener("click", async () => {
				button.disabled = true;
				try {
					await api.deleteWorklogEntry(checkinCode, accessToken, date, button.dataset.delete);
					await refreshAfterChange(date);
				} catch (error) {
					button.disabled = false;
					window.alert(error.message);
				}
			});
		});

		detail.querySelector("#worklog-add").addEventListener("click", async () => {
			const errorBox = detail.querySelector("#worklog-entry-error");
			errorBox.textContent = "";

			const task = (
				taskSelect && taskSelect.value !== "__new__" ? taskSelect.value : detail.querySelector("#worklog-new-task")?.value
			)?.trim();
			const hours = Number(detail.querySelector("#worklog-hours").value) || 0;
			const minutes = Number(detail.querySelector("#worklog-minutes").value) || 0;
			const totalMinutes = hours * 60 + minutes;

			if (!task) {
				errorBox.textContent = "Bitte einen Task angeben.";
				errorBox.className = "error";
				return;
			}
			if (totalMinutes <= 0) {
				errorBox.textContent = "Bitte eine Zeit größer als 0 angeben.";
				errorBox.className = "error";
				return;
			}

			try {
				await api.addWorklogEntry(checkinCode, accessToken, date, task, totalMinutes);
				if (!tasks.includes(task)) tasks.unshift(task);
				await refreshAfterChange(date);
			} catch (error) {
				errorBox.textContent = error.message;
				errorBox.className = "error";
			}
		});
	}

	async function refreshAfterChange(date) {
		try {
			const updatedDaysData = await api.getWorklogDays(checkinCode, accessToken);
			const updatedDay = updatedDaysData.days.find((d) => d.date === date);
			if (updatedDay) {
				const option = daySelect.querySelector(`option[value="${date}"]`);
				if (option) option.textContent = dayOptionLabel(updatedDay);
			}
		} catch {
			// Nicht kritisch – Detailansicht wird trotzdem aktualisiert.
		}
		await loadDay(date);
	}

	await loadDay(initialDate);
}

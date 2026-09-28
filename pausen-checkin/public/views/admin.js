import { api } from "/api.js";

const TOKEN_KEY = "pausenCheckin.adminToken";

function getToken() {
	return sessionStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
	sessionStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
	sessionStorage.removeItem(TOKEN_KEY);
}

export function renderAdmin(root) {
	const token = getToken();
	if (token) {
		renderCourses(root, token);
	} else {
		renderLogin(root);
	}
}

function renderLogin(root, message) {
	root.innerHTML = `
		<h1>Admin-Bereich</h1>
		<div class="card">
			<form id="login-form">
				<label for="password">Passwort</label>
				<input type="password" id="password" name="password" required autofocus />
				${message ? `<p class="error">${message}</p>` : ""}
				<button type="submit">Anmelden</button>
			</form>
		</div>
	`;

	root.querySelector("#login-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		const password = root.querySelector("#password").value;
		try {
			const { token } = await api.adminLogin(password);
			setToken(token);
			renderCourses(root, token);
		} catch (error) {
			renderLogin(root, error.message);
		}
	});
}

function courseUrl(path) {
	return `${window.location.origin}${path}`;
}

async function copyToClipboard(text, button) {
	try {
		await navigator.clipboard.writeText(text);
		const original = button.textContent;
		button.textContent = "Kopiert!";
		setTimeout(() => (button.textContent = original), 1500);
	} catch {
		// Zwischenablage evtl. nicht verfügbar – kein Fehler, der Link steht ja als Text da.
	}
}

async function downloadExport(token, course) {
	const blob = await api.exportCourseXlsxBlob(token, course.id);
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `${course.name.replace(/[^\p{L}\p{N}\- ]+/gu, "").trim() || "kurs"}.xlsx`;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

function formatMinutes(minutes) {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

async function renderReportPanel(container, token, course) {
	container.innerHTML = `<p class="muted">Lädt Statistik…</p>`;
	try {
		const stats = await api.getCourseStats(token, course.id);
		container.innerHTML = `
			<p class="muted">
				${stats.participantCount} Teilnehmer(in) · Gesamt-Pausenzeit bisher: ${formatMinutes(stats.totalBreakMinutes)}
			</p>
			<button type="button" id="export-btn">Als Excel (.xlsx) exportieren</button>
		`;
		container.querySelector("#export-btn").addEventListener("click", async (event) => {
			const button = event.target;
			button.disabled = true;
			button.textContent = "Erzeuge Datei…";
			try {
				await downloadExport(token, course);
			} finally {
				button.disabled = false;
				button.textContent = "Als Excel (.xlsx) exportieren";
			}
		});
	} catch (error) {
		container.innerHTML = `<p class="error">${error.message}</p>`;
	}
}

function courseRow(course, token, onSelectionChange) {
	const dashboardUrl = courseUrl(`/d/${course.dashboardToken}`);
	const checkinUrl = courseUrl(`/k/${course.checkinCode}`);

	const tr = document.createElement("tr");
	tr.innerHTML = `
		<td><input type="checkbox" class="row-select" /></td>
		<td>
			<strong>${course.name}</strong>
			<div class="muted">Start: ${course.startDate} · Laufzeit: ${course.durationDays} Tag(e) · Pausenbudget: ${course.dailyBreakBudgetMinutes} Min./Tag</div>
			<div class="link-row">
				<code>${dashboardUrl}</code>
				<button type="button" class="secondary" data-copy="${dashboardUrl}">Dashboard kopieren</button>
				<a href="${dashboardUrl}" target="_blank" rel="noopener">Öffnen</a>
			</div>
			<div class="link-row">
				<code>${checkinUrl}</code>
				<button type="button" class="secondary" data-copy="${checkinUrl}">Check-in kopieren</button>
				<a href="${checkinUrl}" target="_blank" rel="noopener">Öffnen</a>
			</div>
			<button type="button" class="secondary" data-toggle-report>Report / Statistik</button>
			<div class="card" data-report hidden style="margin-top: 10px;"></div>
		</td>
	`;

	tr.querySelector(".row-select").addEventListener("change", onSelectionChange);
	tr.querySelectorAll("[data-copy]").forEach((button) => {
		button.addEventListener("click", () => copyToClipboard(button.dataset.copy, button));
	});

	const reportPanel = tr.querySelector("[data-report]");
	tr.querySelector("[data-toggle-report]").addEventListener("click", async () => {
		const isHidden = reportPanel.hasAttribute("hidden");
		if (isHidden) {
			reportPanel.removeAttribute("hidden");
			await renderReportPanel(reportPanel, token, course);
		} else {
			reportPanel.setAttribute("hidden", "");
		}
	});

	return tr;
}

async function renderCourses(root, token) {
	root.innerHTML = `
		<nav class="top">
			<h1>Admin-Bereich</h1>
			<button type="button" id="logout" class="secondary">Abmelden</button>
		</nav>

		<div class="card">
			<h2>Neuen Kurs anlegen</h2>
			<form id="course-form">
				<label for="name">Name</label>
				<input type="text" id="name" required />

				<label for="durationDays">Laufzeit (Tage)</label>
				<input type="number" id="durationDays" min="1" step="1" required />

				<label for="dailyBreakBudgetMinutes">Tägliches Pausenbudget (Minuten)</label>
				<input type="number" id="dailyBreakBudgetMinutes" min="1" step="1" required />

				<div id="course-form-error"></div>
				<button type="submit">Kurs anlegen</button>
			</form>
		</div>

		<h2>Bestehende Kurse</h2>
		<div class="link-row" id="bulk-bar" hidden>
			<strong><span id="selected-count">0</span> ausgewählt</strong>
			<button type="button" id="bulk-delete" class="secondary" style="color: var(--color-danger); border-color: var(--color-danger);">
				Endgültig löschen
			</button>
		</div>
		<div id="course-list"><p class="muted">Lädt…</p></div>
	`;

	root.querySelector("#logout").addEventListener("click", () => {
		clearToken();
		renderLogin(root);
	});

	function handleAuthError(error) {
		if (error.status === 401) {
			clearToken();
			renderLogin(root, "Sitzung abgelaufen, bitte erneut anmelden.");
			return true;
		}
		return false;
	}

	root.querySelector("#course-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		const errorBox = root.querySelector("#course-form-error");
		errorBox.textContent = "";
		const name = root.querySelector("#name").value.trim();
		const durationDays = Number(root.querySelector("#durationDays").value);
		const dailyBreakBudgetMinutes = Number(root.querySelector("#dailyBreakBudgetMinutes").value);

		try {
			await api.adminCreateCourse(token, { name, durationDays, dailyBreakBudgetMinutes });
			event.target.reset();
			await loadCourses();
		} catch (error) {
			if (handleAuthError(error)) return;
			errorBox.textContent = error.message;
			errorBox.className = "error";
		}
	});

	function updateBulkBar() {
		const checked = root.querySelectorAll(".row-select:checked");
		const bar = root.querySelector("#bulk-bar");
		root.querySelector("#selected-count").textContent = checked.length;
		bar.hidden = checked.length === 0;
	}

	root.querySelector("#bulk-delete").addEventListener("click", async () => {
		const rows = [...root.querySelectorAll("#course-table tbody tr")];
		const selectedIds = rows
			.filter((row) => row.querySelector(".row-select").checked)
			.map((row) => Number(row.dataset.courseId));

		if (selectedIds.length === 0) return;
		const confirmed = window.confirm(
			`${selectedIds.length} Kurs(e) inkl. aller Teilnehmerdaten endgültig löschen? Das kann nicht rückgängig gemacht werden.`,
		);
		if (!confirmed) return;

		try {
			await api.bulkDeleteCourses(token, selectedIds);
			await loadCourses();
		} catch (error) {
			if (handleAuthError(error)) return;
			window.alert(error.message);
		}
	});

	async function loadCourses() {
		const list = root.querySelector("#course-list");
		try {
			const { courses } = await api.adminListCourses(token);
			if (courses.length === 0) {
				list.innerHTML = '<p class="muted">Noch keine Kurse angelegt.</p>';
				root.querySelector("#bulk-bar").hidden = true;
				return;
			}

			const table = document.createElement("table");
			table.id = "course-table";
			table.innerHTML = `
				<thead>
					<tr>
						<th><input type="checkbox" id="select-all" /></th>
						<th>Kurs</th>
					</tr>
				</thead>
				<tbody></tbody>
			`;
			const tbody = table.querySelector("tbody");
			courses.forEach((course) => {
				const row = courseRow(course, token, updateBulkBar);
				row.dataset.courseId = course.id;
				tbody.appendChild(row);
			});

			list.innerHTML = "";
			list.appendChild(table);

			table.querySelector("#select-all").addEventListener("change", (event) => {
				tbody.querySelectorAll(".row-select").forEach((checkbox) => (checkbox.checked = event.target.checked));
				updateBulkBar();
			});
			updateBulkBar();
		} catch (error) {
			if (handleAuthError(error)) return;
			list.innerHTML = `<p class="error">${error.message}</p>`;
		}
	}

	await loadCourses();
}

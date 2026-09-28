import { api } from "/api.js";
import { getBaseUrl } from "/baseUrl.js";
import { MAX_TEXT_INPUT_LENGTH, truncateLabel } from "/textUtils.js";

const TOKEN_KEY = "pausenCheckin.adminToken";
const ROLE_KEY = "pausenCheckin.adminRole";
const SCHULSTUNDE_MINUTES = 45;
const OVERTIME_WARNING_TOLERANCE_MINUTES = 5;

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

function formatDurationLabel(minutes) {
	const schulstunden = Math.round((minutes / SCHULSTUNDE_MINUTES) * 10) / 10;
	const schulstundenLabel = Number.isInteger(schulstunden) ? String(schulstunden) : schulstunden.toFixed(1);
	const hours = Math.floor(minutes / 60);
	const remainderMinutes = minutes % 60;
	const hoursLabel = remainderMinutes > 0 ? `${hours} h ${remainderMinutes} min` : `${hours} h`;
	return `${schulstundenLabel} Schulstunde${schulstunden === 1 ? "" : "n"} (${hoursLabel})`;
}

function getToken() {
	return sessionStorage.getItem(TOKEN_KEY);
}

function getRole() {
	return sessionStorage.getItem(ROLE_KEY) === "readonly" ? "readonly" : "admin";
}

function setSession(token, role) {
	sessionStorage.setItem(TOKEN_KEY, token);
	sessionStorage.setItem(ROLE_KEY, role);
}

function clearToken() {
	sessionStorage.removeItem(TOKEN_KEY);
	sessionStorage.removeItem(ROLE_KEY);
}

// Deaktiviert alle Formularfelder/Buttons in einem Bereich für die
// Read-Only-Rolle. Schreibende Aktionen, die außerhalb eines <form>
// liegen (z. B. dynamisch erzeugte Kalender-Buttons), werden erfasst,
// indem der jeweilige Bereich in ein <form> gewrappt wird – so reicht
// dieser eine, generische Sweep für die ganze Admin-Oberfläche.
function lockIfReadOnly(container, role) {
	if (role !== "readonly") return;
	container.querySelectorAll("form input, form select, form textarea, form button, [data-write-action]").forEach((el) => {
		el.disabled = true;
	});
}

async function courseUrl(path) {
	return `${await getBaseUrl()}${path}`;
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

function formatMinutes(minutes) {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function renderAdmin(root) {
	root.classList.add("admin-app");
	const token = getToken();
	if (token) {
		renderAdminShell(root, token, getRole());
	} else {
		renderLogin(root);
	}
}

function renderLogin(root, message) {
	root.innerHTML = `
		<div style="max-width: 960px; margin: 0 auto; padding: 24px 16px;">
			<h1>Admin-Bereich</h1>
			<div class="card">
				<form id="login-form">
					<label for="role">Zugriffsart</label>
					<select id="role">
						<option value="admin">Admin (voller Zugriff)</option>
						<option value="readonly">Nur Lesen (Read-Only)</option>
					</select>

					<label for="password">Passwort</label>
					<input type="password" id="password" name="password" required autofocus />
					${message ? `<p class="error">${message}</p>` : ""}
					<button type="submit">Anmelden</button>
				</form>
			</div>
		</div>
	`;

	root.querySelector("#login-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		const password = root.querySelector("#password").value;
		const role = root.querySelector("#role").value;
		try {
			const { token, role: confirmedRole } = await api.adminLogin(password, role);
			setSession(token, confirmedRole);
			renderAdminShell(root, token, confirmedRole);
		} catch (error) {
			renderLogin(root, error.message);
		}
	});
}

// --- Shell: Sidebar + Hauptbereich -----------------------------------

async function renderAdminShell(root, token, role) {
	root.innerHTML = `
		<div class="admin-layout">
			<nav class="admin-sidebar">
				<div class="admin-sidebar-title">Admin-Bereich</div>
				${role === "readonly" ? `<div class="readonly-badge">Nur Lesen (Read-Only)</div>` : ""}
				<div id="sidebar-tree"></div>
				<button type="button" class="sidebar-item" id="sidebar-images">Bilder</button>
				<button type="button" class="sidebar-item" id="sidebar-logout" style="margin-top: 20px; color: var(--color-danger);">Abmelden</button>
			</nav>
			<main class="admin-main" id="admin-main"></main>
		</div>
	`;

	root.querySelector("#sidebar-logout").addEventListener("click", () => {
		clearToken();
		renderLogin(root);
	});

	const state = { view: "courses" };
	let courses = [];

	function handleAuthError(error) {
		if (error.status === 401) {
			clearToken();
			renderLogin(root, "Sitzung abgelaufen, bitte erneut anmelden.");
			return true;
		}
		return false;
	}

	async function refreshCourses() {
		try {
			({ courses } = await api.adminListCourses(token));
		} catch (error) {
			if (handleAuthError(error)) return;
			throw error;
		}
		renderSidebarTree();
	}

	function navigate(next) {
		Object.assign(state, next);
		renderSidebarTree();
		renderMain();
	}

	function renderSidebarTree() {
		const container = root.querySelector("#sidebar-tree");
		const isCoursesRoot = state.view === "courses";
		container.innerHTML = `
			<button type="button" class="sidebar-item ${isCoursesRoot ? "active" : ""}" id="sidebar-courses-root">Kurse</button>
			<div id="sidebar-course-list"></div>
		`;
		container.querySelector("#sidebar-courses-root").addEventListener("click", () => navigate({ view: "courses" }));

		const list = container.querySelector("#sidebar-course-list");
		courses.forEach((course) => {
			const isActive = state.view === "course" && state.courseId === course.id;
			const button = document.createElement("button");
			button.type = "button";
			button.className = `sidebar-subitem ${isActive ? "active" : ""}`;
			button.textContent = course.name;
			button.title = course.name;
			button.addEventListener("click", () => navigate({ view: "course", courseId: course.id, tab: "overview" }));
			list.appendChild(button);
		});

		const addNew = document.createElement("button");
		addNew.type = "button";
		addNew.className = "sidebar-subitem add-new";
		addNew.textContent = "+ Neuer Kurs";
		addNew.addEventListener("click", () => navigate({ view: "courses" }));
		list.appendChild(addNew);

		root.querySelector("#sidebar-images").className = `sidebar-item ${state.view === "images" ? "active" : ""}`;
	}

	root.querySelector("#sidebar-images").addEventListener("click", () => navigate({ view: "images" }));

	async function renderMain() {
		const main = root.querySelector("#admin-main");
		if (state.view === "courses") {
			await renderCoursesOverview(main, token, { courses, refreshCourses, handleAuthError, navigate, role });
		} else if (state.view === "images") {
			await renderImagesPage(main, token, role);
		} else if (state.view === "course") {
			await renderCourseDetail(main, token, state, { handleAuthError, refreshCourses, navigate, role });
		}
	}

	await refreshCourses();
	await renderMain();
}

// --- "Kurse"-Übersicht: Tabelle + Bulk-Aktionen + Neuer Kurs ----------

function courseListRow(course, onSelectionChange, onOpen) {
	const tr = document.createElement("tr");
	tr.innerHTML = `
		<td><input type="checkbox" class="row-select" /></td>
		<td><a href="#" class="course-link">${course.name}</a></td>
		<td>${course.startDate}</td>
		<td>${course.durationDays} Tag(e)</td>
		<td>${course.hasBreakTracking ? `${course.dailyBreakBudgetMinutes} Min./Tag` : "–"}</td>
	`;
	tr.querySelector(".row-select").addEventListener("change", onSelectionChange);
	tr.querySelector(".course-link").addEventListener("click", (event) => {
		event.preventDefault();
		onOpen();
	});
	return tr;
}

async function renderCoursesOverview(container, token, { refreshCourses, handleAuthError, navigate, role }) {
	container.innerHTML = `
		<h1>Kurse</h1>

		<div class="card">
			<h2>Neuen Kurs anlegen</h2>
			<form id="course-form">
				<label for="name">Name</label>
				<input type="text" id="name" maxlength="${MAX_TEXT_INPUT_LENGTH}" required />

				<label for="durationDays">Laufzeit (Tage)</label>
				<input type="number" id="durationDays" min="1" step="1" required />

				<label for="dailyBreakBudgetMinutes">Tägliches Pausenbudget (Minuten)</label>
				<input type="number" id="dailyBreakBudgetMinutes" min="1" step="1" required value="30" />

				<div class="toggle-row">
					<input type="checkbox" id="hasBreakTracking" checked />
					<label for="hasBreakTracking">Pausenzeiterfassung</label>
				</div>
				<p class="muted">Die Worklogerfassung kann nach dem Anlegen in den Kurs-Einstellungen aktiviert werden.</p>

				<div id="course-form-error"></div>
				<button type="submit">Kurs anlegen</button>
			</form>
		</div>

		<h2>Bestehende Kurse</h2>
		<form id="course-list-scope">
			<div class="link-row" id="bulk-bar" hidden>
				<strong><span id="selected-count">0</span> ausgewählt</strong>
				<button type="button" id="bulk-delete" class="secondary" style="color: var(--color-danger); border-color: var(--color-danger);">
					Endgültig löschen
				</button>
			</div>
			<div id="course-list"><p class="muted">Lädt…</p></div>
		</form>
	`;

	container.querySelector("#hasBreakTracking").addEventListener("change", (event) => {
		container.querySelector("#dailyBreakBudgetMinutes").disabled = !event.target.checked;
	});

	container.querySelector("#course-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		const errorBox = container.querySelector("#course-form-error");
		errorBox.textContent = "";
		const name = container.querySelector("#name").value.trim();
		const durationDays = Number(container.querySelector("#durationDays").value);
		const dailyBreakBudgetMinutes = Number(container.querySelector("#dailyBreakBudgetMinutes").value);
		const hasBreakTracking = container.querySelector("#hasBreakTracking").checked;

		try {
			await api.adminCreateCourse(token, { name, durationDays, dailyBreakBudgetMinutes, hasBreakTracking });
			event.target.reset();
			await refreshCourses();
			await loadCourseTable();
		} catch (error) {
			if (handleAuthError(error)) return;
			errorBox.textContent = error.message;
			errorBox.className = "error";
		}
	});

	function updateBulkBar() {
		const checked = container.querySelectorAll(".row-select:checked");
		const bar = container.querySelector("#bulk-bar");
		container.querySelector("#selected-count").textContent = checked.length;
		bar.hidden = checked.length === 0;
	}

	container.querySelector("#bulk-delete").addEventListener("click", async () => {
		const rows = [...container.querySelectorAll("#course-table tbody tr")];
		const selectedIds = rows.filter((row) => row.querySelector(".row-select").checked).map((row) => Number(row.dataset.courseId));
		if (selectedIds.length === 0) return;
		const confirmed = window.confirm(
			`${selectedIds.length} Kurs(e) inkl. aller Teilnehmerdaten endgültig löschen? Das kann nicht rückgängig gemacht werden.`,
		);
		if (!confirmed) return;

		try {
			await api.bulkDeleteCourses(token, selectedIds);
			await refreshCourses();
			await loadCourseTable();
		} catch (error) {
			if (handleAuthError(error)) return;
			window.alert(error.message);
		}
	});

	async function loadCourseTable() {
		const list = container.querySelector("#course-list");
		try {
			const { courses } = await api.adminListCourses(token);
			if (courses.length === 0) {
				list.innerHTML = '<p class="muted">Noch keine Kurse angelegt.</p>';
				container.querySelector("#bulk-bar").hidden = true;
				return;
			}

			const table = document.createElement("table");
			table.id = "course-table";
			table.innerHTML = `
				<thead>
					<tr>
						<th><input type="checkbox" id="select-all" /></th>
						<th>Name</th>
						<th>Start</th>
						<th>Laufzeit</th>
						<th>Pausenbudget</th>
					</tr>
				</thead>
				<tbody></tbody>
			`;
			const tbody = table.querySelector("tbody");
			courses.forEach((course) => {
				const row = courseListRow(course, updateBulkBar, () => navigate({ view: "course", courseId: course.id, tab: "overview" }));
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

	await loadCourseTable();
	lockIfReadOnly(container, role);
}

// --- Kurs-Detailansicht mit Tabs ---------------------------------------

const COURSE_TABS = [
	{ id: "overview", label: "Übersicht" },
	{ id: "participants", label: "Teilnehmer" },
	{ id: "groups", label: "Gruppen" },
	{ id: "report", label: "Report / Statistik" },
];

async function renderCourseDetail(container, token, state, { handleAuthError, refreshCourses, navigate, role }) {
	let course;
	try {
		const { courses } = await api.adminListCourses(token);
		course = courses.find((c) => c.id === state.courseId);
	} catch (error) {
		if (handleAuthError(error)) return;
		container.innerHTML = `<p class="error">${error.message}</p>`;
		return;
	}

	if (!course) {
		container.innerHTML = `<p class="error">Kurs nicht gefunden.</p>`;
		return;
	}

	const activeTab = state.tab ?? "overview";

	container.innerHTML = `
		<h1>${course.name}</h1>
		<div class="tab-bar">
			${COURSE_TABS.map((tab) => `<button type="button" class="tab-button ${tab.id === activeTab ? "active" : ""}" data-tab="${tab.id}">${tab.label}</button>`).join("")}
		</div>
		<div id="tab-content"></div>
	`;

	container.querySelectorAll(".tab-button").forEach((button) => {
		button.addEventListener("click", () => navigate({ view: "course", courseId: course.id, tab: button.dataset.tab }));
	});

	const tabContent = container.querySelector("#tab-content");
	const refreshThisCourse = async () => {
		await refreshCourses();
		await renderCourseDetail(container, token, state, { handleAuthError, refreshCourses, navigate, role });
	};

	if (activeTab === "overview") {
		await renderCourseOverviewTab(tabContent, token, course, { handleAuthError, refreshThisCourse, role });
	} else if (activeTab === "participants") {
		await renderCourseParticipantsTab(tabContent, token, course, { handleAuthError, role });
	} else if (activeTab === "groups") {
		await renderCourseGroupsTab(tabContent, token, course, { handleAuthError, role });
	} else if (activeTab === "report") {
		await renderCourseReportTab(tabContent, token, course, { handleAuthError, role });
	}
}

async function renderCourseOverviewTab(container, token, course, { handleAuthError, refreshThisCourse, role }) {
	const dashboardUrl = await courseUrl(`/d/${course.dashboardToken}`);
	const checkinUrl = await courseUrl(`/k/${course.checkinCode}`);

	container.innerHTML = `
		<div class="card">
			<h2>Einstellungen</h2>
			<form id="settings-form">
				<label for="name">Name</label>
				<input type="text" id="name" value="${course.name}" maxlength="${MAX_TEXT_INPUT_LENGTH}" required />

				<label for="durationDays">Laufzeit (Tage)</label>
				<input type="number" id="durationDays" min="1" step="1" value="${course.durationDays}" required />

				<div class="toggle-row">
					<input type="checkbox" id="hasBreakTracking" ${course.hasBreakTracking ? "checked" : ""} />
					<label for="hasBreakTracking">Pausenzeiterfassung</label>
				</div>
				<div id="budget-field" ${course.hasBreakTracking ? "" : "hidden"}>
					<label for="dailyBreakBudgetMinutes">Tägliches Pausenbudget (Minuten)</label>
					<input type="number" id="dailyBreakBudgetMinutes" min="1" step="1" value="${course.dailyBreakBudgetMinutes}" />
				</div>

				<div id="settings-error"></div>
				<button type="submit">Speichern</button>
			</form>
		</div>

		<div class="card">
			<h2>Links</h2>
			<div class="link-row">
				<strong>Dashboard:</strong>
				<code>${dashboardUrl}</code>
				<button type="button" class="secondary" data-copy="${dashboardUrl}">Kopieren</button>
				<a href="${dashboardUrl}" target="_blank" rel="noopener">Öffnen</a>
			</div>
			<div class="link-row">
				<strong>Check-in:</strong>
				<code>${checkinUrl}</code>
				<button type="button" class="secondary" data-copy="${checkinUrl}">Kopieren</button>
				<a href="${checkinUrl}" target="_blank" rel="noopener">Öffnen</a>
			</div>
		</div>

		<div class="card">
			<h2>Header-Logos</h2>
			<div id="header-panel">Lädt…</div>
		</div>

		<div class="card">
			<h2>Worklogerfassung</h2>
			<div id="worklog-panel">Lädt…</div>
		</div>
	`;

	container.querySelector("#hasBreakTracking").addEventListener("change", (event) => {
		container.querySelector("#budget-field").hidden = !event.target.checked;
	});

	container.querySelectorAll("[data-copy]").forEach((button) => {
		button.addEventListener("click", () => copyToClipboard(button.dataset.copy, button));
	});

	container.querySelector("#settings-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		const errorBox = container.querySelector("#settings-error");
		errorBox.textContent = "";
		try {
			await api.updateCourse(token, course.id, {
				name: container.querySelector("#name").value.trim(),
				durationDays: Number(container.querySelector("#durationDays").value),
				dailyBreakBudgetMinutes: Number(container.querySelector("#dailyBreakBudgetMinutes").value) || course.dailyBreakBudgetMinutes,
				hasBreakTracking: container.querySelector("#hasBreakTracking").checked,
			});
			await refreshThisCourse();
		} catch (error) {
			if (handleAuthError(error)) return;
			errorBox.textContent = error.message;
			errorBox.className = "error";
		}
	});

	await renderHeaderPanel(container.querySelector("#header-panel"), token, course, refreshThisCourse);
	await renderWorklogSettingsPanel(container.querySelector("#worklog-panel"), token, course, { handleAuthError, refreshThisCourse, role });

	lockIfReadOnly(container, role);
}

async function renderWorklogSettingsPanel(container, token, course, { handleAuthError, refreshThisCourse }) {
	const dates = courseDateRange(course.startDate, course.durationDays);
	let selectedDates = new Set();
	if (course.hasWorklogTracking) {
		try {
			const { dates: projectDays } = await api.listProjectDays(token, course.id);
			selectedDates = new Set(projectDays);
		} catch (error) {
			if (handleAuthError(error)) return;
		}
	}

	const schulstundenOptions = Array.from({ length: 12 }, (_, i) => i + 1)
		.map((n) => {
			const minutes = n * SCHULSTUNDE_MINUTES;
			const selected = course.dailyWorklogMinutes === minutes ? "selected" : "";
			return `<option value="${minutes}" ${selected}>${n} Schulstunde${n === 1 ? "" : "n"} (${minutes} Min.)</option>`;
		})
		.join("");

	container.innerHTML = `
		<form id="worklog-settings-form">
			<div class="toggle-row">
				<input type="checkbox" id="worklog-enabled" ${course.hasWorklogTracking ? "checked" : ""} />
				<label for="worklog-enabled">Worklogerfassung aktivieren</label>
			</div>
			<div id="worklog-config" ${course.hasWorklogTracking ? "" : "hidden"}>
				<label for="worklog-schulstunden">Tägliche Arbeitszeit</label>
				<select id="worklog-schulstunden">${schulstundenOptions}</select>

				<label style="margin-top: 16px;">Projekttage (anklicken zum Auswählen/Abwählen)</label>
				<div id="worklog-calendar" class="link-row"></div>
				<p class="muted" id="worklog-total" style="margin-top: 10px;"></p>

				<div class="toggle-row" style="margin-top: 16px;">
					<input type="checkbox" id="worklog-allow-overtime" ${course.allowOvertimeCredit ? "checked" : ""} />
					<label for="worklog-allow-overtime">Erlaube Mehrarbeit/Überstunden auf die gesamte Projektzeit anzurechnen</label>
				</div>
				<p class="muted">
					Ohne dieses Häkchen verfallen Minuten, die an einem Tag mehr als ${OVERTIME_WARNING_TOLERANCE_MINUTES} Minuten über dem
					Tagesziel liegen – Teilnehmende erhalten beim Eintragen eine Meldung und müssen die Zeit anpassen.
				</p>
			</div>
			<div id="worklog-error"></div>
			<button type="button" id="worklog-save" style="margin-top: 16px;">Speichern</button>
		</form>
	`;

	const configSection = container.querySelector("#worklog-config");
	const schulstundenSelect = container.querySelector("#worklog-schulstunden");
	const calendar = container.querySelector("#worklog-calendar");
	const totalLabel = container.querySelector("#worklog-total");

	function updateTotal() {
		const dailyMinutes = Number(schulstundenSelect.value);
		const totalMinutes = dailyMinutes * selectedDates.size;
		totalLabel.textContent = `${selectedDates.size} Projekttag(e) × ${dailyMinutes} Min. = ${formatDurationLabel(totalMinutes)} gesamt`;
	}

	function renderCalendar() {
		calendar.innerHTML = "";
		dates.forEach((date) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "secondary";
			const [, m, d] = date.split("-");
			button.textContent = `${d}.${m}.`;
			if (selectedDates.has(date)) {
				button.style.background = "var(--color-primary)";
				button.style.color = "var(--color-primary-contrast)";
			}
			button.addEventListener("click", () => {
				if (selectedDates.has(date)) {
					selectedDates.delete(date);
				} else {
					selectedDates.add(date);
				}
				renderCalendar();
				updateTotal();
			});
			calendar.appendChild(button);
		});
	}

	container.querySelector("#worklog-enabled").addEventListener("change", (event) => {
		configSection.hidden = !event.target.checked;
		if (event.target.checked && calendar.children.length === 0) {
			renderCalendar();
			updateTotal();
		}
	});

	if (course.hasWorklogTracking) {
		renderCalendar();
		updateTotal();
	}
	schulstundenSelect.addEventListener("change", updateTotal);

	container.querySelector("#worklog-save").addEventListener("click", async () => {
		const errorBox = container.querySelector("#worklog-error");
		errorBox.textContent = "";
		const enabled = container.querySelector("#worklog-enabled").checked;
		const allowOvertimeCredit = container.querySelector("#worklog-allow-overtime").checked;

		try {
			await api.updateCourse(token, course.id, {
				hasWorklogTracking: enabled,
				dailyWorklogMinutes: enabled ? Number(schulstundenSelect.value) : undefined,
				allowOvertimeCredit,
			});
			if (enabled) {
				await api.setProjectDays(token, course.id, [...selectedDates]);
			}
			await refreshThisCourse();
		} catch (error) {
			if (handleAuthError(error)) return;
			errorBox.textContent = error.message;
			errorBox.className = "error";
		}
	});
}

function imageOptionLabel(image) {
	return `${image.filename} (${new Date(image.uploadedAt).toLocaleDateString("de-DE")})`;
}

async function renderHeaderPanel(container, token, course, onSaved) {
	let images = [];
	try {
		({ images } = await api.listImages(token));
	} catch (error) {
		container.innerHTML = `<p class="error">${error.message}</p>`;
		return;
	}

	const leftOptions = [
		`<option value="">Standard verwenden</option>`,
		...images.map((img) => {
			const label = imageOptionLabel(img);
			return `<option value="${img.id}" title="${label}" ${course.headerLeftImageOverrideId === img.id ? "selected" : ""}>${truncateLabel(label)}</option>`;
		}),
	].join("");
	const rightOptions = [
		`<option value="">Kein Bild</option>`,
		...images.map((img) => {
			const label = imageOptionLabel(img);
			return `<option value="${img.id}" title="${label}" ${course.headerRightImageId === img.id ? "selected" : ""}>${truncateLabel(label)}</option>`;
		}),
	].join("");

	container.innerHTML = `
		<form id="header-form">
			<label for="header-left-select">Logo links</label>
			<select id="header-left-select">${leftOptions}</select>
			<label for="header-right-select">Logo rechts</label>
			<select id="header-right-select">${rightOptions}</select>
			<div id="header-save-error"></div>
			<button type="button" id="header-save">Speichern</button>
		</form>
		<p class="muted" style="margin-top: 10px;">Neue Bilder hochladen: siehe Sidebar „Bilder“.</p>
	`;

	container.querySelector("#header-save").addEventListener("click", async (event) => {
		const button = event.target;
		const errorBox = container.querySelector("#header-save-error");
		errorBox.textContent = "";
		button.disabled = true;
		try {
			const headerLeftImageId = container.querySelector("#header-left-select").value || null;
			const headerRightImageId = container.querySelector("#header-right-select").value || null;
			await api.updateCourseHeader(token, course.id, { headerLeftImageId, headerRightImageId });
			button.textContent = "Gespeichert!";
			setTimeout(() => (button.textContent = "Speichern"), 1500);
			await onSaved();
		} catch (error) {
			errorBox.textContent = error.message;
			errorBox.className = "error";
		} finally {
			button.disabled = false;
		}
	});
}

// --- Tab: Teilnehmer ---------------------------------------------------

async function renderCourseParticipantsTab(container, token, course, { handleAuthError, role }) {
	container.innerHTML = `<p class="muted">Lädt…</p>`;

	let participants;
	let groups;
	try {
		[{ participants }, { groups }] = await Promise.all([
			api.listCourseParticipants(token, course.id),
			api.listCourseGroups(token, course.id),
		]);
	} catch (error) {
		if (handleAuthError(error)) return;
		container.innerHTML = `<p class="error">${error.message}</p>`;
		return;
	}

	function groupOptions(selectedId) {
		return [
			`<option value="">Keine Gruppe</option>`,
			...groups.map(
				(g) =>
					`<option value="${g.id}" title="${g.name}" ${g.id === selectedId ? "selected" : ""}>${truncateLabel(g.name)}</option>`,
			),
		].join("");
	}

	if (participants.length === 0) {
		container.innerHTML = '<p class="muted">Noch keine Teilnehmer registriert.</p>';
		return;
	}

	const table = document.createElement("table");
	table.innerHTML = `
		<thead><tr><th>Name</th><th>Gruppe</th><th>Angemeldet seit</th><th></th></tr></thead>
		<tbody></tbody>
	`;
	const tbody = table.querySelector("tbody");

	participants.forEach((participant) => {
		const tr = document.createElement("tr");
		const renderView = () => {
			tr.innerHTML = `
				<td>${participant.name}</td>
				<td>${participant.groupName ?? "–"}</td>
				<td>${new Date(participant.createdAt).toLocaleString("de-DE")}</td>
				<td><button type="button" class="secondary" data-edit data-write-action>Bearbeiten</button></td>
			`;
			tr.querySelector("[data-edit]").addEventListener("click", renderEdit);
		};

		const renderEdit = () => {
			tr.innerHTML = `
				<td colspan="4">
					<label>Name</label>
					<input type="text" id="edit-name-${participant.id}" value="${participant.name}" maxlength="${MAX_TEXT_INPUT_LENGTH}" />
					<label>Gruppe</label>
					<select id="edit-group-${participant.id}">${groupOptions(participant.groupId)}</select>
					<div id="edit-error-${participant.id}"></div>
					<div class="link-row" style="margin-top: 10px;">
						<button type="button" id="save-${participant.id}">Speichern</button>
						<button type="button" class="secondary" id="cancel-${participant.id}">Abbrechen</button>
						<button type="button" id="reset-pw-${participant.id}" style="color: var(--color-danger); border-color: var(--color-danger);" class="secondary">
							Passwort zurücksetzen
						</button>
					</div>
				</td>
			`;

			tr.querySelector(`#cancel-${participant.id}`).addEventListener("click", renderView);

			tr.querySelector(`#save-${participant.id}`).addEventListener("click", async () => {
				const errorBox = tr.querySelector(`#edit-error-${participant.id}`);
				errorBox.textContent = "";
				const name = tr.querySelector(`#edit-name-${participant.id}`).value.trim();
				const groupIdRaw = tr.querySelector(`#edit-group-${participant.id}`).value;
				const groupId = groupIdRaw ? Number(groupIdRaw) : null;
				try {
					const { participant: updated } = await api.updateParticipant(token, participant.id, { name, groupId });
					participant.name = updated.name;
					participant.groupId = updated.groupId;
					participant.groupName = groups.find((g) => g.id === updated.groupId)?.name ?? null;
					renderView();
				} catch (error) {
					if (handleAuthError(error)) return;
					errorBox.textContent = error.message;
					errorBox.className = "error";
				}
			});

			tr.querySelector(`#reset-pw-${participant.id}`).addEventListener("click", async () => {
				const confirmed = window.confirm(
					`Passwort von "${participant.name}" zurücksetzen? Die Person wird dadurch abgemeldet und muss beim nächsten Aufruf ein neues Passwort vergeben.`,
				);
				if (!confirmed) return;
				try {
					await api.resetParticipantPassword(token, participant.id);
					window.alert("Passwort wurde zurückgesetzt.");
				} catch (error) {
					if (handleAuthError(error)) return;
					window.alert(error.message);
				}
			});
		};

		renderView();
		tbody.appendChild(tr);
	});

	container.innerHTML = "";
	container.appendChild(table);
	lockIfReadOnly(container, role);
}

// --- Tab: Gruppen -------------------------------------------------------

async function renderCourseGroupsTab(container, token, course, { handleAuthError, role }) {
	container.innerHTML = `
		<div class="card">
			<h2>Neue Gruppe anlegen</h2>
			<form id="group-form">
				<label for="group-name">Name</label>
				<input type="text" id="group-name" maxlength="${MAX_TEXT_INPUT_LENGTH}" required />
				<div id="group-form-error"></div>
				<button type="submit">Anlegen</button>
			</form>
		</div>
		<div id="group-list"><p class="muted">Lädt…</p></div>
	`;

	container.querySelector("#group-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		const errorBox = container.querySelector("#group-form-error");
		errorBox.textContent = "";
		const name = container.querySelector("#group-name").value.trim();
		try {
			await api.createCourseGroup(token, course.id, name);
			event.target.reset();
			await loadGroups();
		} catch (error) {
			if (handleAuthError(error)) return;
			errorBox.textContent = error.message;
			errorBox.className = "error";
		}
	});

	async function loadGroups() {
		const list = container.querySelector("#group-list");
		let groups;
		try {
			({ groups } = await api.listCourseGroups(token, course.id));
		} catch (error) {
			if (handleAuthError(error)) return;
			list.innerHTML = `<p class="error">${error.message}</p>`;
			return;
		}

		if (groups.length === 0) {
			list.innerHTML = '<p class="muted">Noch keine Gruppen angelegt.</p>';
			return;
		}

		const table = document.createElement("table");
		table.innerHTML = `<thead><tr><th>Name</th><th>Mitglieder</th><th></th></tr></thead><tbody></tbody>`;
		const tbody = table.querySelector("tbody");

		groups.forEach((group) => {
			const tr = document.createElement("tr");
			tr.innerHTML = `
				<td><input type="text" value="${group.name}" maxlength="${MAX_TEXT_INPUT_LENGTH}" data-name-input data-write-action /></td>
				<td>${group.memberCount}</td>
				<td>
					<button type="button" class="secondary" data-rename data-write-action>Umbenennen</button>
					<button type="button" class="secondary" data-delete data-write-action style="color: var(--color-danger); border-color: var(--color-danger);">Löschen</button>
				</td>
			`;
			tr.querySelector("[data-rename]").addEventListener("click", async () => {
				const name = tr.querySelector("[data-name-input]").value.trim();
				try {
					await api.renameGroup(token, group.id, name);
					await loadGroups();
				} catch (error) {
					if (handleAuthError(error)) return;
					window.alert(error.message);
				}
			});
			tr.querySelector("[data-delete]").addEventListener("click", async () => {
				const confirmed = window.confirm(
					`Gruppe "${group.name}" löschen? Mitglieder verlieren ihre Gruppenzuordnung (bleiben aber registriert).`,
				);
				if (!confirmed) return;
				try {
					await api.deleteGroup(token, group.id);
					await loadGroups();
				} catch (error) {
					if (handleAuthError(error)) return;
					window.alert(error.message);
				}
			});
			tbody.appendChild(tr);
		});

		list.innerHTML = "";
		list.appendChild(table);
		lockIfReadOnly(container, role);
	}

	await loadGroups();
	lockIfReadOnly(container, role);
}

// --- Tab: Report / Statistik --------------------------------------------

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

async function renderCourseReportTab(container, token, course, { handleAuthError }) {
	container.innerHTML = `<div class="card"><p class="muted">Lädt Statistik…</p></div>`;
	try {
		const stats = await api.getCourseStats(token, course.id);
		container.innerHTML = `
			<div class="card">
				<h2>Statistik</h2>
				<p class="muted">
					${stats.participantCount} Teilnehmer(in) · Gesamt-Pausenzeit bisher: ${formatMinutes(stats.totalBreakMinutes)}
				</p>
				<button type="button" id="export-btn">Als Excel (.xlsx) exportieren</button>
			</div>
			<div class="card" id="worklog-report-card" ${course.hasWorklogTracking ? "" : "hidden"}>
				<h2>Worklog-Report</h2>
				<p class="muted">Die Worklog-Daten sind im Excel-Export oben (Blätter „Worklog-Übersicht", „Worklog nach Gruppe", „Worklog-Einträge") enthalten.</p>
				<div id="worklog-report-body"><p class="muted">Lädt…</p></div>
			</div>
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

		if (course.hasWorklogTracking) {
			await renderWorklogReport(container.querySelector("#worklog-report-body"), token, course, { handleAuthError });
		}
	} catch (error) {
		if (handleAuthError(error)) return;
		container.innerHTML = `<p class="error">${error.message}</p>`;
	}
}

function worklogGroupKey(groupId) {
	return groupId === null ? "none" : String(groupId);
}

async function renderWorklogReport(container, token, course, { handleAuthError }) {
	try {
		const report = await api.getWorklogReport(token, course.id);
		const { summary, groups, participants } = report;

		const participantsByGroup = new Map();
		for (const participant of participants) {
			const key = worklogGroupKey(participant.groupId);
			if (!participantsByGroup.has(key)) participantsByGroup.set(key, []);
			participantsByGroup.get(key).push(participant);
		}

		const treeRows = groups
			.map((group) => {
				const members = participantsByGroup.get(worklogGroupKey(group.groupId)) ?? [];
				const memberRows = members
					.map(
						(participant) => `
							<tr class="worklog-participant-row">
								<td class="tree-child">${participant.name}</td>
								<td>${formatDurationLabel(participant.totalMinutes)}</td>
								<td>${participant.completenessPercent ?? 0}% (${formatDurationLabel(participant.expectedMinutes)} erwartet)</td>
								<td>
									${participant.days
										.map(
											(day) =>
												`<span class="day-chip${day.isComplete ? " is-complete" : " is-incomplete"}" title="${day.date}: ${formatMinutes(day.minutes)}"></span>`,
										)
										.join("")}
								</td>
							</tr>
						`,
					)
					.join("");

				return `
					<tr class="worklog-group-row">
						<td>${group.groupName} <span class="muted">(${group.memberCount})</span></td>
						<td>${formatDurationLabel(group.totalMinutes)}</td>
						<td>${group.completenessPercent ?? 0}% (${formatDurationLabel(group.expectedMinutes)} erwartet)</td>
						<td></td>
					</tr>
					${memberRows}
				`;
			})
			.join("");

		container.innerHTML = `
			<p class="muted">
				${report.course.pastProjectDaysCount} von ${report.course.projectDaysCount} Projekttagen bereits vergangen ·
				Gesamt erfasst: ${formatDurationLabel(summary.totalLoggedMinutes)} von ${formatDurationLabel(summary.totalExpectedMinutes)} erwartet ·
				Vollständigkeit: ${summary.completenessPercent ?? 0}%
			</p>

			<table class="data-table">
				<thead>
					<tr><th>Gruppe / Teilnehmer</th><th>Summe</th><th>Vollständigkeit</th><th>Tage</th></tr>
				</thead>
				<tbody>${treeRows || '<tr><td colspan="4" class="muted">Keine Gruppen</td></tr>'}</tbody>
			</table>
		`;
	} catch (error) {
		if (handleAuthError(error)) return;
		container.innerHTML = `<p class="error">${error.message}</p>`;
	}
}

// --- "Bilder"-Seite (Bild-Repository) ------------------------------------

async function renderImagesPage(container, token, role) {
	container.innerHTML = `
		<h1>Bilder</h1>
		<div class="card">
			<p class="muted">
				Zentrale Sammlung für Header-Logos. Das als Standard markierte Bild wird automatisch als
				linkes Logo verwendet, solange ein Kurs kein eigenes festgelegt hat.
			</p>
			<label for="image-upload">Neues Bild hochladen (PNG, JPEG, WebP, GIF, SVG – max. 5 MB)</label>
			<input type="file" id="image-upload" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-write-action />
			<div id="image-upload-error"></div>
			<div id="image-grid" class="image-grid"></div>
		</div>
	`;

	const uploadError = container.querySelector("#image-upload-error");

	async function loadImages() {
		const grid = container.querySelector("#image-grid");
		grid.innerHTML = `<p class="muted">Lädt…</p>`;
		try {
			const { images, defaultHeaderLeftImageId } = await api.listImages(token);
			if (images.length === 0) {
				grid.innerHTML = '<p class="muted">Noch keine Bilder hochgeladen.</p>';
				return;
			}
			grid.innerHTML = "";
			images.forEach((image) => {
				const isDefault = image.id === defaultHeaderLeftImageId;
				const tile = document.createElement("div");
				tile.className = `image-tile${isDefault ? " is-default" : ""}`;
				tile.innerHTML = `
					<img src="${image.url}" alt="${image.filename}" />
					<div class="filename">${image.filename}${isDefault ? " ⭐ Standard" : ""}</div>
					<div class="actions">
						${isDefault ? "" : `<button type="button" class="secondary" data-set-default data-write-action>Als Standard (links)</button>`}
						<button type="button" class="secondary" data-delete data-write-action style="color: var(--color-danger); border-color: var(--color-danger);">Löschen</button>
					</div>
				`;
				tile.querySelector("[data-set-default]")?.addEventListener("click", async () => {
					await api.setDefaultHeaderLeftImage(token, image.id);
					await loadImages();
				});
				tile.querySelector("[data-delete]").addEventListener("click", async () => {
					if (!window.confirm(`Bild "${image.filename}" wirklich löschen? Kurse, die es als Logo nutzen, verlieren es.`)) return;
					await api.deleteImage(token, image.id);
					await loadImages();
				});
				grid.appendChild(tile);
			});
		} catch (error) {
			grid.innerHTML = `<p class="error">${error.message}</p>`;
		} finally {
			lockIfReadOnly(container, role);
		}
	}

	container.querySelector("#image-upload").addEventListener("change", async (event) => {
		const file = event.target.files[0];
		if (!file) return;
		uploadError.textContent = "";
		try {
			await api.uploadImage(token, file);
			event.target.value = "";
			await loadImages();
		} catch (error) {
			uploadError.textContent = error.message;
			uploadError.className = "error";
		}
	});

	await loadImages();
}

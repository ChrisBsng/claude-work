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
		renderDashboard(root, token);
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
			renderDashboard(root, token);
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
		// Zwischenablage evtl. nicht verfügbar (z. B. kein HTTPS-Kontext) – kein Fehler, den Link zeigen wir ohnehin an.
	}
}

function courseCard(course) {
	const dashboardUrl = courseUrl(`/d/${course.dashboardToken}`);
	const checkinUrl = courseUrl(`/k/${course.checkinCode}`);
	const wrapper = document.createElement("div");
	wrapper.className = "card";
	wrapper.innerHTML = `
		<h2>${course.name}</h2>
		<p class="muted">
			Start: ${course.startDate} · Laufzeit: ${course.durationDays} Tag(e) ·
			Tägl. Pausenbudget: ${course.dailyBreakBudgetMinutes} Min.
		</p>
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
	`;
	wrapper.querySelectorAll("[data-copy]").forEach((button) => {
		button.addEventListener("click", () => copyToClipboard(button.dataset.copy, button));
	});
	return wrapper;
}

async function renderDashboard(root, token) {
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
		<div id="course-list"><p class="muted">Lädt…</p></div>
	`;

	root.querySelector("#logout").addEventListener("click", () => {
		clearToken();
		renderLogin(root);
	});

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
			if (error.status === 401) {
				clearToken();
				renderLogin(root, "Sitzung abgelaufen, bitte erneut anmelden.");
				return;
			}
			errorBox.textContent = error.message;
			errorBox.className = "error";
		}
	});

	async function loadCourses() {
		const list = root.querySelector("#course-list");
		try {
			const { courses } = await api.adminListCourses(token);
			list.innerHTML = "";
			if (courses.length === 0) {
				list.innerHTML = '<p class="muted">Noch keine Kurse angelegt.</p>';
				return;
			}
			courses.forEach((course) => list.appendChild(courseCard(course)));
		} catch (error) {
			if (error.status === 401) {
				clearToken();
				renderLogin(root, "Sitzung abgelaufen, bitte erneut anmelden.");
				return;
			}
			list.innerHTML = `<p class="error">${error.message}</p>`;
		}
	}

	await loadCourses();
}

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

function imageOptionLabel(image) {
	return `${image.filename} (${new Date(image.uploadedAt).toLocaleDateString("de-DE")})`;
}

async function renderHeaderPanel(container, token, course) {
	container.innerHTML = `<p class="muted">Lädt Bild-Repository…</p>`;
	let images = [];
	try {
		({ images } = await api.listImages(token));
	} catch (error) {
		container.innerHTML = `<p class="error">${error.message}</p>`;
		return;
	}

	const leftOptions = [
		`<option value="">Standard verwenden</option>`,
		...images.map(
			(img) => `<option value="${img.id}" ${course.headerLeftImageOverrideId === img.id ? "selected" : ""}>${imageOptionLabel(img)}</option>`,
		),
	].join("");
	const rightOptions = [
		`<option value="">Kein Bild</option>`,
		...images.map(
			(img) => `<option value="${img.id}" ${course.headerRightImageId === img.id ? "selected" : ""}>${imageOptionLabel(img)}</option>`,
		),
	].join("");

	container.innerHTML = `
		<label for="header-left-select">Logo links</label>
		<select id="header-left-select">${leftOptions}</select>
		<label for="header-right-select">Logo rechts</label>
		<select id="header-right-select">${rightOptions}</select>
		<div id="header-save-error"></div>
		<button type="button" id="header-save">Speichern</button>
		<p class="muted" style="margin-top: 10px;">Neue Bilder hochladen: siehe „Bild-Repository“ oben.</p>
	`;

	container.querySelector("#header-save").addEventListener("click", async (event) => {
		const button = event.target;
		const errorBox = container.querySelector("#header-save-error");
		errorBox.textContent = "";
		button.disabled = true;
		try {
			const headerLeftImageId = container.querySelector("#header-left-select").value || null;
			const headerRightImageId = container.querySelector("#header-right-select").value || null;
			const { course: updated } = await api.updateCourseHeader(token, course.id, { headerLeftImageId, headerRightImageId });
			Object.assign(course, updated);
			button.textContent = "Gespeichert!";
			setTimeout(() => (button.textContent = "Speichern"), 1500);
		} catch (error) {
			errorBox.textContent = error.message;
			errorBox.className = "error";
		} finally {
			button.disabled = false;
		}
	});
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
			<button type="button" class="secondary" data-toggle-header>Header-Logos</button>
			<div class="card" data-report hidden style="margin-top: 10px;"></div>
			<div class="card" data-header hidden style="margin-top: 10px;"></div>
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

	const headerPanel = tr.querySelector("[data-header]");
	tr.querySelector("[data-toggle-header]").addEventListener("click", async () => {
		const isHidden = headerPanel.hasAttribute("hidden");
		if (isHidden) {
			headerPanel.removeAttribute("hidden");
			await renderHeaderPanel(headerPanel, token, course);
		} else {
			headerPanel.setAttribute("hidden", "");
		}
	});

	return tr;
}

async function renderImageRepository(container, token) {
	container.innerHTML = `
		<h2>Bild-Repository</h2>
		<div class="card">
			<p class="muted">
				Zentrale Sammlung für Header-Logos. Das als Standard markierte Bild wird automatisch als
				linkes Logo verwendet, solange ein Kurs kein eigenes festgelegt hat.
			</p>
			<label for="image-upload">Neues Bild hochladen (PNG, JPEG, WebP, GIF, SVG – max. 5 MB)</label>
			<input type="file" id="image-upload" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" />
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
						${isDefault ? "" : `<button type="button" class="secondary" data-set-default>Als Standard (links)</button>`}
						<button type="button" class="secondary" data-delete style="color: var(--color-danger); border-color: var(--color-danger);">Löschen</button>
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

async function renderCourses(root, token) {
	root.innerHTML = `
		<nav class="top">
			<h1>Admin-Bereich</h1>
			<button type="button" id="logout" class="secondary">Abmelden</button>
		</nav>

		<div id="image-repository"></div>

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

	await renderImageRepository(root.querySelector("#image-repository"), token);
	await loadCourses();
}

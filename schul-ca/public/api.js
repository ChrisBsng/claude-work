export async function call(path, { method = "GET", body, token } = {}) {
	const headers = {};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
	let data = null;
	try {
		data = await response.json();
	} catch {
		// keine JSON-Antwort
	}
	if (!response.ok) {
		const error = new Error(data?.error ?? `Fehler ${response.status}`);
		error.status = response.status;
		throw error;
	}
	return data;
}

// Lädt eine Datei (mit Auth-Header) und startet den Browser-Download.
export async function download(path, { method = "GET", body, token } = {}) {
	const headers = {};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
	if (!response.ok) {
		let message = `Fehler ${response.status}`;
		try {
			message = (await response.json())?.error ?? message;
		} catch {
			// keine JSON-Fehlerantwort
		}
		const error = new Error(message);
		error.status = response.status;
		throw error;
	}
	const disposition = response.headers.get("Content-Disposition") ?? "";
	const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "download";
	const url = URL.createObjectURL(await response.blob());
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function esc(value) {
	return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function formatDate(iso) {
	if (!iso) return "–";
	return new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}

export function formatDay(iso) {
	if (!iso) return "–";
	return new Date(iso).toLocaleDateString("de-DE", { dateStyle: "medium" });
}

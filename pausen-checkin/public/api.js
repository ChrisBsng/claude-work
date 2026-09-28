async function request(path, { method = "GET", body, headers = {} } = {}) {
	const response = await fetch(path, {
		method,
		headers: body ? { "Content-Type": "application/json", ...headers } : headers,
		body: body ? JSON.stringify(body) : undefined,
	});

	let data = null;
	try {
		data = await response.json();
	} catch {
		// keine JSON-Antwort (z. B. leerer Body) – bleibt null
	}

	if (!response.ok) {
		const error = new Error(data?.error ?? `Fehler ${response.status}`);
		error.status = response.status;
		throw error;
	}

	return data;
}

async function requestBlob(path, { headers = {} } = {}) {
	const response = await fetch(path, { headers });
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
	return response.blob();
}

export const api = {
	adminLogin: (password) => request("/api/admin/login", { method: "POST", body: { password } }),
	adminListCourses: (token) => request("/api/admin/courses", { headers: { Authorization: `Bearer ${token}` } }),
	adminCreateCourse: (token, course) =>
		request("/api/admin/courses", {
			method: "POST",
			body: course,
			headers: { Authorization: `Bearer ${token}` },
		}),
	bulkDeleteCourses: (token, ids) =>
		request("/api/admin/courses/bulk-delete", {
			method: "POST",
			body: { ids },
			headers: { Authorization: `Bearer ${token}` },
		}),
	getCourseStats: (token, courseId) =>
		request(`/api/admin/courses/${courseId}/stats`, { headers: { Authorization: `Bearer ${token}` } }),
	exportCourseXlsxBlob: (token, courseId) =>
		requestBlob(`/api/admin/courses/${courseId}/export.xlsx`, { headers: { Authorization: `Bearer ${token}` } }),

	getCourseByCheckinCode: (checkinCode) => request(`/api/checkin/${checkinCode}`),
	registerParticipant: (checkinCode, name) =>
		request(`/api/checkin/${checkinCode}/register`, { method: "POST", body: { name } }),
	getMe: (checkinCode, accessToken) =>
		request(`/api/checkin/${checkinCode}/me`, { headers: { "X-Access-Token": accessToken } }),
	toggleCheckin: (checkinCode, accessToken) =>
		request(`/api/checkin/${checkinCode}/toggle`, { method: "POST", headers: { "X-Access-Token": accessToken } }),

	getDashboard: (dashboardToken) => request(`/api/dashboard/${dashboardToken}`),
	getDashboardDays: (dashboardToken) => request(`/api/dashboard/${dashboardToken}/days`),
	getDashboardDayDetail: (dashboardToken, date) => request(`/api/dashboard/${dashboardToken}/days/${date}`),
};

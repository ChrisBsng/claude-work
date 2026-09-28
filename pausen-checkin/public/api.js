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

export const api = {
	adminLogin: (password) => request("/api/admin/login", { method: "POST", body: { password } }),
	adminListCourses: (token) => request("/api/admin/courses", { headers: { Authorization: `Bearer ${token}` } }),
	adminCreateCourse: (token, course) =>
		request("/api/admin/courses", {
			method: "POST",
			body: course,
			headers: { Authorization: `Bearer ${token}` },
		}),

	getCourseByCheckinCode: (checkinCode) => request(`/api/checkin/${checkinCode}`),
	registerParticipant: (checkinCode, name) =>
		request(`/api/checkin/${checkinCode}/register`, { method: "POST", body: { name } }),
	getMe: (checkinCode, accessToken) =>
		request(`/api/checkin/${checkinCode}/me`, { headers: { "X-Access-Token": accessToken } }),
	toggleCheckin: (checkinCode, accessToken) =>
		request(`/api/checkin/${checkinCode}/toggle`, { method: "POST", headers: { "X-Access-Token": accessToken } }),

	getDashboard: (dashboardToken) => request(`/api/dashboard/${dashboardToken}`),
};

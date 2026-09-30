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
	adminLogin: (password, role) => request("/api/admin/login", { method: "POST", body: { password, role } }),
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
	updateCourse: (token, courseId, patch) =>
		request(`/api/admin/courses/${courseId}`, {
			method: "PATCH",
			body: patch,
			headers: { Authorization: `Bearer ${token}` },
		}),
	updateCourseHeader: (token, courseId, header) =>
		request(`/api/admin/courses/${courseId}/header`, {
			method: "PATCH",
			body: header,
			headers: { Authorization: `Bearer ${token}` },
		}),
	getCourseStats: (token, courseId) =>
		request(`/api/admin/courses/${courseId}/stats`, { headers: { Authorization: `Bearer ${token}` } }),
	exportCourseXlsxBlob: (token, courseId) =>
		requestBlob(`/api/admin/courses/${courseId}/export.xlsx`, { headers: { Authorization: `Bearer ${token}` } }),

	listProjectDays: (token, courseId) =>
		request(`/api/admin/courses/${courseId}/project-days`, { headers: { Authorization: `Bearer ${token}` } }),
	setProjectDays: (token, courseId, dates) =>
		request(`/api/admin/courses/${courseId}/project-days`, {
			method: "PUT",
			body: { dates },
			headers: { Authorization: `Bearer ${token}` },
		}),
	getWorklogReport: (token, courseId) =>
		request(`/api/admin/courses/${courseId}/worklog-report`, { headers: { Authorization: `Bearer ${token}` } }),

	listCourseGroups: (token, courseId) =>
		request(`/api/admin/courses/${courseId}/groups`, { headers: { Authorization: `Bearer ${token}` } }),
	createCourseGroup: (token, courseId, name) =>
		request(`/api/admin/courses/${courseId}/groups`, {
			method: "POST",
			body: { name },
			headers: { Authorization: `Bearer ${token}` },
		}),
	renameGroup: (token, groupId, name) =>
		request(`/api/admin/groups/${groupId}`, { method: "PATCH", body: { name }, headers: { Authorization: `Bearer ${token}` } }),
	deleteGroup: (token, groupId) =>
		request(`/api/admin/groups/${groupId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }),

	listCourseParticipants: (token, courseId) =>
		request(`/api/admin/courses/${courseId}/participants`, { headers: { Authorization: `Bearer ${token}` } }),
	updateParticipant: (token, participantId, patch) =>
		request(`/api/admin/participants/${participantId}`, {
			method: "PATCH",
			body: patch,
			headers: { Authorization: `Bearer ${token}` },
		}),
	resetParticipantPassword: (token, participantId) =>
		request(`/api/admin/participants/${participantId}/reset-password`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		}),
	deleteParticipant: (token, participantId) =>
		request(`/api/admin/participants/${participantId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }),

	listImages: (token) => request("/api/admin/images", { headers: { Authorization: `Bearer ${token}` } }),
	uploadImage: async (token, file) => {
		const response = await fetch("/api/admin/images", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": file.type,
				"X-Filename": encodeURIComponent(file.name),
			},
			body: file,
		});
		const data = await response.json().catch(() => null);
		if (!response.ok) {
			const error = new Error(data?.error ?? `Fehler ${response.status}`);
			error.status = response.status;
			throw error;
		}
		return data;
	},
	deleteImage: (token, imageId) =>
		request(`/api/admin/images/${imageId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }),
	setDefaultHeaderLeftImage: (token, imageId) =>
		request("/api/admin/settings/default-header-left", {
			method: "PUT",
			body: { imageId },
			headers: { Authorization: `Bearer ${token}` },
		}),

	getCourseByCheckinCode: (checkinCode) => request(`/api/checkin/${checkinCode}`),
	getCheckinParticipantNames: (checkinCode) => request(`/api/checkin/${checkinCode}/participants`),
	getCheckinGroups: (checkinCode) => request(`/api/checkin/${checkinCode}/groups`),
	loginParticipant: (checkinCode, name, password, group) =>
		request(`/api/checkin/${checkinCode}/login`, { method: "POST", body: { name, password, group } }),
	getMe: (checkinCode, accessToken) =>
		request(`/api/checkin/${checkinCode}/me`, { headers: { "X-Access-Token": accessToken } }),
	toggleCheckin: (checkinCode, accessToken, status) =>
		request(`/api/checkin/${checkinCode}/toggle`, {
			method: "POST",
			body: status ? { status } : {},
			headers: { "X-Access-Token": accessToken },
		}),

	getDashboard: (dashboardToken) => request(`/api/dashboard/${dashboardToken}`),
	getDashboardDays: (dashboardToken) => request(`/api/dashboard/${dashboardToken}/days`),
	getDashboardDayDetail: (dashboardToken, date) => request(`/api/dashboard/${dashboardToken}/days/${date}`),

	getWorklogDays: (checkinCode, accessToken) =>
		request(`/api/checkin/${checkinCode}/worklog/days`, { headers: { "X-Access-Token": accessToken } }),
	getWorklogTasks: (checkinCode, accessToken) =>
		request(`/api/checkin/${checkinCode}/worklog/tasks`, { headers: { "X-Access-Token": accessToken } }),
	getWorklogDay: (checkinCode, accessToken, date) =>
		request(`/api/checkin/${checkinCode}/worklog/${date}`, { headers: { "X-Access-Token": accessToken } }),
	addWorklogEntry: (checkinCode, accessToken, date, task, minutes) =>
		request(`/api/checkin/${checkinCode}/worklog/${date}`, {
			method: "POST",
			body: { task, minutes },
			headers: { "X-Access-Token": accessToken },
		}),
	deleteWorklogEntry: (checkinCode, accessToken, date, entryId) =>
		request(`/api/checkin/${checkinCode}/worklog/${date}/${entryId}`, {
			method: "DELETE",
			headers: { "X-Access-Token": accessToken },
		}),
};

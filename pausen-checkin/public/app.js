import { renderLanding } from "/views/landing.js";
import { renderAdmin } from "/views/admin.js";
import { renderCheckin } from "/views/checkin.js";
import { renderDashboard } from "/views/dashboard.js";

const root = document.getElementById("app");
const path = window.location.pathname;

const checkinMatch = path.match(/^\/k\/([^/]+)\/?$/);
const dashboardMatch = path.match(/^\/d\/([^/]+)\/?$/);

if (path === "/admin" || path === "/admin/") {
	renderAdmin(root);
} else if (checkinMatch) {
	document.body.classList.add("force-light-theme");
	renderCheckin(root, checkinMatch[1]);
} else if (dashboardMatch) {
	root.classList.add("dashboard-app");
	renderDashboard(root, dashboardMatch[1]);
} else {
	renderLanding(root);
}

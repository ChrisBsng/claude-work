import { renderStudent } from "/views/student.js";
import { renderAdmin } from "/views/admin.js";
import { renderCa } from "/views/ca.js";

const root = document.getElementById("app");
const caMatch = window.location.pathname.match(/^\/ca\/([A-Za-z0-9_-]+)\/?$/);
if (caMatch) {
	root.classList.add("wide");
	renderCa(root, caMatch[1]);
} else if (/^\/admin\/?$/.test(window.location.pathname)) {
	root.classList.add("wide");
	renderAdmin(root);
} else {
	renderStudent(root);
}

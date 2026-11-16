import { renderStudent } from "/views/student.js";
import { renderAdmin } from "/views/admin.js";

const root = document.getElementById("app");
if (/^\/admin\/?$/.test(window.location.pathname)) {
	root.classList.add("wide");
	renderAdmin(root);
} else {
	renderStudent(root);
}

import { renderHome } from "/views/home.js";
import { renderApplyPage } from "/views/apply.js";
import { renderPickupPage } from "/views/pickup.js";
import { renderAdmin } from "/views/admin.js";
import { renderCa } from "/views/ca.js";
import { renderOwner } from "/views/owner.js";

// Jede Funktion hat ihre eigene Seite (und, wo nötig, ihre eigene Anmeldung):
//   /                       Startseite (Anforderungen, Root-Download, Einstiege)
//   /beantragen             Zwischenzertifikat beantragen   (Schulpasswort + Captcha)
//   /abruf                  Status, Abruf, Verwalten starten (Abruf-Code + Captcha)
//   /ca/<Token>             Klassen-Seite (öffentlich)
//   /ca/<Token>/verwalten   Inhaber-Seite (Abruf-Code + Captcha bzw. Abruf-Sitzung)
//   /admin                  Administration
const root = document.getElementById("app");
const path = window.location.pathname.replace(/\/+$/, "") || "/";

const owner = path.match(/^\/ca\/([A-Za-z0-9_-]+)\/verwalten$/);
const ca = path.match(/^\/ca\/([A-Za-z0-9_-]+)$/);

if (owner) {
	root.classList.add("wide");
	renderOwner(root, owner[1]);
} else if (ca) {
	root.classList.add("wide");
	renderCa(root, ca[1]);
} else if (path === "/admin") {
	root.classList.add("wide");
	renderAdmin(root);
} else if (path === "/beantragen") {
	renderApplyPage(root);
} else if (path === "/abruf") {
	renderPickupPage(root);
} else {
	renderHome(root);
}

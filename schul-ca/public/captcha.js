import { call } from "/api.js";

// Bindet ein Captcha (Bild + Eingabefeld + Reload) in ein Container-Element ein.
export function mountCaptcha(container) {
	container.innerHTML = `
		<div class="captcha-row"><div class="captcha" data-captcha-img aria-live="polite">…</div><button type="button" class="secondary" data-captcha-reload title="Neues Captcha">↻</button></div>
		<label>Zeichen aus dem Bild <input type="text" data-captcha-answer required autocomplete="off" autocapitalize="characters" maxlength="8" /></label>`;
	let token = "";
	const img = container.querySelector("[data-captcha-img]");
	const input = container.querySelector("[data-captcha-answer]");
	const reload = async () => {
		try {
			const c = await call("/api/student/captcha");
			token = c.token;
			img.innerHTML = c.svg;
		} catch (e) {
			img.textContent = e.message;
		}
		input.value = "";
	};
	container.querySelector("[data-captcha-reload]").addEventListener("click", reload);
	reload();
	return { reload, values: () => ({ captchaToken: token, captchaAnswer: input.value }) };
}

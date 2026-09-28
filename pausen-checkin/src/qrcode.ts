import qrcode from "qrcode-generator";

// Serverseitig gerenderte SVG statt einer clientseitigen Bibliothek von
// einem externen CDN – keine externe Laufzeit-Abhängigkeit nötig.
export function renderQrCodeSvg(text: string, size = 320): string {
	const qr = qrcode(0, "M");
	qr.addData(text);
	qr.make();

	const moduleCount = qr.getModuleCount();
	const cell = size / moduleCount;
	let modules = "";
	for (let row = 0; row < moduleCount; row++) {
		for (let col = 0; col < moduleCount; col++) {
			if (qr.isDark(row, col)) {
				modules += `<rect x="${(col * cell).toFixed(2)}" y="${(row * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`;
			}
		}
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"><rect width="${size}" height="${size}" fill="#ffffff"/><g fill="#000000">${modules}</g></svg>`;
}

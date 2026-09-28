// Rendert die optionale Logo-Leiste (links/rechts) oberhalb einer Seite.
// Gibt "" zurück, wenn keines der beiden Bilder gesetzt ist, damit kein
// leerer Rahmen angezeigt wird. Ein defektes Bild (z. B. gelöscht) blendet
// sich über onerror selbst aus, statt ein kaputtes Icon zu zeigen.
export function renderBrandHeader(course) {
	if (!course.headerLeftImageId && !course.headerRightImageId) return "";

	const left = course.headerLeftImageId
		? `<img src="/api/images/${course.headerLeftImageId}" alt="" class="brand-logo" onerror="this.style.display='none'" />`
		: "<span></span>";
	const right = course.headerRightImageId
		? `<img src="/api/images/${course.headerRightImageId}" alt="" class="brand-logo" onerror="this.style.display='none'" />`
		: "<span></span>";

	return `<div class="brand-header">${left}${right}</div>`;
}

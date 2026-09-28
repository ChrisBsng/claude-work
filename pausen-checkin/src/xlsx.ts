import { strToU8, zipSync } from "fflate";

export type XlsxCell = string | number;

export interface XlsxSheet {
	name: string;
	rows: XlsxCell[][];
}

// Minimaler, abhängigkeitsarmer XLSX-Writer: erzeugt die nötigsten OOXML-
// Teile von Hand (inline strings statt sharedStrings-Tabelle, keine
// Formatierung) und packt sie mit fflate (reines JS, Workers-tauglich)
// zu einer gültigen .xlsx-Datei. Für den Umfang unserer Reports reicht
// das – eine volle Bibliothek wie SheetJS bringt Node-Abhängigkeiten mit,
// die im Workers-Runtime nicht garantiert funktionieren.
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
	const files: Record<string, Uint8Array> = {
		"[Content_Types].xml": strToU8(buildContentTypesXml(sheets.length)),
		"_rels/.rels": strToU8(RELS_XML),
		"xl/workbook.xml": strToU8(buildWorkbookXml(sheets)),
		"xl/_rels/workbook.xml.rels": strToU8(buildWorkbookRelsXml(sheets.length)),
	};

	sheets.forEach((sheet, index) => {
		files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(buildSheetXml(sheet));
	});

	return zipSync(files, { level: 6 });
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function columnLetter(index: number): string {
	let n = index + 1;
	let letters = "";
	while (n > 0) {
		const remainder = (n - 1) % 26;
		letters = String.fromCharCode(65 + remainder) + letters;
		n = Math.floor((n - 1) / 26);
	}
	return letters;
}

function buildContentTypesXml(sheetCount: number): string {
	const overrides = Array.from(
		{ length: sheetCount },
		(_, i) =>
			`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
	).join("");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${overrides}
</Types>`;
}

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

function buildWorkbookXml(sheets: XlsxSheet[]): string {
	const sheetEntries = sheets
		.map((sheet, index) => `<sheet name="${escapeXml(sheet.name.slice(0, 31))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetEntries}</sheets>
</workbook>`;
}

function buildWorkbookRelsXml(sheetCount: number): string {
	const relationships = Array.from(
		{ length: sheetCount },
		(_, i) =>
			`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
	).join("");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

function buildSheetXml(sheet: XlsxSheet): string {
	const rowsXml = sheet.rows
		.map((row, rowIndex) => {
			const cellsXml = row
				.map((value, colIndex) => {
					const ref = `${columnLetter(colIndex)}${rowIndex + 1}`;
					if (typeof value === "number" && Number.isFinite(value)) {
						return `<c r="${ref}"><v>${value}</v></c>`;
					}
					return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
				})
				.join("");
			return `<row r="${rowIndex + 1}">${cellsXml}</row>`;
		})
		.join("");

	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rowsXml}</sheetData>
</worksheet>`;
}

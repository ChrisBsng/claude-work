export function badRequest(message: string, status = 400): Response {
	return Response.json({ error: message }, { status });
}

export async function readJson<T>(request: Request): Promise<T | null> {
	return (await request.json().catch(() => null)) as T | null;
}

export function fileResponse(body: BodyInit, filename: string, contentType: string): Response {
	return new Response(body, {
		headers: {
			"Content-Type": contentType,
			"Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
			"Cache-Control": "no-store",
		},
	});
}

export const MIME = {
	pem: "application/x-pem-file",
	crt: "application/x-x509-ca-cert",
};

export function safeName(name: string): string {
	return name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "zertifikat";
}

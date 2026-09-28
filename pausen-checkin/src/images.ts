const ALLOWED_IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);

export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;

export function isAllowedImageType(contentType: string): boolean {
	return ALLOWED_IMAGE_CONTENT_TYPES.has(contentType);
}

export interface CourseHeaderRow {
	header_left_image_id: string | null;
	header_right_image_id: string | null;
}

// header_left_image_id = null -> globalen Standard verwenden (app_settings);
// header_right_image_id = null -> kein Bild, es gibt keinen Standard rechts.
export async function resolveHeaderImageIds(
	db: D1Database,
	course: CourseHeaderRow,
): Promise<{ leftImageId: string | null; rightImageId: string | null }> {
	let leftImageId = course.header_left_image_id;
	if (!leftImageId) {
		const setting = await db
			.prepare("SELECT value FROM app_settings WHERE key = 'default_header_left_image_id'")
			.first<{ value: string }>();
		leftImageId = setting?.value ?? null;
	}
	return { leftImageId, rightImageId: course.header_right_image_id ?? null };
}

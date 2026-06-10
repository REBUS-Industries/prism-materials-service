/**
 * PBR slot vocabulary + Megascans-style filename detection.
 *
 * Pure, dependency-free helpers shared by the `/api/materials` REST surface
 * (slot validation + ZIP import) and the unit tests. Kept out of the route
 * module so the detection logic is testable without spinning up Fastify or
 * mocking the DB.
 */

/** The eight PBR slots a material can carry. Order is significant: it is the
 * priority used when a single filename matches more than one slot's tokens. */
export const ALLOWED_SLOTS = [
  'albedo', 'normal', 'roughness', 'metallic', 'ao', 'emissive', 'opacity', 'displacement',
] as const;

export type MaterialSlot = typeof ALLOWED_SLOTS[number];

export function isMaterialSlot(value: string): value is MaterialSlot {
  return (ALLOWED_SLOTS as readonly string[]).includes(value);
}

/**
 * Substring tokens (case-insensitive) that map a texture filename to a slot.
 * Megascans and most DCC exporters suffix the channel onto the filename
 * (e.g. `rockface_2k_Albedo.jpg`, `T_Brick_Nrm.png`). Tokens are matched as
 * substrings, in slot order, so the first slot with any matching token wins.
 */
const SLOT_TOKENS: Record<MaterialSlot, readonly string[]> = {
  albedo:       ['_albedo', '_color', '_basecolor', '_diffuse', '_diff', '_col'],
  normal:       ['_normal', '_nrm', '_nor'],
  roughness:    ['_roughness', '_rough', '_rgh'],
  metallic:     ['_metallic', '_metalness', '_metal'],
  ao:           ['_ao', '_ambientocclusion', '_occlusion'],
  emissive:     ['_emissive', '_emission', '_emi'],
  opacity:      ['_opacity', '_alpha', '_mask'],
  displacement: ['_displacement', '_height', '_disp'],
};

/** Detect the PBR slot for a texture filename, or null if none matches. */
export function detectSlot(filename: string): MaterialSlot | null {
  const lower = filename.toLowerCase();
  for (const slot of ALLOWED_SLOTS) {
    for (const token of SLOT_TOKENS[slot]) {
      if (lower.includes(token)) return slot;
    }
  }
  return null;
}

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tga':  'image/x-tga',
  '.tif':  'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp':  'image/bmp',
  '.exr':  'image/x-exr',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.hdr':  'image/vnd.radiance',
};

/** Map a filename to an image content-type, or null when it isn't a
 * recognised image (used to skip manifests/readmes during ZIP import). */
export function imageContentType(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return null;
  return IMAGE_CONTENT_TYPES[filename.slice(dot).toLowerCase()] ?? null;
}

export function isImageFilename(filename: string): boolean {
  return imageContentType(filename) !== null;
}

/**
 * Per-material PBR parameters — scalar/colour values that exist independently
 * of whether a texture is assigned to a slot. They map onto a three.js
 * `MeshStandardMaterial` (the visualiser/SPA applies them live) and are
 * persisted per material as a partial JSON object in `materials.parameters`.
 *
 * Only the keys the user has changed are stored; `mergeParameters` fills the
 * rest from `DEFAULT_MATERIAL_PARAMETERS` at read time so the API always
 * serves a complete object. Kept dependency-light (Zod only) and free of any
 * DB/Fastify imports so the contract + validation are unit-testable in
 * isolation, mirroring `slots.ts`.
 */
import { z } from 'zod';

/** Complete, fully-populated PBR parameter set for one material. */
export interface MaterialParameters {
  baseColor: string;
  roughness: number;
  metallic: number;
  emissiveColor: string;
  emissiveIntensity: number;
  opacity: number;
  normalScale: number;
  aoIntensity: number;
  displacementScale: number;
  displacementBias: number;
  tilingX: number;
  tilingY: number;
  offsetX: number;
  offsetY: number;
  doubleSided: boolean;
  flipNormalY: boolean;
}

/** Canonical defaults — applied at read time over the stored partial. Each
 * entry notes the `MeshStandardMaterial` property it drives. */
export const DEFAULT_MATERIAL_PARAMETERS: MaterialParameters = {
  baseColor: '#ffffff',        // material.color (also tints the albedo map)
  roughness: 1.0,              // material.roughness (multiplies roughnessMap)
  metallic: 0.0,               // material.metalness (multiplies metalnessMap)
  emissiveColor: '#000000',    // material.emissive
  emissiveIntensity: 1.0,      // material.emissiveIntensity
  opacity: 1.0,                // material.opacity (+ transparent)
  normalScale: 1.0,            // material.normalScale (x = y)
  aoIntensity: 1.0,            // material.aoMapIntensity
  displacementScale: 0.05,     // material.displacementScale
  displacementBias: 0.0,       // material.displacementBias
  tilingX: 1.0,                // every map's repeat.x
  tilingY: 1.0,                // every map's repeat.y
  offsetX: 0.0,                // every map's offset.x
  offsetY: 0.0,                // every map's offset.y
  doubleSided: false,          // material.side (FrontSide vs DoubleSide)
  flipNormalY: false,          // negate normalScale.y
};

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb hex colour');

/**
 * Validates a PARTIAL parameters payload — every key optional, each bounded to
 * the range the UI control honours. Unknown keys are stripped (Zod default) so
 * only recognised parameters are ever merged into the stored jsonb.
 */
export const materialParametersSchema = z
  .object({
    baseColor: hexColor,
    roughness: z.number().min(0).max(1),
    metallic: z.number().min(0).max(1),
    emissiveColor: hexColor,
    emissiveIntensity: z.number().min(0),
    opacity: z.number().min(0).max(1),
    normalScale: z.number().min(0).max(2),
    aoIntensity: z.number().min(0).max(1),
    displacementScale: z.number(),
    displacementBias: z.number(),
    tilingX: z.number().gt(0),
    tilingY: z.number().gt(0),
    offsetX: z.number(),
    offsetY: z.number(),
    doubleSided: z.boolean(),
    flipNormalY: z.boolean(),
  })
  .partial();

export type MaterialParametersPatch = z.infer<typeof materialParametersSchema>;

function assignParameter<K extends keyof MaterialParameters>(
  target: MaterialParameters,
  key: K,
  value: unknown,
): void {
  if (value !== undefined && value !== null) target[key] = value as MaterialParameters[K];
}

/**
 * Merge a stored partial (whatever sits in `materials.parameters`) onto the
 * defaults, returning a complete parameter set. Only recognised keys are
 * copied through, so junk in the column can never leak into a response.
 */
export function mergeParameters(stored: unknown): MaterialParameters {
  const merged: MaterialParameters = { ...DEFAULT_MATERIAL_PARAMETERS };
  if (stored && typeof stored === 'object') {
    const source = stored as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_MATERIAL_PARAMETERS) as Array<keyof MaterialParameters>) {
      assignParameter(merged, key, source[key]);
    }
  }
  return merged;
}

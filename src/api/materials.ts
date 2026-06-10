/**
 * /api/materials — PBR materials store.
 *
 * A material is a named bundle of PBR slot assignments (albedo / normal /
 * roughness / metallic / ao / emissive / opacity / displacement). Slots
 * reference rows in the shared texture library (see api/textures.ts) through
 * the `material_textures` join table, so the same texture can back many
 * materials. Materials can be created blank and filled slot-by-slot, exported
 * as a ZIP (texture bodies + a manifest), or created in bulk by importing a
 * Megascans-style ZIP whose entries are matched to slots by filename.
 *
 * Each material also carries editable PBR `parameters` (base colour,
 * roughness/metallic/opacity, emissive, UV tiling/offset, etc. — see
 * materials/parameters.ts) stored as a partial jsonb and served complete via
 * read-time defaulting. They map onto a three.js MeshStandardMaterial.
 *
 * Surface:
 *
 *   GET    /api/materials                     list (q / tags / cursor / limit)
 *   POST   /api/materials                     create blank material      (write)
 *   GET    /api/materials/:id                 full detail (slots + textures + parameters)
 *   PUT    /api/materials/:id                 rename / retag / set params (write)
 *   PUT    /api/materials/:id/parameters      merge PBR parameters       (write)
 *   DELETE /api/materials/:id                 soft-delete                (delete)
 *   PUT    /api/materials/:id/slots/:slot     assign a texture to a slot (write)
 *   DELETE /api/materials/:id/slots/:slot     clear a slot               (write)
 *   GET    /api/materials/:id/download        stream a ZIP of the material
 *   POST   /api/materials/import              Megascans ZIP -> material  (write)
 *
 * Reads require `materials:read`; admin sessions and ORBIT bearers bypass
 * scope checks as usual (see auth/middleware.ts requireScope).
 */
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { ZipArchive } from 'archiver';
import AdmZip from 'adm-zip';
import { db, materials, materialTextures, textures, requireAuth, requireScope } from '@rebus-industries/prism-shared';
import type { Principal } from '@rebus-industries/prism-shared';
import { ALLOWED_SLOTS, detectSlot, imageContentType, isImageFilename, isMaterialSlot } from '../materials/slots.js';
import {
  type MaterialParameters,
  type MaterialParametersPatch,
  materialParametersSchema,
  mergeParameters,
} from '../materials/parameters.js';

const DATA_DIR = process.env.PRISM_DATA_DIR ?? process.env.DATA_DIR ?? '/data/prism';
const TEXTURES_ROOT = resolve(DATA_DIR, 'textures');

const SLOTS_TOTAL = ALLOWED_SLOTS.length;

// Megascans 8K sets routinely run into the hundreds of MB once every channel
// is bundled; cap the import body generously below the 1 GB multipart ceiling.
const MAX_ZIP_BYTES = 500 * 1024 * 1024;

const idParam = z.object({ id: z.string().uuid() });
const tagsSchema = z.array(z.string().min(1).max(64)).max(64);

const createBody = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(8192).optional(),
  tags: tagsSchema.optional(),
});

const updateBody = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(8192).nullable().optional(),
  tags: tagsSchema.optional(),
  parameters: materialParametersSchema.optional(),
});

const assignBody = z.object({ textureId: z.string().uuid() });

/** A read-modify-write-free shallow jsonb merge of a validated parameters
 * partial onto whatever is already stored — mirrors the `jobs.outputs`
 * merge in api/internal.ts. The column is NOT NULL, but COALESCE keeps the
 * expression safe against any legacy NULL. */
function parametersMergeSql(patch: MaterialParametersPatch) {
  return sql`COALESCE(${materials.parameters}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

/** Sanitise a filename for use on disk / inside the export ZIP. */
function sanitiseFilename(input: string): string {
  const base = input.replace(/[\\/]+/g, '_');
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'texture';
}

/** Last path segment of a (possibly nested) ZIP entry name. */
function baseName(entryName: string): string {
  const norm = entryName.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  return slash === -1 ? norm : norm.slice(slash + 1);
}

/** Pull a string value out of @fastify/multipart's `fields` bag. */
function fieldValue(fields: unknown, name: string): string | undefined {
  const bag = fields as Record<string, unknown> | undefined;
  const raw = bag?.[name];
  const one = Array.isArray(raw) ? raw[0] : raw;
  const node = one as { type?: string; value?: unknown } | undefined;
  if (node && node.type === 'field' && node.value != null) return String(node.value);
  return undefined;
}

function provenance(principal: Principal | undefined) {
  return {
    adminId: principal?.kind === 'adminSession' ? principal.adminUserId : null,
    apiKeyId: principal?.kind === 'apiKey' ? principal.apiKeyId : null,
  };
}

interface SlotAssignment {
  slot: string;
  textureId: string;
  assignedAt: string;
  texture: {
    id: string;
    displayName: string;
    originalFilename: string;
    contentType: string;
    sizeBytes: number;
  };
}

interface MaterialDetail {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  thumbnailTextureId: string | null;
  createdByAdminId: string | null;
  createdByApiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
  parameters: MaterialParameters;
  slotsTotal: number;
  slotsFilled: number;
  slots: SlotAssignment[];
}

/** Load a material plus its slot assignments (with joined texture metadata).
 * Returns null if the material is missing or soft-deleted. */
async function loadDetail(id: string): Promise<MaterialDetail | null> {
  const m = await db.query.materials.findFirst({
    where: and(eq(materials.id, id), isNull(materials.deletedAt)),
  });
  if (!m) return null;

  const slotRows = await db
    .select({
      slot: materialTextures.slot,
      textureId: materialTextures.textureId,
      assignedAt: materialTextures.assignedAt,
      texId: textures.id,
      texDisplayName: textures.displayName,
      texOriginalFilename: textures.originalFilename,
      texContentType: textures.contentType,
      texSizeBytes: textures.sizeBytes,
    })
    .from(materialTextures)
    .innerJoin(textures, eq(textures.id, materialTextures.textureId))
    .where(eq(materialTextures.materialId, id));

  const slots: SlotAssignment[] = slotRows
    .map((r) => ({
      slot: r.slot,
      textureId: r.textureId,
      assignedAt: r.assignedAt.toISOString(),
      texture: {
        id: r.texId,
        displayName: r.texDisplayName ?? r.texOriginalFilename,
        originalFilename: r.texOriginalFilename,
        contentType: r.texContentType,
        sizeBytes: r.texSizeBytes,
      },
    }))
    .sort((a, b) => ALLOWED_SLOTS.indexOf(a.slot as never) - ALLOWED_SLOTS.indexOf(b.slot as never));

  return {
    id: m.id,
    name: m.name,
    description: m.description,
    tags: Array.isArray(m.tags) ? m.tags : [],
    thumbnailTextureId: m.thumbnailTextureId,
    createdByAdminId: m.createdByAdminId,
    createdByApiKeyId: m.createdByApiKeyId,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    parameters: mergeParameters(m.parameters),
    slotsTotal: SLOTS_TOTAL,
    slotsFilled: slots.length,
    slots,
  };
}

const slotsFilledSql = sql<number>`(
  select count(*)::int from ${materialTextures} mt where mt.material_id = ${materials.id}
)`;

const plugin: FastifyPluginAsync = async (app) => {
  await mkdir(TEXTURES_ROOT, { recursive: true }).catch(() => { /* race-tolerant */ });

  /* ---------- GET /api/materials ---------- */
  app.get<{ Querystring: { q?: string; tags?: string; cursor?: string; limit?: string } }>('/', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
    const offset = Math.max(Number(req.query.cursor ?? 0), 0);
    const q = (req.query.q ?? '').trim();
    const tags = (req.query.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);

    const conditions = [isNull(materials.deletedAt)];
    if (q) {
      conditions.push(or(ilike(materials.name, `%${q}%`), ilike(materials.description, `%${q}%`))!);
    }
    if (tags.length) {
      conditions.push(sql`${materials.tags} && ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[]`);
    }

    const rows = await db
      .select({
        id: materials.id,
        name: materials.name,
        description: materials.description,
        tags: materials.tags,
        thumbnailTextureId: materials.thumbnailTextureId,
        createdAt: materials.createdAt,
        updatedAt: materials.updatedAt,
        slotsFilled: slotsFilledSql,
      })
      .from(materials)
      .where(and(...conditions))
      .orderBy(desc(materials.createdAt))
      .limit(limit)
      .offset(offset);

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      tags: Array.isArray(r.tags) ? r.tags : [],
      thumbnailTextureId: r.thumbnailTextureId,
      slotsFilled: Number(r.slotsFilled ?? 0),
      slotsTotal: SLOTS_TOTAL,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    const nextCursor = rows.length === limit ? String(offset + rows.length) : null;
    return { materials: items, limit, cursor: String(offset), nextCursor };
  });

  /* ---------- POST /api/materials ---------- */
  app.post<{ Body: unknown }>('/', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const { adminId, apiKeyId } = provenance(req.principal);
    const inserted = await db
      .insert(materials)
      .values({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        tags: parsed.data.tags ?? [],
        createdByAdminId: adminId,
        createdByApiKeyId: apiKeyId,
      })
      .returning({ id: materials.id });

    const detail = await loadDetail(inserted[0]!.id);
    return reply.code(201).send(detail);
  });

  /* ---------- GET /api/materials/:id ---------- */
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid id' });
    const detail = await loadDetail(parsed.data.id);
    if (!detail) return reply.code(404).send({ error: 'not found' });
    return reply.send(detail);
  });

  /* ---------- PUT /api/materials/:id ---------- */
  app.put<{ Params: { id: string }; Body: unknown }>('/:id', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse(req.params);
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const patch: Partial<typeof materials.$inferInsert> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.tags !== undefined) patch.tags = parsed.data.tags;
    if (parsed.data.parameters !== undefined) patch.parameters = parametersMergeSql(parsed.data.parameters);

    const updated = await db
      .update(materials)
      .set(patch)
      .where(and(eq(materials.id, parsedId.data.id), isNull(materials.deletedAt)))
      .returning({ id: materials.id });
    if (!updated[0]) return reply.code(404).send({ error: 'not found' });
    return reply.send(await loadDetail(parsedId.data.id));
  });

  /* ---------- PUT /api/materials/:id/parameters ---------- */
  // Focused endpoint for live PBR edits: accepts a partial parameters object,
  // shallow-merges it into the stored jsonb and bumps updatedAt, without
  // touching name/description/tags. The SPA debounces slider/colour changes
  // here so they never clobber the metadata form.
  app.put<{ Params: { id: string }; Body: unknown }>('/:id/parameters', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse(req.params);
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const parsed = materialParametersSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const updated = await db
      .update(materials)
      .set({ parameters: parametersMergeSql(parsed.data), updatedAt: new Date() })
      .where(and(eq(materials.id, parsedId.data.id), isNull(materials.deletedAt)))
      .returning({ id: materials.id });
    if (!updated[0]) return reply.code(404).send({ error: 'not found' });
    return reply.send(await loadDetail(parsedId.data.id));
  });

  /* ---------- DELETE /api/materials/:id ---------- */
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [requireAuth, requireScope('materials:delete')],
  }, async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid id' });
    const updated = await db
      .update(materials)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(materials.id, parsed.data.id), isNull(materials.deletedAt)))
      .returning({ id: materials.id });
    if (!updated[0]) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  /* ---------- PUT /api/materials/:id/slots/:slot ---------- */
  app.put<{ Params: { id: string; slot: string }; Body: unknown }>('/:id/slots/:slot', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse({ id: req.params.id });
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const slot = req.params.slot.toLowerCase();
    if (!isMaterialSlot(slot)) {
      return reply.code(400).send({ error: 'invalid slot', allowedSlots: [...ALLOWED_SLOTS] });
    }
    const parsed = assignBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const material = await db.query.materials.findFirst({
      where: and(eq(materials.id, parsedId.data.id), isNull(materials.deletedAt)),
    });
    if (!material) return reply.code(404).send({ error: 'material not found' });

    const texture = await db.query.textures.findFirst({
      where: and(eq(textures.id, parsed.data.textureId), isNull(textures.deletedAt)),
    });
    if (!texture) return reply.code(404).send({ error: 'texture not found' });

    await db
      .insert(materialTextures)
      .values({ materialId: parsedId.data.id, slot, textureId: parsed.data.textureId })
      .onConflictDoUpdate({
        target: [materialTextures.materialId, materialTextures.slot],
        set: { textureId: parsed.data.textureId, assignedAt: new Date() },
      });

    await db
      .update(materials)
      .set({ updatedAt: new Date(), ...(slot === 'albedo' ? { thumbnailTextureId: parsed.data.textureId } : {}) })
      .where(eq(materials.id, parsedId.data.id));

    return reply.send(await loadDetail(parsedId.data.id));
  });

  /* ---------- DELETE /api/materials/:id/slots/:slot ---------- */
  app.delete<{ Params: { id: string; slot: string } }>('/:id/slots/:slot', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse({ id: req.params.id });
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const slot = req.params.slot.toLowerCase();
    if (!isMaterialSlot(slot)) {
      return reply.code(400).send({ error: 'invalid slot', allowedSlots: [...ALLOWED_SLOTS] });
    }

    const material = await db.query.materials.findFirst({
      where: and(eq(materials.id, parsedId.data.id), isNull(materials.deletedAt)),
    });
    if (!material) return reply.code(404).send({ error: 'material not found' });

    await db
      .delete(materialTextures)
      .where(and(eq(materialTextures.materialId, parsedId.data.id), eq(materialTextures.slot, slot)));

    // The thumbnail mirrors the albedo slot — clearing albedo clears it too.
    await db
      .update(materials)
      .set({ updatedAt: new Date(), ...(slot === 'albedo' ? { thumbnailTextureId: null } : {}) })
      .where(eq(materials.id, parsedId.data.id));

    return reply.send(await loadDetail(parsedId.data.id));
  });

  /* ---------- GET /api/materials/:id/download ---------- */
  app.get<{ Params: { id: string } }>('/:id/download', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid id' });

    const material = await db.query.materials.findFirst({
      where: and(eq(materials.id, parsed.data.id), isNull(materials.deletedAt)),
    });
    if (!material) return reply.code(404).send({ error: 'not found' });

    const slotRows = await db
      .select({
        slot: materialTextures.slot,
        textureId: materialTextures.textureId,
        originalFilename: textures.originalFilename,
        contentType: textures.contentType,
        storagePath: textures.storagePath,
      })
      .from(materialTextures)
      .innerJoin(textures, eq(textures.id, materialTextures.textureId))
      .where(eq(materialTextures.materialId, parsed.data.id));

    const manifestSlots: Record<string, { textureId: string; filename: string; contentType: string }> = {};
    const files: Array<{ name: string; path: string }> = [];
    for (const r of slotRows) {
      const name = `${r.slot}_${sanitiseFilename(r.originalFilename)}`;
      try {
        await stat(r.storagePath);
      } catch {
        continue; // body missing on disk — omit from the archive + manifest
      }
      files.push({ name, path: r.storagePath });
      manifestSlots[r.slot] = { textureId: r.textureId, filename: name, contentType: r.contentType };
    }

    const manifest = {
      materialId: material.id,
      name: material.name,
      parameters: mergeParameters(material.parameters),
      slots: manifestSlots,
    };
    const zipName = `${sanitiseFilename(material.name)}.zip`;

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on('warning', (err) => req.log.warn({ err }, 'material zip warning'));
    archive.on('error', (err) => req.log.error({ err }, 'material zip error'));

    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${encodeURIComponent(zipName)}"`);

    for (const f of files) archive.file(f.path, { name: f.name });
    archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), { name: 'manifest.json' });
    void archive.finalize();

    return reply.send(archive);
  });

  /* ---------- POST /api/materials/import ---------- */
  app.post('/import', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(415).send({ error: 'multipart/form-data required' });

    const part = await req.file({ limits: { fileSize: MAX_ZIP_BYTES + 1 } });
    if (!part) return reply.code(400).send({ error: 'file part missing' });
    const nameField = fieldValue(part.fields, 'name');

    const chunks: Buffer[] = [];
    let bytesSoFar = 0;
    for await (const chunk of part.file) {
      const buf = chunk as Buffer;
      bytesSoFar += buf.length;
      if (bytesSoFar > MAX_ZIP_BYTES || part.file.truncated) {
        return reply.code(413).send({ error: 'zip too large', maxBytes: MAX_ZIP_BYTES });
      }
      chunks.push(buf);
    }
    if (part.file.truncated) return reply.code(413).send({ error: 'zip too large', maxBytes: MAX_ZIP_BYTES });
    if (bytesSoFar === 0) return reply.code(400).send({ error: 'zip is empty' });

    let entries: AdmZip.IZipEntry[];
    try {
      entries = new AdmZip(Buffer.concat(chunks, bytesSoFar)).getEntries();
    } catch {
      return reply.code(400).send({ error: 'invalid zip archive' });
    }

    // First image entry per slot wins; everything else (non-image, unmatched,
    // or a duplicate slot) lands in `skipped`.
    const detected = new Map<string, { base: string; contentType: string; data: Buffer }>();
    const skipped: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const base = baseName(entry.entryName);
      if (!base) continue;
      const contentType = imageContentType(base);
      const slot = isImageFilename(base) ? detectSlot(base) : null;
      if (!contentType || !slot || detected.has(slot)) {
        skipped.push(base);
        continue;
      }
      detected.set(slot, { base, contentType, data: entry.getData() });
    }

    const zipBase = (part.filename || '').replace(/\.zip$/i, '');
    const name = (nameField?.trim() || zipBase || 'Imported material').slice(0, 256);
    const { adminId, apiKeyId } = provenance(req.principal);

    const writtenPaths: string[] = [];
    try {
      const materialId = await db.transaction(async (tx) => {
        const insertedMaterial = await tx
          .insert(materials)
          .values({ name, tags: [], createdByAdminId: adminId, createdByApiKeyId: apiKeyId })
          .returning({ id: materials.id });
        const newMaterialId = insertedMaterial[0]!.id;

        let thumbnailTextureId: string | null = null;
        for (const slot of ALLOWED_SLOTS) {
          const det = detected.get(slot);
          if (!det) continue;
          const textureId = randomUUID();
          const storagePath = resolve(TEXTURES_ROOT, `${textureId}_${sanitiseFilename(det.base)}`);
          await writeFile(storagePath, det.data);
          writtenPaths.push(storagePath);

          await tx.insert(textures).values({
            id: textureId,
            originalFilename: det.base.slice(0, 256),
            displayName: det.base.slice(0, 256),
            contentType: det.contentType,
            sizeBytes: det.data.length,
            storagePath,
            tags: [],
            uploadedByAdminId: adminId,
            uploadedByApiKeyId: apiKeyId,
          });
          await tx.insert(materialTextures).values({ materialId: newMaterialId, slot, textureId });
          if (slot === 'albedo') thumbnailTextureId = textureId;
        }

        if (thumbnailTextureId) {
          await tx
            .update(materials)
            .set({ thumbnailTextureId, updatedAt: new Date() })
            .where(eq(materials.id, newMaterialId));
        }
        return newMaterialId;
      });

      const detail = await loadDetail(materialId);
      return reply.code(201).send({ ...detail, skipped });
    } catch (err) {
      // Roll back the orphaned files the failed transaction left behind.
      await Promise.all(writtenPaths.map((p) => unlink(p).catch(() => { /* already gone */ })));
      req.log.error({ err }, 'material import failed');
      return reply.code(500).send({ error: 'import failed' });
    }
  });
};

export default plugin;

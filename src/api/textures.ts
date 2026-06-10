/**
 * /api/textures — shared texture library.
 *
 * Textures are stored globally (one file, one UUID) and referenced by
 * materials via the `material_textures` join table, so the same texture can
 * be reused across many materials. The file body lives under
 *
 *     ${DATA_DIR}/textures/<id>_<sanitised-filename>
 *
 * mirroring how project attachments persist their bodies (see
 * api/projectAttachments.ts). Deletes are soft — the row is stamped with
 * `deleted_at` and the on-disk body is left in place — and refused with 409
 * while any live material still references the texture.
 *
 * Surface:
 *
 *   GET    /api/textures                 list (q / tags / cursor / limit)
 *   POST   /api/textures                 multipart upload            (write)
 *   GET    /api/textures/:id             metadata
 *   PUT    /api/textures/:id             rename / retag              (write)
 *   DELETE /api/textures/:id             soft-delete (409 if in use) (delete)
 *   GET    /api/textures/:id/download    stream the body
 *
 * Reads require `materials:read`; admin sessions and ORBIT bearers bypass
 * scope checks as usual (see auth/middleware.ts requireScope).
 */
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { db, materials, materialTextures, textures, requireAuth, requireScope } from '@rebus-industries/prism-shared';

const DATA_DIR = process.env.PRISM_DATA_DIR ?? process.env.DATA_DIR ?? '/data/prism';
const TEXTURES_ROOT = resolve(DATA_DIR, 'textures');

// 50 MB hard cap — mirrors the project-attachments surface. A single 8K PBR
// channel rarely exceeds ~30 MB even uncompressed.
const MAX_BODY_BYTES = 50 * 1024 * 1024;

const idParam = z.object({ id: z.string().uuid() });
const updateBody = z.object({
  displayName: z.string().min(1).max(256).optional(),
  tags: z.array(z.string().min(1).max(64)).max(64).optional(),
});

/** Sanitise an upload filename for use on disk (matches projectAttachments). */
function sanitiseFilename(input: string): string {
  const base = input.replace(/[\\/]+/g, '_');
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'texture';
}

/** Pull a string value out of @fastify/multipart's `fields` bag. Only fields
 * that arrive *before* the file part are present when `req.file()` resolves. */
function fieldValue(fields: unknown, name: string): string | undefined {
  const bag = fields as Record<string, unknown> | undefined;
  const raw = bag?.[name];
  const one = Array.isArray(raw) ? raw[0] : raw;
  const node = one as { type?: string; value?: unknown } | undefined;
  if (node && node.type === 'field' && node.value != null) return String(node.value);
  return undefined;
}

function parseTags(value: string | undefined): string[] {
  if (!value) return [];
  // Accept either a JSON array or a comma-separated list.
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean).slice(0, 64);
    } catch { /* fall through to CSV */ }
  }
  return trimmed.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 64);
}

interface PublicTexture {
  id: string;
  originalFilename: string;
  displayName: string;
  contentType: string;
  sizeBytes: number;
  tags: string[];
  uploadedByAdminId: string | null;
  uploadedByApiKeyId: string | null;
  createdAt: string;
  referenceCount: number;
}

type TextureRow = typeof textures.$inferSelect & { referenceCount?: number | string | null };

function toPublic(row: TextureRow): PublicTexture {
  return {
    id: row.id,
    originalFilename: row.originalFilename,
    displayName: row.displayName ?? row.originalFilename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    tags: Array.isArray(row.tags) ? row.tags : [],
    uploadedByAdminId: row.uploadedByAdminId,
    uploadedByApiKeyId: row.uploadedByApiKeyId,
    createdAt: row.createdAt.toISOString(),
    referenceCount: Number(row.referenceCount ?? 0),
  };
}

// Count of live (non-deleted) materials referencing the texture row.
const referenceCountSql = sql<number>`(
  select count(*)::int from ${materialTextures} mt
  join ${materials} m on m.id = mt.material_id
  where mt.texture_id = ${textures.id} and m.deleted_at is null
)`;

const selectColumns = {
  id: textures.id,
  originalFilename: textures.originalFilename,
  displayName: textures.displayName,
  contentType: textures.contentType,
  sizeBytes: textures.sizeBytes,
  storagePath: textures.storagePath,
  tags: textures.tags,
  uploadedByAdminId: textures.uploadedByAdminId,
  uploadedByApiKeyId: textures.uploadedByApiKeyId,
  createdAt: textures.createdAt,
  deletedAt: textures.deletedAt,
  referenceCount: referenceCountSql,
};

/** Load a single live texture row with its reference count, or null. */
async function loadTexture(id: string): Promise<TextureRow | null> {
  const rows = await db
    .select(selectColumns)
    .from(textures)
    .where(and(eq(textures.id, id), isNull(textures.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

const plugin: FastifyPluginAsync = async (app) => {
  await mkdir(TEXTURES_ROOT, { recursive: true }).catch(() => { /* race-tolerant */ });

  /* ---------- GET /api/textures ---------- */
  app.get<{ Querystring: { q?: string; tags?: string; cursor?: string; limit?: string } }>('/', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
    const offset = Math.max(Number(req.query.cursor ?? 0), 0);
    const q = (req.query.q ?? '').trim();
    const tags = (req.query.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);

    const conditions = [isNull(textures.deletedAt)];
    if (q) {
      conditions.push(or(ilike(textures.displayName, `%${q}%`), ilike(textures.originalFilename, `%${q}%`))!);
    }
    if (tags.length) {
      conditions.push(sql`${textures.tags} && ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[]`);
    }

    const rows = await db
      .select(selectColumns)
      .from(textures)
      .where(and(...conditions))
      .orderBy(desc(textures.createdAt))
      .limit(limit)
      .offset(offset);

    const nextCursor = rows.length === limit ? String(offset + rows.length) : null;
    return { textures: rows.map(toPublic), limit, cursor: String(offset), nextCursor };
  });

  /* ---------- POST /api/textures ---------- */
  app.post('/', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(415).send({ error: 'multipart/form-data required' });

    const part = await req.file({ limits: { fileSize: MAX_BODY_BYTES + 1 } });
    if (!part) return reply.code(400).send({ error: 'file part missing' });

    const rawFilename = part.filename || 'texture';
    const mime = (part.mimetype || '').toLowerCase().split(';')[0]!.trim() || 'application/octet-stream';
    // Fields that precede the file in the multipart body are captured here.
    const displayNameField = fieldValue(part.fields, 'displayName');
    const tags = parseTags(fieldValue(part.fields, 'tags'));

    const chunks: Buffer[] = [];
    let bytesSoFar = 0;
    for await (const chunk of part.file) {
      const buf = chunk as Buffer;
      bytesSoFar += buf.length;
      if (bytesSoFar > MAX_BODY_BYTES || part.file.truncated) {
        return reply.code(413).send({ error: 'texture too large', maxBytes: MAX_BODY_BYTES });
      }
      chunks.push(buf);
    }
    if (part.file.truncated) return reply.code(413).send({ error: 'texture too large', maxBytes: MAX_BODY_BYTES });
    if (bytesSoFar === 0) return reply.code(400).send({ error: 'texture is empty' });

    const body = Buffer.concat(chunks, bytesSoFar);
    const principal = req.principal!;
    const uploadedByAdminId = principal.kind === 'adminSession' ? principal.adminUserId : null;
    const uploadedByApiKeyId = principal.kind === 'apiKey' ? principal.apiKeyId : null;

    const inserted = await db
      .insert(textures)
      .values({
        originalFilename: rawFilename.slice(0, 256),
        displayName: (displayNameField ?? rawFilename).slice(0, 256),
        contentType: mime,
        sizeBytes: bytesSoFar,
        storagePath: '',
        tags,
        uploadedByAdminId,
        uploadedByApiKeyId,
      })
      .returning();

    const row = inserted[0]!;
    const storagePath = resolve(TEXTURES_ROOT, `${row.id}_${sanitiseFilename(rawFilename)}`);
    await writeFile(storagePath, body);

    const updated = await db
      .update(textures)
      .set({ storagePath })
      .where(eq(textures.id, row.id))
      .returning();

    return reply.code(201).send(toPublic({ ...updated[0]!, referenceCount: 0 }));
  });

  /* ---------- GET /api/textures/:id ---------- */
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid id' });
    const row = await loadTexture(parsed.data.id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    return reply.send(toPublic(row));
  });

  /* ---------- PUT /api/textures/:id ---------- */
  app.put<{ Params: { id: string }; Body: unknown }>('/:id', {
    preHandler: [requireAuth, requireScope('materials:write')],
  }, async (req, reply) => {
    const parsedId = idParam.safeParse(req.params);
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid id' });
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    if (parsed.data.displayName === undefined && parsed.data.tags === undefined) {
      return reply.code(400).send({ error: 'nothing to update' });
    }

    const patch: Partial<typeof textures.$inferInsert> = {};
    if (parsed.data.displayName !== undefined) patch.displayName = parsed.data.displayName;
    if (parsed.data.tags !== undefined) patch.tags = parsed.data.tags;

    const updated = await db
      .update(textures)
      .set(patch)
      .where(and(eq(textures.id, parsedId.data.id), isNull(textures.deletedAt)))
      .returning({ id: textures.id });
    if (!updated[0]) return reply.code(404).send({ error: 'not found' });
    return reply.send(toPublic((await loadTexture(parsedId.data.id))!));
  });

  /* ---------- DELETE /api/textures/:id ---------- */
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [requireAuth, requireScope('materials:delete')],
  }, async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid id' });

    const row = await db.query.textures.findFirst({
      where: and(eq(textures.id, parsed.data.id), isNull(textures.deletedAt)),
    });
    if (!row) return reply.code(404).send({ error: 'not found' });

    const referencing = await db
      .select({ id: materials.id, name: materials.name })
      .from(materialTextures)
      .innerJoin(materials, eq(materials.id, materialTextures.materialId))
      .where(and(eq(materialTextures.textureId, parsed.data.id), isNull(materials.deletedAt)));

    if (referencing.length) {
      return reply.code(409).send({
        error: 'texture is referenced by active materials',
        referencingMaterials: referencing,
      });
    }

    await db
      .update(textures)
      .set({ deletedAt: new Date() })
      .where(eq(textures.id, parsed.data.id));

    return reply.code(204).send();
  });

  /* ---------- GET /api/textures/:id/download ---------- */
  app.get<{ Params: { id: string } }>('/:id/download', {
    preHandler: [requireAuth, requireScope('materials:read')],
  }, async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid id' });
    const row = await db.query.textures.findFirst({
      where: and(eq(textures.id, parsed.data.id), isNull(textures.deletedAt)),
    });
    if (!row) return reply.code(404).send({ error: 'not found' });

    try {
      const s = await stat(row.storagePath);
      reply
        .header('content-type', row.contentType)
        .header('content-length', String(s.size))
        .header('content-disposition', `attachment; filename="${encodeURIComponent(row.originalFilename)}"`);
      return reply.send(createReadStream(row.storagePath));
    } catch {
      return reply.code(410).send({ error: 'texture body missing on disk' });
    }
  });
};

export default plugin;

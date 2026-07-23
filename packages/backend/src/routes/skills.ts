// Skill HTTP routes.
//
//   GET    /api/skills                              list
//   POST   /api/skills                              create managed
//   POST   /api/skills/import-zip/parse             RFC-019 dry-run parse
//   POST   /api/skills/import-zip/commit            RFC-019 apply decisions
//   GET    /api/skills/:id                          skill metadata
//   PUT    /api/skills/:id                          update DB metadata (description)
//   DELETE /api/skills/:id                          delete (refuses if referenced)
//
//   GET    /api/skills/:id/content                  read parsed SKILL.md
//   PUT    /api/skills/:id/content                  write SKILL.md
//
//   GET    /api/skills/:id/files                    list file tree
//   GET    /api/skills/:id/file?path=...            read one file (utf-8)
//   PUT    /api/skills/:id/file?path=...            write one file (utf-8)
//   DELETE /api/skills/:id/file?path=...            delete one file/dir

import {
  CreateManagedSkillSchema,
  RestoreSkillVersionSchema,
  SkillZipDecisionMapSchema,
  CombinedSaveSkillSchema,
  WriteSkillFileSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
import { assertDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import { Paths } from '@/util/paths'
import {
  createManagedSkill,
  deleteSkill,
  deleteSkillFile,
  getSkillById,
  getSkillPreconditionTokenById,
  listSkillFiles,
  listSkills,
  readSkillContent,
  readSkillFile,
  saveSkillWithToken,
  writeSkillFile,
  type SkillFsOptions,
} from '@/services/skill'
import { commitSkillZipBuffer, parseSkillZipBuffer, ZIP_LIMITS } from '@/services/skill-zip'
import {
  diffSkillVersions,
  getSkillVersionContent,
  listSkillVersions,
  restoreSkillVersion,
} from '@/services/skillVersion'
import { GoneError, NotFoundError, ValidationError } from '@/util/errors'
import { mountAclEndpoints } from './resourceAcl'

export function mountSkillRoutes(app: Hono, deps: AppDeps): void {
  const fsOpts: SkillFsOptions = { appHome: Paths.root }

  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleSkill(actor: Actor, id: string) {
    const skill = await getSkillById(deps.db, id)
    if (skill === null || !(await canViewResource(deps.db, actor, 'skill', skill))) {
      throw new NotFoundError('skill-not-found', 'skill not found')
    }
    return skill
  }

  app.get('/api/skills', async (c) =>
    c.json(await filterVisibleRows(deps.db, actorOf(c), 'skill', await listSkills(deps.db))),
  )

  app.post('/api/skills', async (c) => {
    const parsed = CreateManagedSkillSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('skill-invalid', 'invalid skill payload', {
        issues: parsed.error.issues,
      })
    }
    const created = await createManagedSkill(deps.db, fsOpts, parsed.data, {
      ownerUserId: actorOf(c).user.id,
    })
    return c.json(created, 201)
  })

  // --- RFC-019: ZIP batch import ---------------------------------------------

  app.post('/api/skills/import-zip/parse', async (c) => {
    const buffer = await readZipFileFromMultipart(c.req.raw)
    const { response } = await parseSkillZipBuffer(deps.db, actorOf(c), buffer)
    return c.json(response)
  })

  app.post('/api/skills/import-zip/commit', async (c) => {
    let form: Awaited<ReturnType<Request['formData']>>
    try {
      form = await c.req.raw.formData()
    } catch (err) {
      throw new ValidationError(
        'zip-multipart-invalid',
        `failed to parse multipart body: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const buffer = await extractZipBuffer(form)
    const decisionsRaw = form.get('decisions')
    if (typeof decisionsRaw !== 'string') {
      throw new ValidationError(
        'zip-decisions-missing',
        "form field 'decisions' (JSON string) is required",
      )
    }
    let decisionsJson: unknown
    try {
      decisionsJson = JSON.parse(decisionsRaw)
    } catch (err) {
      throw new ValidationError(
        'zip-decisions-invalid',
        `'decisions' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const decisionsParsed = SkillZipDecisionMapSchema.safeParse(decisionsJson)
    if (!decisionsParsed.success) {
      throw new ValidationError('zip-decisions-invalid', 'invalid decisions map', {
        issues: decisionsParsed.error.issues,
      })
    }
    const result = await commitSkillZipBuffer(deps.db, fsOpts, buffer, decisionsParsed.data, {
      actor: actorOf(c),
    })
    return c.json(result)
  })

  app.get('/api/skills/:id', async (c) => {
    return c.json(await loadVisibleSkill(actorOf(c), c.req.param('id')))
  })

  // RFC-170 T-BSAFE③ (§2/G3-3): the old metadata + content PUTs bypassed the
  // composite-token OCC / snapshot version funnel — both are 410 Gone. Every save
  // (managed body+description, external description) now goes through the single
  // POST /api/skills/:id/save combined-save below.
  app.put('/api/skills/:id', async (c) => {
    await loadVisibleSkill(actorOf(c), c.req.param('id'))
    throw new GoneError(
      'skill-endpoint-gone',
      'PUT /api/skills/:id is retired; use POST /api/skills/:id/save (combined-save with precondition token)',
    )
  })

  app.delete('/api/skills/:id', async (c) => {
    const actor = actorOf(c)
    const existing = await loadVisibleSkill(actor, c.req.param('id'))
    await requireResourceOwner(deps.db, actor, 'skill', existing)
    // RFC-222 (D5): type-to-confirm (N-5 order).
    assertDeleteConfirm(await readDeleteBody(c), existing.name, 'skill')
    await deleteSkill(deps.db, fsOpts, existing.id, actor)
    return c.body(null, 204)
  })

  // SKILL.md content (parsed view).
  app.get('/api/skills/:id/content', async (c) => {
    const existing = await loadVisibleSkill(actorOf(c), c.req.param('id'))
    return c.json(await readSkillContent(deps.db, fsOpts, existing.id))
  })

  app.put('/api/skills/:id/content', async (c) => {
    await loadVisibleSkill(actorOf(c), c.req.param('id'))
    throw new GoneError(
      'skill-endpoint-gone',
      'PUT /api/skills/:id/content is retired; use POST /api/skills/:id/save (combined-save with precondition token)',
    )
  })

  // RFC-170 §2/T4 — combined description+body save gated by the composite
  // precondition token from the detail read. Stale token → 409, malformed → 400.
  app.post('/api/skills/:id/save', async (c) => {
    const parsed = CombinedSaveSkillSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('skill-content-invalid', 'invalid combined save', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleSkill(actor, c.req.param('id'))
    await requireResourceOwner(deps.db, actor, 'skill', existing)
    const { expectedToken, ...patch } = parsed.data
    return c.json(
      await saveSkillWithToken(
        deps.db,
        fsOpts,
        existing.id,
        patch,
        expectedToken,
        actor.user.id,
        // RFC-170 (4th-review [high]): the owner we just authorized against — the
        // funnel 409s if it drifts before the version commits (owner-transfer race).
        existing.ownerUserId,
      ),
    )
  })

  // File tree + single-file CRUD.
  app.get('/api/skills/:id/files', async (c) => {
    const existing = await loadVisibleSkill(actorOf(c), c.req.param('id'))
    return c.json(await listSkillFiles(deps.db, fsOpts, existing.id))
  })

  app.get('/api/skills/:id/file', async (c) => {
    const existing = await loadVisibleSkill(actorOf(c), c.req.param('id'))
    const path = requirePath(c.req.query('path'))
    const content = await readSkillFile(deps.db, fsOpts, existing.id, path)
    return c.json({ path, content })
  })

  app.put('/api/skills/:id/file', async (c) => {
    const path = requirePath(c.req.query('path'))
    const parsed = WriteSkillFileSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('skill-file-invalid', 'invalid file write payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleSkill(actor, c.req.param('id'))
    await requireResourceOwner(deps.db, actor, 'skill', existing)
    await writeSkillFile(
      deps.db,
      fsOpts,
      existing.id,
      path,
      parsed.data.content,
      actor.user.id,
      // RFC-170 (4th-review [high]): the owner we just authorized against.
      existing.ownerUserId,
      // RFC-170 F3: OCC token from the client's canonical token store.
      parsed.data.expectedToken,
    )
    // RFC-170 F3: return the FRESH token so the client's canonical store advances.
    return c.json({
      ok: true,
      path,
      token: await getSkillPreconditionTokenById(deps.db, existing.id),
    })
  })

  app.delete('/api/skills/:id/file', async (c) => {
    const actor = actorOf(c)
    const existing = await loadVisibleSkill(actor, c.req.param('id'))
    await requireResourceOwner(deps.db, actor, 'skill', existing)
    const path = requirePath(c.req.query('path'))
    await deleteSkillFile(
      deps.db,
      fsOpts,
      existing.id,
      path,
      actor.user.id,
      existing.ownerUserId,
      // RFC-170 F3: OCC token (query param, since DELETE has no body).
      c.req.query('expectedToken'),
    )
    // RFC-170 F3: was 204; now returns the fresh token for the canonical store.
    return c.json({ token: await getSkillPreconditionTokenById(deps.db, existing.id) })
  })

  // RFC-101 — skill content version history.
  app.get('/api/skills/:id/versions', async (c) => {
    const existing = await loadVisibleSkill(actorOf(c), c.req.param('id'))
    return c.json(listSkillVersions(deps.db, fsOpts, existing.id))
  })

  app.get('/api/skills/:id/versions/diff', async (c) => {
    const existing = await loadVisibleSkill(actorOf(c), c.req.param('id'))
    const from = parseVersionParam(c.req.query('from'), 'from')
    const to = parseVersionParam(c.req.query('to'), 'to')
    return c.json(diffSkillVersions(deps.db, fsOpts, existing.id, from, to))
  })

  app.get('/api/skills/:id/versions/:v/content', async (c) => {
    const existing = await loadVisibleSkill(actorOf(c), c.req.param('id'))
    const v = parseVersionParam(c.req.param('v'), 'v')
    return c.json(getSkillVersionContent(deps.db, fsOpts, existing.id, v))
  })

  app.post('/api/skills/:id/versions/:v/restore', async (c) => {
    const parsed = RestoreSkillVersionSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('skill-restore-invalid', 'invalid restore payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleSkill(actor, c.req.param('id'))
    await requireResourceOwner(deps.db, actor, 'skill', existing)
    const v = parseVersionParam(c.req.param('v'), 'v')
    const result = restoreSkillVersion(
      deps.db,
      fsOpts,
      existing.id,
      v,
      actor.user.id,
      parsed.data.reason,
      // RFC-170 (4th-review [high]): the owner we just authorized against.
      existing.ownerUserId,
      // RFC-170 F3: OCC token from the client's canonical token store.
      parsed.data.expectedToken,
    )
    // RFC-170 F3: return the fresh token alongside the restore result.
    return c.json({
      ...result,
      token: await getSkillPreconditionTokenById(deps.db, existing.id),
    })
  })

  // RFC-099 / RFC-223 — GET/PUT /api/skills/:id/acl
  mountAclEndpoints(app, deps, {
    type: 'skill',
    base: '/api/skills',
    param: 'id',
    load: (db, id) => getSkillById(db, id),
  })
}

function requirePath(p: string | undefined): string {
  if (p === undefined || p.length === 0) {
    throw new ValidationError('path-required', "'path' query parameter is required")
  }
  return p
}

function parseVersionParam(raw: string | undefined, field: string): number {
  const n = Number(raw)
  if (raw === undefined || raw === '' || !Number.isInteger(n) || n < 1) {
    throw new ValidationError('skill-version-invalid', `'${field}' must be a positive integer`)
  }
  return n
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

async function readZipFileFromMultipart(req: Request): Promise<Uint8Array> {
  let form: Awaited<ReturnType<Request['formData']>>
  try {
    form = await req.formData()
  } catch (err) {
    throw new ValidationError(
      'zip-multipart-invalid',
      `failed to parse multipart body: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return extractZipBuffer(form)
}

async function extractZipBuffer(
  form: Awaited<ReturnType<Request['formData']>>,
): Promise<Uint8Array> {
  const file = form.get('file')
  if (file === null || typeof file === 'string') {
    throw new ValidationError(
      'zip-file-missing',
      "multipart form field 'file' (the zip) is required",
    )
  }
  if (file.size > ZIP_LIMITS.totalBytes) {
    throw new ValidationError(
      'zip-limit-exceeded',
      `uploaded file exceeds ${ZIP_LIMITS.totalBytes} bytes`,
    )
  }
  const ab = await file.arrayBuffer()
  return new Uint8Array(ab)
}

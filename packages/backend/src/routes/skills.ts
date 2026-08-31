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

import { SkillZipDecisionMapSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type {
  SkillCommands,
  SkillFileCommands,
  SkillVersionCommands,
} from '@/modules/resource-catalog/public/commands'
import type {
  SkillAclIdentityParticipant,
  SkillOperationContext,
} from '@/modules/resource-catalog/public/participants'
import type {
  SkillFileQueries,
  SkillQueries,
  SkillVersionQueries,
} from '@/modules/resource-catalog/public/queries'
import type { SkillCatalogResource } from '@/modules/resource-catalog/public/types'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import { Paths } from '@/util/paths'
import { commitSkillZipBuffer, parseSkillZipBuffer, ZIP_LIMITS } from '@/services/skill-zip'
import { GoneError, NotFoundError, ValidationError } from '@/util/errors'
import { mountAclEndpoints } from './resourceAcl'

export interface SkillRouteDependencies {
  readonly commands: SkillCommands
  readonly fileCommands: SkillFileCommands
  readonly versionCommands: SkillVersionCommands
  readonly queries: SkillQueries
  readonly fileQueries: SkillFileQueries
  readonly versionQueries: SkillVersionQueries
  readonly aclIdentity: SkillAclIdentityParticipant
  readonly authorityFor: (actor: Actor) => SkillOperationContext
}

export function mountSkillRoutes(app: Hono, deps: AppDeps, module: SkillRouteDependencies): void {
  const {
    commands,
    fileCommands,
    versionCommands,
    queries,
    fileQueries,
    versionQueries,
    aclIdentity,
  } = module
  const zipFsOpts = { appHome: Paths.root }

  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleSkill(actor: Actor, id: string): Promise<SkillCatalogResource> {
    const skill = await queries.get(module.authorityFor(actor), { id })
    if (skill === null) {
      throw new NotFoundError('skill-not-found', 'skill not found')
    }
    return skill
  }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/skills',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'List skills visible to the caller',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(await queries.list(module.authorityFor(actor)))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/skills',
      permissions: ['skills:create'],
      tokenAccess: 'allow',
      summary: 'Create a skill',
    },
    async (c) => {
      const actor = actorOf(c)
      const created = await commands.create(module.authorityFor(actor), {
        submission: {
          kind: 'json-body',
          body: await c.req.raw.text().catch(() => ''),
        },
      })
      return c.json(created, 201)
    },
  )

  // --- RFC-019: ZIP batch import ---------------------------------------------

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/skills/import-zip/parse',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'Parse a skill ZIP (pure, no side effect)',
    },
    async (c) => {
      const buffer = await readZipFileFromMultipart(c.req.raw)
      const { response } = await parseSkillZipBuffer(deps.db, actorOf(c), buffer)
      return c.json(response)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/skills/import-zip/commit',
      permissions: ['skills:create'],
      tokenAccess: 'allow',
      summary: 'Commit a parsed skill ZIP as a new skill',
    },
    async (c) => {
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
      const result = await commitSkillZipBuffer(deps.db, zipFsOpts, buffer, decisionsParsed.data, {
        actor: actorOf(c),
      })
      return c.json(result)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/skills/:id',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'Get one skill',
    },
    async (c) => {
      return c.json(await loadVisibleSkill(actorOf(c), c.req.param('id')))
    },
  )

  // RFC-170 T-BSAFE③ (§2/G3-3): the old metadata + content PUTs bypassed the
  // composite-token OCC / snapshot version funnel — both are 410 Gone. Every save
  // (managed body+description, external description) now goes through the single
  // POST /api/skills/:id/save combined-save below.
  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/skills/:id',
      permissions: ['skills:update'],
      tokenAccess: 'allow',
      summary: 'Replace a skill',
    },
    async (c) => {
      await loadVisibleSkill(actorOf(c), c.req.param('id'))
      throw new GoneError(
        'skill-endpoint-gone',
        'PUT /api/skills/:id is retired; use POST /api/skills/:id/save (combined-save with precondition token)',
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/skills/:id',
      permissions: ['skills:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a skill',
    },
    async (c) => {
      const actor = actorOf(c)
      const receipt = await commands.delete(module.authorityFor(actor), {
        id: c.req.param('id'),
        submission: {
          kind: 'json-body',
          body: await c.req.raw.text().catch(() => ''),
        },
      })
      captureDeleteSnapshot(c, actor, receipt.deleted)
      return c.body(null, 204)
    },
  )

  // SKILL.md content (parsed view).
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/skills/:id/content',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'Read SKILL.md',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(await queries.content(module.authorityFor(actor), { id: c.req.param('id') }))
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/skills/:id/content',
      permissions: ['skills:update'],
      tokenAccess: 'allow',
      summary: 'Replace SKILL.md',
    },
    async (c) => {
      await loadVisibleSkill(actorOf(c), c.req.param('id'))
      throw new GoneError(
        'skill-endpoint-gone',
        'PUT /api/skills/:id/content is retired; use POST /api/skills/:id/save (combined-save with precondition token)',
      )
    },
  )

  // RFC-170 §2/T4 — combined description+body save gated by the composite
  // precondition token from the detail read. Stale token → 409, malformed → 400.
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/skills/:id/save',
      permissions: ['skills:update'],
      tokenAccess: 'allow',
      summary: 'Save skill metadata + body',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        await commands.save(module.authorityFor(actor), {
          id: c.req.param('id'),
          submission: {
            kind: 'json-body',
            body: await c.req.raw.text().catch(() => ''),
          },
        }),
      )
    },
  )

  // File tree + single-file CRUD.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/skills/:id/files',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'List skill files',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(await fileQueries.list(module.authorityFor(actor), { id: c.req.param('id') }))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/skills/:id/file',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'Read one skill file',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        await fileQueries.read(module.authorityFor(actor), {
          id: c.req.param('id'),
          path: c.req.query('path') ?? '',
        }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/skills/:id/file',
      permissions: ['skills:update'],
      tokenAccess: 'allow',
      summary: 'Write one skill file',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        await fileCommands.write(module.authorityFor(actor), {
          id: c.req.param('id'),
          path: c.req.query('path') ?? '',
          submission: {
            kind: 'json-body',
            body: await c.req.raw.text().catch(() => ''),
          },
        }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/skills/:id/file',
      permissions: ['skills:delete'],
      tokenAccess: 'allow',
      summary: 'Delete one skill file',
    },
    async (c) => {
      const actor = actorOf(c)
      const receipt = await fileCommands.delete(module.authorityFor(actor), {
        id: c.req.param('id'),
        path: c.req.query('path') ?? '',
        expectedToken: c.req.query('expectedToken'),
        submission: {
          kind: 'json-body',
          body: await c.req.raw.text().catch(() => ''),
        },
      })
      captureDeleteSnapshot(c, actor, receipt.deleted)
      return c.json({ token: receipt.token })
    },
  )

  // RFC-101 — skill content version history.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/skills/:id/versions',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'List skill versions',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        await versionQueries.list(module.authorityFor(actor), { id: c.req.param('id') }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/skills/:id/versions/diff',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'Diff two skill versions',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        await versionQueries.diff(module.authorityFor(actor), {
          id: c.req.param('id'),
          from: c.req.query('from') ?? '',
          to: c.req.query('to') ?? '',
        }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/skills/:id/versions/:v/content',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'Read one skill version',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        await versionQueries.content(module.authorityFor(actor), {
          id: c.req.param('id'),
          version: c.req.param('v'),
        }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/skills/:id/versions/:v/restore',
      permissions: ['skills:update'],
      tokenAccess: 'allow',
      summary: 'Restore a skill version',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        await versionCommands.restore(module.authorityFor(actor), {
          id: c.req.param('id'),
          version: c.req.param('v'),
          submission: {
            kind: 'json-body',
            body: await c.req.raw.text().catch(() => ''),
          },
        }),
      )
    },
  )

  // RFC-099 / RFC-223 — GET/PUT /api/skills/:id/acl
  mountAclEndpoints(app, deps, {
    type: 'skill',
    base: '/api/skills',
    param: 'id',
    load: (_db, id) => aclIdentity.load(id),
  })
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

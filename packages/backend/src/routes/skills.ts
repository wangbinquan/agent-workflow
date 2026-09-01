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

import { SKILL_ZIP_LIMITS, SkillZipDecisionMapSchema } from '@agent-workflow/shared'
import { Buffer } from 'node:buffer'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type {
  SkillFileCommands,
  SkillVersionCommands,
} from '@/modules/resource-catalog/public/commands'
import type { SkillOperationDescriptors } from '@/modules/resource-catalog/public/operations'
import type {
  SkillOperationContext,
  SkillZipImportParticipant,
} from '@/modules/resource-catalog/public/participants'
import type {
  SkillFileQueries,
  SkillQueries,
  SkillVersionQueries,
} from '@/modules/resource-catalog/public/queries'
import type {
  CreateSkillCatalogInput,
  DeleteSkillCatalogInput,
  DeleteSkillCatalogReceipt,
  SaveSkillCatalogInput,
  SkillCatalogResource,
} from '@/modules/resource-catalog/public/types'
import { registerRoute } from '@/routes/registry'
import { registerOperationRoute } from '@/routes/operationRoute'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import { GoneError, NotFoundError, ValidationError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'

export interface SkillRouteDependencies {
  readonly fileCommands: SkillFileCommands
  readonly versionCommands: SkillVersionCommands
  readonly queries: SkillQueries
  readonly fileQueries: SkillFileQueries
  readonly versionQueries: SkillVersionQueries
  readonly operations: SkillOperationDescriptors
  readonly zipImport: SkillZipImportParticipant
  readonly authorityFor: (actor: Actor) => SkillOperationContext
}

export function mountSkillRoutes(app: Hono, module: SkillRouteDependencies): void {
  const { queries, operations } = module

  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleSkill(actor: Actor, id: string): Promise<SkillCatalogResource> {
    const skill = await queries.get(module.authorityFor(actor), { id })
    if (skill === null) {
      throw new NotFoundError('skill-not-found', 'skill not found')
    }
    return skill
  }

  registerOperationRoute(app, {
    descriptor: operations.list,
    method: 'GET',
    path: '/api/skills',
    tokenAccess: 'allow',
    decode: () => ({}),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, output) => c.json(output),
  })

  registerOperationRoute(app, {
    descriptor: operations.create,
    method: 'POST',
    path: '/api/skills',
    tokenAccess: 'allow',
    decode: async (c) =>
      ({
        submission: {
          kind: 'json-body',
          body: await c.req.raw.text().catch(() => ''),
        },
      }) satisfies CreateSkillCatalogInput,
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, created) => c.json(created, 201),
  })

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
      const response = await module.zipImport.parse(module.authorityFor(actorOf(c)), {
        archive: skillZipArchive(buffer),
      })
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
      const result = await module.zipImport.commit(module.authorityFor(actorOf(c)), {
        archive: skillZipArchive(buffer),
        decisions: decisionsParsed.data,
      })
      return c.json(result)
    },
  )

  registerOperationRoute(app, {
    descriptor: operations.get,
    method: 'GET',
    path: '/api/skills/:id',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, skill) => {
      if (skill === null) throw new NotFoundError('skill-not-found', 'skill not found')
      return c.json(skill)
    },
  })

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

  registerOperationRoute(app, {
    descriptor: operations.delete,
    method: 'DELETE',
    path: '/api/skills/:id',
    tokenAccess: 'allow',
    decode: async (c) =>
      ({
        id: c.req.param('id'),
        submission: {
          kind: 'json-body',
          body: await c.req.raw.text().catch(() => ''),
        },
      }) satisfies DeleteSkillCatalogInput,
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, receipt: DeleteSkillCatalogReceipt) => {
      captureDeleteSnapshot(c, actorOf(c), receipt.deleted)
      return c.body(null, 204)
    },
  })

  // SKILL.md content (parsed view).
  registerOperationRoute(app, {
    descriptor: operations.content,
    method: 'GET',
    path: '/api/skills/:id/content',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, content) => c.json(content),
  })

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
  registerOperationRoute(app, {
    descriptor: operations.save,
    method: 'POST',
    path: '/api/skills/:id/save',
    tokenAccess: 'allow',
    decode: async (c) =>
      ({
        id: c.req.param('id'),
        submission: {
          kind: 'json-body',
          body: await c.req.raw.text().catch(() => ''),
        },
      }) satisfies SaveSkillCatalogInput,
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, saved) => c.json(saved),
  })

  // File tree + single-file CRUD.
  registerOperationRoute(app, {
    descriptor: operations.listFiles,
    method: 'GET',
    path: '/api/skills/:id/files',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, files) => c.json(files),
  })

  registerOperationRoute(app, {
    descriptor: operations.readFile,
    method: 'GET',
    path: '/api/skills/:id/file',
    tokenAccess: 'allow',
    decode: (c) => ({
      id: c.req.param('id'),
      path: c.req.query('path') ?? '',
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, file) => c.json(file),
  })

  registerOperationRoute(app, {
    descriptor: operations.writeFile,
    method: 'PUT',
    path: '/api/skills/:id/file',
    tokenAccess: 'allow',
    decode: async (c) => ({
      id: c.req.param('id'),
      path: c.req.query('path') ?? '',
      submission: {
        kind: 'json-body',
        body: await c.req.raw.text().catch(() => ''),
      },
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, receipt) => c.json(receipt),
  })

  registerOperationRoute(app, {
    descriptor: operations.deleteFile,
    method: 'DELETE',
    path: '/api/skills/:id/file',
    tokenAccess: 'allow',
    decode: async (c) => ({
      id: c.req.param('id'),
      path: c.req.query('path') ?? '',
      expectedToken: c.req.query('expectedToken'),
      submission: {
        kind: 'json-body',
        body: await c.req.raw.text().catch(() => ''),
      },
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, receipt) => {
      captureDeleteSnapshot(c, actorOf(c), receipt.deleted)
      return c.json({ token: receipt.token })
    },
  })

  // RFC-101 — skill content version history.
  registerOperationRoute(app, {
    descriptor: operations.listVersions,
    method: 'GET',
    path: '/api/skills/:id/versions',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, versions) => c.json(versions),
  })

  registerOperationRoute(app, {
    descriptor: operations.diffVersions,
    method: 'GET',
    path: '/api/skills/:id/versions/diff',
    tokenAccess: 'allow',
    decode: (c) => ({
      id: c.req.param('id'),
      from: c.req.query('from') ?? '',
      to: c.req.query('to') ?? '',
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, diff) => c.json(diff),
  })

  registerOperationRoute(app, {
    descriptor: operations.getVersionContent,
    method: 'GET',
    path: '/api/skills/:id/versions/:v/content',
    tokenAccess: 'allow',
    decode: (c) => ({
      id: c.req.param('id'),
      version: c.req.param('v'),
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, content) => c.json(content),
  })

  registerOperationRoute(app, {
    descriptor: operations.restoreVersion,
    method: 'POST',
    path: '/api/skills/:id/versions/:v/restore',
    tokenAccess: 'allow',
    decode: async (c) => ({
      id: c.req.param('id'),
      version: c.req.param('v'),
      submission: {
        kind: 'json-body',
        body: await c.req.raw.text().catch(() => ''),
      },
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, receipt) => c.json(receipt),
  })

  // RFC-099 / RFC-223 — GET/PUT /api/skills/:id/acl
  registerOperationRoute(app, {
    descriptor: operations.getAcl,
    method: 'GET',
    path: '/api/skills/:id/acl',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, acl) => c.json(acl),
  })

  registerOperationRoute(app, {
    descriptor: operations.updateAcl,
    method: 'PUT',
    path: '/api/skills/:id/acl',
    tokenAccess: 'never',
    decode: async (c) => ({
      id: c.req.param('id'),
      submission: {
        kind: 'json-body',
        body: JSON.stringify(await safeJsonOrEmpty(c.req.raw)) ?? '{}',
      },
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, acl) => c.json(acl),
  })
}

function skillZipArchive(buffer: Uint8Array) {
  return Object.freeze({
    encoding: 'base64' as const,
    content: Buffer.from(buffer).toString('base64'),
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
  if (file.size > SKILL_ZIP_LIMITS.totalBytes) {
    throw new ValidationError(
      'zip-limit-exceeded',
      `uploaded file exceeds ${SKILL_ZIP_LIMITS.totalBytes} bytes`,
    )
  }
  const ab = await file.arrayBuffer()
  return new Uint8Array(ab)
}

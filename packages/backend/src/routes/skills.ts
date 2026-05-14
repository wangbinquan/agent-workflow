// Skill HTTP routes.
//
//   GET    /api/skills                              list
//   POST   /api/skills                              create managed
//   POST   /api/skills/import-external              register external path
//   GET    /api/skills/:name                        skill metadata
//   PUT    /api/skills/:name                        update DB metadata (description)
//   DELETE /api/skills/:name                        delete (refuses if referenced)
//
//   GET    /api/skills/:name/content                read parsed SKILL.md
//   PUT    /api/skills/:name/content                write SKILL.md
//
//   GET    /api/skills/:name/files                  list file tree
//   GET    /api/skills/:name/file?path=...          read one file (utf-8)
//   PUT    /api/skills/:name/file?path=...          write one file (utf-8)
//   DELETE /api/skills/:name/file?path=...          delete one file/dir

import {
  CreateManagedSkillSchema,
  ImportExternalSkillSchema,
  UpdateSkillContentSchema,
  UpdateSkillSchema,
  WriteSkillFileSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { Paths } from '@/util/paths'
import {
  createManagedSkill,
  deleteSkill,
  deleteSkillFile,
  getSkill,
  importExternalSkill,
  listSkillFiles,
  listSkills,
  readSkillContent,
  readSkillFile,
  updateSkill,
  writeSkillContent,
  writeSkillFile,
  type SkillFsOptions,
} from '@/services/skill'
import { NotFoundError, ValidationError } from '@/util/errors'

export function mountSkillRoutes(app: Hono, deps: AppDeps): void {
  const fsOpts: SkillFsOptions = { appHome: Paths.root }

  app.get('/api/skills', async (c) => c.json(await listSkills(deps.db)))

  app.post('/api/skills', async (c) => {
    const parsed = CreateManagedSkillSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('skill-invalid', 'invalid skill payload', {
        issues: parsed.error.issues,
      })
    }
    const created = await createManagedSkill(deps.db, fsOpts, parsed.data)
    return c.json(created, 201)
  })

  app.post('/api/skills/import-external', async (c) => {
    const parsed = ImportExternalSkillSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('skill-invalid', 'invalid external skill payload', {
        issues: parsed.error.issues,
      })
    }
    const created = await importExternalSkill(deps.db, parsed.data)
    return c.json(created, 201)
  })

  app.get('/api/skills/:name', async (c) => {
    const skill = await getSkill(deps.db, c.req.param('name'))
    if (skill === null) {
      throw new NotFoundError('skill-not-found', `skill '${c.req.param('name')}' not found`)
    }
    return c.json(skill)
  })

  app.put('/api/skills/:name', async (c) => {
    const parsed = UpdateSkillSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('skill-invalid', 'invalid skill patch', {
        issues: parsed.error.issues,
      })
    }
    return c.json(await updateSkill(deps.db, c.req.param('name'), parsed.data))
  })

  app.delete('/api/skills/:name', async (c) => {
    await deleteSkill(deps.db, fsOpts, c.req.param('name'))
    return c.body(null, 204)
  })

  // SKILL.md content (parsed view).
  app.get('/api/skills/:name/content', async (c) =>
    c.json(await readSkillContent(deps.db, fsOpts, c.req.param('name'))),
  )

  app.put('/api/skills/:name/content', async (c) => {
    const parsed = UpdateSkillContentSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('skill-content-invalid', 'invalid SKILL.md patch', {
        issues: parsed.error.issues,
      })
    }
    return c.json(await writeSkillContent(deps.db, fsOpts, c.req.param('name'), parsed.data))
  })

  // File tree + single-file CRUD.
  app.get('/api/skills/:name/files', async (c) =>
    c.json(await listSkillFiles(deps.db, fsOpts, c.req.param('name'))),
  )

  app.get('/api/skills/:name/file', async (c) => {
    const path = requirePath(c.req.query('path'))
    const content = await readSkillFile(deps.db, fsOpts, c.req.param('name'), path)
    return c.json({ path, content })
  })

  app.put('/api/skills/:name/file', async (c) => {
    const path = requirePath(c.req.query('path'))
    const parsed = WriteSkillFileSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('skill-file-invalid', 'invalid file write payload', {
        issues: parsed.error.issues,
      })
    }
    await writeSkillFile(deps.db, fsOpts, c.req.param('name'), path, parsed.data.content)
    return c.json({ ok: true, path })
  })

  app.delete('/api/skills/:name/file', async (c) => {
    const path = requirePath(c.req.query('path'))
    await deleteSkillFile(deps.db, fsOpts, c.req.param('name'), path)
    return c.body(null, 204)
  })
}

function requirePath(p: string | undefined): string {
  if (p === undefined || p.length === 0) {
    throw new ValidationError('path-required', "'path' query parameter is required")
  }
  return p
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

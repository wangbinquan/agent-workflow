import { rimrafDir } from './helpers/cleanup'
// Service + HTTP coverage for Skills CRUD (P-1-09).
// Uses real temp filesystem (skill content lives on disk) + in-memory SQLite.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents } from '../src/db/schema'
import { createApp } from '../src/server'
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
  writeSkillContent,
  writeSkillFile,
  type SkillFsOptions,
} from '../src/services/skill'
import { ConflictError, NotFoundError, ValidationError } from '../src/util/errors'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  appHome: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-skills-'))
  // Tests need Paths.root to point at our temp dir — set env before importing
  // any module that captures it lazily (Paths uses getters, so we just need
  // it set when the route handler runs).
  const prev = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = appHome
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: join(appHome, 'config.json'),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return {
    db,
    app,
    appHome,
    cleanup: () => {
      rimrafDir(appHome)
      if (prev === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = prev
    },
  }
}

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

// =============================================================================
// Service layer
// =============================================================================

describe('skill service', () => {
  let h: Harness
  let fsOpts: SkillFsOptions

  beforeEach(() => {
    h = buildHarness()
    fsOpts = { appHome: h.appHome }
  })

  afterEach(() => h.cleanup())

  test('list empty -> []', async () => {
    expect(await listSkills(h.db)).toEqual([])
  })

  test('createManagedSkill writes SKILL.md and indexes in DB', async () => {
    const skill = await createManagedSkill(h.db, fsOpts, {
      name: 'foo',
      description: 'foo skill',
      bodyMd: '# foo\nhello',
      frontmatterExtra: { author: 'me' },
    })
    expect(skill.sourceKind).toBe('managed')
    expect(skill.managedPath).toBe('skills/foo/files')
    const skillMd = readFileSync(join(h.appHome, 'skills', 'foo', 'files', 'SKILL.md'), 'utf-8')
    expect(skillMd).toContain('name: foo')
    expect(skillMd).toContain('description: foo skill')
    expect(skillMd).toContain('author: me')
    expect(skillMd).toContain('# foo')
  })

  test('create duplicate name rejected', async () => {
    await createManagedSkill(h.db, fsOpts, {
      name: 'foo',
      description: '',
      bodyMd: '',
      frontmatterExtra: {},
    })
    await expect(
      createManagedSkill(h.db, fsOpts, {
        name: 'foo',
        description: '',
        bodyMd: '',
        frontmatterExtra: {},
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('importExternalSkill validates path existence + dir-ness', async () => {
    const ext = mkdtempSync(join(tmpdir(), 'aw-ext-'))
    try {
      writeFileSync(join(ext, 'SKILL.md'), '---\nname: ext\ndescription: e\n---\nbody')
      const skill = await importExternalSkill(h.db, {
        name: 'ext',
        externalPath: ext,
        description: 'ext desc',
      })
      expect(skill.sourceKind).toBe('external')
      expect(skill.externalPath).toBe(ext)

      // Missing path
      await expect(
        importExternalSkill(h.db, {
          name: 'missing',
          externalPath: '/no/such/dir/agent-workflow-test',
          description: '',
        }),
      ).rejects.toBeInstanceOf(ValidationError)

      // Path is a file
      const f = join(ext, 'SKILL.md')
      await expect(
        importExternalSkill(h.db, { name: 'isfile', externalPath: f, description: '' }),
      ).rejects.toBeInstanceOf(ValidationError)
    } finally {
      rimrafDir(ext)
    }
  })

  test('readSkillContent parses SKILL.md frontmatter + body', async () => {
    await createManagedSkill(h.db, fsOpts, {
      name: 'foo',
      description: 'd',
      bodyMd: 'body\n',
      frontmatterExtra: { version: 2 },
    })
    const c = await readSkillContent(h.db, fsOpts, 'foo')
    expect(c.name).toBe('foo')
    expect(c.description).toBe('d')
    expect(c.bodyMd.trim()).toBe('body')
    expect(c.frontmatterExtra).toEqual({ version: 2 })
  })

  test('writeSkillContent updates SKILL.md + DB description', async () => {
    await createManagedSkill(h.db, fsOpts, {
      name: 'foo',
      description: 'orig',
      bodyMd: 'orig body',
      frontmatterExtra: {},
    })
    const updated = await writeSkillContent(h.db, fsOpts, 'foo', {
      description: 'new',
      bodyMd: 'new body',
    })
    expect(updated.description).toBe('new')
    expect(updated.bodyMd).toBe('new body')
    const reread = await getSkill(h.db, 'foo')
    expect(reread?.description).toBe('new')
  })

  test('external skill content write rejected', async () => {
    const ext = mkdtempSync(join(tmpdir(), 'aw-ext-'))
    try {
      writeFileSync(join(ext, 'SKILL.md'), '---\nname: e\ndescription: x\n---\nbody')
      await importExternalSkill(h.db, { name: 'e', externalPath: ext, description: '' })
      await expect(
        writeSkillContent(h.db, fsOpts, 'e', { bodyMd: 'changed' }),
      ).rejects.toBeInstanceOf(ConflictError)
    } finally {
      rimrafDir(ext)
    }
  })

  test('file tree CRUD on managed skill', async () => {
    await createManagedSkill(h.db, fsOpts, {
      name: 'foo',
      description: '',
      bodyMd: '',
      frontmatterExtra: {},
    })
    await writeSkillFile(h.db, fsOpts, 'foo', 'templates/a.txt', 'aaa')
    await writeSkillFile(h.db, fsOpts, 'foo', 'templates/b.txt', 'bbb')

    const tree = await listSkillFiles(h.db, fsOpts, 'foo')
    const paths = tree.map((n) => n.path).sort()
    expect(paths).toEqual(['SKILL.md', 'templates', 'templates/a.txt', 'templates/b.txt'])

    expect(await readSkillFile(h.db, fsOpts, 'foo', 'templates/a.txt')).toBe('aaa')

    await deleteSkillFile(h.db, fsOpts, 'foo', 'templates/a.txt')
    expect(existsSync(join(h.appHome, 'skills', 'foo', 'files', 'templates', 'a.txt'))).toBe(false)

    // deleting SKILL.md is refused
    await expect(deleteSkillFile(h.db, fsOpts, 'foo', 'SKILL.md')).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  test('path traversal attempts rejected', async () => {
    await createManagedSkill(h.db, fsOpts, {
      name: 'foo',
      description: '',
      bodyMd: '',
      frontmatterExtra: {},
    })
    await expect(writeSkillFile(h.db, fsOpts, 'foo', '../escape.txt', 'x')).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(writeSkillFile(h.db, fsOpts, 'foo', '/etc/passwd', 'x')).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(readSkillFile(h.db, fsOpts, 'foo', '../../etc/hosts')).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  test('delete removes fs + DB; refuses when referenced by an agent', async () => {
    await createManagedSkill(h.db, fsOpts, {
      name: 'foo',
      description: '',
      bodyMd: '',
      frontmatterExtra: {},
    })
    const skillDir = join(h.appHome, 'skills', 'foo')
    expect(existsSync(skillDir)).toBe(true)

    // Insert agent referencing 'foo'
    await h.db.insert(agents).values({
      id: ulid(),
      name: 'a1',
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: JSON.stringify(['foo']),
      frontmatterExtra: '{}',
      bodyMd: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await expect(deleteSkill(h.db, fsOpts, 'foo')).rejects.toBeInstanceOf(ConflictError)
    expect(existsSync(skillDir)).toBe(true)

    // After removing reference, delete succeeds.
    await h.db.delete(agents).where(eq(agents.name, 'a1'))
    await deleteSkill(h.db, fsOpts, 'foo')
    expect(existsSync(skillDir)).toBe(false)
    expect(await getSkill(h.db, 'foo')).toBeNull()
  })

  test('delete unknown skill -> NotFoundError', async () => {
    await expect(deleteSkill(h.db, fsOpts, 'nope')).rejects.toBeInstanceOf(NotFoundError)
  })
})

// =============================================================================
// HTTP layer
// =============================================================================

describe('skill HTTP routes', () => {
  let h: Harness

  beforeEach(() => {
    h = buildHarness()
  })

  afterEach(() => h.cleanup())

  test('POST creates managed skill (201); GET roundtrips', async () => {
    const res = await req(h.app, '/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        name: 'foo',
        description: 'desc',
        bodyMd: 'hello',
        frontmatterExtra: { author: 'me' },
      }),
    })
    expect(res.status).toBe(201)
    const skill = (await res.json()) as { name: string; sourceKind: string }
    expect(skill.sourceKind).toBe('managed')

    const got = await req(h.app, '/api/skills/foo')
    expect(got.status).toBe(200)
    expect(((await got.json()) as { name: string }).name).toBe('foo')
  })

  test('invalid skill name returns 422', async () => {
    const res = await req(h.app, '/api/skills', {
      method: 'POST',
      body: JSON.stringify({ name: 'Bad Name!' }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('skill-invalid')
  })

  test('GET /content parses; PUT /content writes back', async () => {
    await req(h.app, '/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        name: 'foo',
        description: 'd1',
        bodyMd: 'b1',
        frontmatterExtra: { v: 1 },
      }),
    })

    const get = await req(h.app, '/api/skills/foo/content')
    expect(get.status).toBe(200)
    const content = (await get.json()) as {
      name: string
      description: string
      bodyMd: string
      frontmatterExtra: Record<string, unknown>
    }
    expect(content.description).toBe('d1')
    expect(content.bodyMd.trim()).toBe('b1')
    expect(content.frontmatterExtra).toEqual({ v: 1 })

    const put = await req(h.app, '/api/skills/foo/content', {
      method: 'PUT',
      body: JSON.stringify({ description: 'd2', bodyMd: 'b2' }),
    })
    expect(put.status).toBe(200)
    const reread = (await (await req(h.app, '/api/skills/foo/content')).json()) as {
      description: string
      bodyMd: string
    }
    expect(reread.description).toBe('d2')
    expect(reread.bodyMd).toBe('b2')
  })

  test('file CRUD via query path', async () => {
    await req(h.app, '/api/skills', {
      method: 'POST',
      body: JSON.stringify({ name: 'foo' }),
    })

    const put = await req(h.app, '/api/skills/foo/file?path=templates/a.txt', {
      method: 'PUT',
      body: JSON.stringify({ content: 'aaa' }),
    })
    expect(put.status).toBe(200)

    const tree = (await (await req(h.app, '/api/skills/foo/files')).json()) as Array<{
      path: string
    }>
    expect(tree.map((n) => n.path)).toContain('templates/a.txt')

    const get = await req(h.app, '/api/skills/foo/file?path=templates/a.txt')
    expect(get.status).toBe(200)
    expect(((await get.json()) as { content: string }).content).toBe('aaa')

    const del = await req(h.app, '/api/skills/foo/file?path=templates/a.txt', { method: 'DELETE' })
    expect(del.status).toBe(204)

    const miss = await req(h.app, '/api/skills/foo/file?path=templates/a.txt')
    expect(miss.status).toBe(404)
  })

  test('file endpoint requires ?path=', async () => {
    await req(h.app, '/api/skills', {
      method: 'POST',
      body: JSON.stringify({ name: 'foo' }),
    })
    const res = await req(h.app, '/api/skills/foo/file')
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('path-required')
  })

  test('POST /import-external accepts existing dir', async () => {
    const ext = mkdtempSync(join(tmpdir(), 'aw-ext-'))
    try {
      mkdirSync(ext, { recursive: true })
      writeFileSync(join(ext, 'SKILL.md'), '---\nname: e\ndescription: x\n---\nbody')
      const res = await req(h.app, '/api/skills/import-external', {
        method: 'POST',
        body: JSON.stringify({ name: 'e', externalPath: ext, description: 'd' }),
      })
      expect(res.status).toBe(201)
      const skill = (await res.json()) as { sourceKind: string; externalPath?: string }
      expect(skill.sourceKind).toBe('external')
      expect(skill.externalPath).toBe(ext)
    } finally {
      rimrafDir(ext)
    }
  })

  test('external skill content edit returns 409', async () => {
    const ext = mkdtempSync(join(tmpdir(), 'aw-ext-'))
    try {
      writeFileSync(join(ext, 'SKILL.md'), '---\nname: e\ndescription: x\n---\nbody')
      await req(h.app, '/api/skills/import-external', {
        method: 'POST',
        body: JSON.stringify({ name: 'e', externalPath: ext, description: '' }),
      })
      const res = await req(h.app, '/api/skills/e/content', {
        method: 'PUT',
        body: JSON.stringify({ bodyMd: 'changed' }),
      })
      expect(res.status).toBe(409)
      expect(((await res.json()) as { code: string }).code).toBe('skill-external-readonly')
    } finally {
      rimrafDir(ext)
    }
  })

  test('DELETE refuses when an agent references the skill', async () => {
    await req(h.app, '/api/skills', { method: 'POST', body: JSON.stringify({ name: 'foo' }) })
    await req(h.app, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'a1', skills: ['foo'] }),
    })
    const res = await req(h.app, '/api/skills/foo', { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('skill-in-use')
  })

  test('all /api/skills/* require token', async () => {
    expect((await h.app.request('/api/skills')).status).toBe(401)
  })
})

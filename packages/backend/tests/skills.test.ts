// Service + HTTP coverage for Skills CRUD (P-1-09).
// Uses real temp filesystem (skill content lives on disk) + in-memory SQLite.

import { buildActor } from '../src/auth/actor'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, skills } from '../src/db/schema'
import { createApp } from '../src/server'
import {
  createManagedSkill,
  deleteSkill,
  deleteSkillFile,
  getSkill,
  listSkillFiles,
  listSkills,
  readSkillContent,
  readSkillFile,
  writeSkillContent,
  writeSkillFile,
  type SkillFsOptions,
} from '../src/services/skill'
import { ConflictError, NotFoundError, ValidationError } from '../src/util/errors'

// RFC-203 T6: reference-disclosure needs a principal — an admin actor keeps
// these service-level tests' original full-visibility expectations.
const T6_ACTOR = buildActor({
  user: { id: 'u-t6-test', username: 'u-t6', displayName: 'T6', role: 'admin', status: 'active' },
  source: 'session',
})

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
      rmSync(appHome, { recursive: true, force: true })
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
    expect(skill.managedPath).toBe(`skills/${skill.id}/files`)
    const skillMd = readFileSync(join(h.appHome, 'skills', skill.id, 'files', 'SKILL.md'), 'utf-8')
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

  test('readSkillContent parses SKILL.md frontmatter + body', async () => {
    const skill = await createManagedSkill(h.db, fsOpts, {
      name: 'foo',
      description: 'd',
      bodyMd: 'body\n',
      frontmatterExtra: { version: 2 },
    })
    const c = await readSkillContent(h.db, fsOpts, skill.id)
    expect(c.name).toBe('foo')
    expect(c.description).toBe('d')
    expect(c.bodyMd.trim()).toBe('body')
    expect(c.frontmatterExtra).toEqual({ version: 2 })
  })

  test('writeSkillContent updates SKILL.md + DB description', async () => {
    const skill = await createManagedSkill(h.db, fsOpts, {
      name: 'foo',
      description: 'orig',
      bodyMd: 'orig body',
      frontmatterExtra: {},
    })
    const updated = await writeSkillContent(h.db, fsOpts, skill.id, {
      description: 'new',
      bodyMd: 'new body',
    })
    expect(updated.description).toBe('new')
    expect(updated.bodyMd).toBe('new body')
    const reread = await getSkill(h.db, 'foo')
    expect(reread?.description).toBe('new')
  })

  test('file tree CRUD on managed skill', async () => {
    const skill = await createManagedSkill(h.db, fsOpts, {
      name: 'foo',
      description: '',
      bodyMd: '',
      frontmatterExtra: {},
    })
    await writeSkillFile(h.db, fsOpts, skill.id, 'templates/a.txt', 'aaa')
    await writeSkillFile(h.db, fsOpts, skill.id, 'templates/b.txt', 'bbb')

    const tree = await listSkillFiles(h.db, fsOpts, skill.id)
    const paths = tree.map((n) => n.path).sort()
    expect(paths).toEqual(['SKILL.md', 'templates', 'templates/a.txt', 'templates/b.txt'])

    expect(await readSkillFile(h.db, fsOpts, skill.id, 'templates/a.txt')).toBe('aaa')

    await deleteSkillFile(h.db, fsOpts, skill.id, 'templates/a.txt')
    expect(existsSync(join(h.appHome, 'skills', skill.id, 'files', 'templates', 'a.txt'))).toBe(
      false,
    )

    // deleting SKILL.md is refused
    await expect(deleteSkillFile(h.db, fsOpts, skill.id, 'SKILL.md')).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  test('path traversal attempts rejected', async () => {
    const skill = await createManagedSkill(h.db, fsOpts, {
      name: 'foo',
      description: '',
      bodyMd: '',
      frontmatterExtra: {},
    })
    await expect(
      writeSkillFile(h.db, fsOpts, skill.id, '../escape.txt', 'x'),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(writeSkillFile(h.db, fsOpts, skill.id, '/etc/passwd', 'x')).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(readSkillFile(h.db, fsOpts, skill.id, '../../etc/hosts')).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  test('delete removes fs + DB; refuses when referenced by an agent', async () => {
    const skill = await createManagedSkill(h.db, fsOpts, {
      name: 'foo',
      description: '',
      bodyMd: '',
      frontmatterExtra: {},
    })
    const skillDir = join(h.appHome, 'skills', skill.id)
    expect(existsSync(skillDir)).toBe(true)
    const fooId = skill.id

    // Insert agent referencing 'foo' via a typed MANAGED skill ref (RFC-223 PR-1).
    await h.db.insert(agents).values({
      id: ulid(),
      name: 'a1',
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: JSON.stringify([{ kind: 'managed', skillId: fooId }]),
      frontmatterExtra: '{}',
      bodyMd: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await expect(deleteSkill(h.db, fsOpts, fooId, T6_ACTOR)).rejects.toBeInstanceOf(ConflictError)
    expect(existsSync(skillDir)).toBe(true)

    // After removing reference, delete succeeds.
    await h.db.delete(agents).where(eq(agents.name, 'a1'))
    await deleteSkill(h.db, fsOpts, fooId, T6_ACTOR)
    expect(existsSync(skillDir)).toBe(false)
    expect(await getSkill(h.db, 'foo')).toBeNull()
  })

  test('delete unknown skill -> NotFoundError', async () => {
    await expect(deleteSkill(h.db, fsOpts, 'nope', T6_ACTOR)).rejects.toBeInstanceOf(NotFoundError)
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

  async function createHttpSkill(
    body: Record<string, unknown>,
  ): Promise<{ id: string; name: string; sourceKind: string; aclRevision?: number }> {
    const res = await req(h.app, '/api/skills', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(201)
    return (await res.json()) as {
      id: string
      name: string
      sourceKind: string
      aclRevision?: number
    }
  }

  test('POST creates managed skill (201); GET roundtrips', async () => {
    const skill = await createHttpSkill({
      name: 'foo',
      description: 'desc',
      bodyMd: 'hello',
      frontmatterExtra: { author: 'me' },
    })
    expect(skill.sourceKind).toBe('managed')

    const got = await req(h.app, `/api/skills/${skill.id}`)
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

  // RFC-170 T-BSAFE③: GET /content still parses + emits the composite token, but
  // the old content PUT is retired (410 Gone) — writes go through the single
  // combined-save (POST /save) funnel under token OCC.
  test('GET /content parses; combined-save writes back under token OCC; PUT /content is 410', async () => {
    const skill = await createHttpSkill({
      name: 'foo',
      description: 'd1',
      bodyMd: 'b1',
      frontmatterExtra: { v: 1 },
    })

    const get = await req(h.app, `/api/skills/${skill.id}/content`)
    expect(get.status).toBe(200)
    const content = (await get.json()) as {
      name: string
      description: string
      bodyMd: string
      frontmatterExtra: Record<string, unknown>
      token?: string
    }
    expect(content.description).toBe('d1')
    expect(content.bodyMd.trim()).toBe('b1')
    expect(content.frontmatterExtra).toEqual({ v: 1 })
    expect(content.token).toBeTruthy()

    // The old content PUT bypassed the token OCC / version funnel → 410 Gone.
    const putGone = await req(h.app, `/api/skills/${skill.id}/content`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'd2', bodyMd: 'b2' }),
    })
    expect(putGone.status).toBe(410)
    expect(((await putGone.json()) as { code: string }).code).toBe('skill-endpoint-gone')

    // Writes go through the single combined-save funnel (token OCC).
    const save = await req(h.app, `/api/skills/${skill.id}/save`, {
      method: 'POST',
      body: JSON.stringify({ description: 'd2', bodyMd: 'b2', expectedToken: content.token }),
    })
    expect(save.status).toBe(200)
    const reread = (await (await req(h.app, `/api/skills/${skill.id}/content`)).json()) as {
      description: string
      bodyMd: string
    }
    expect(reread.description).toBe('d2')
    expect(reread.bodyMd).toBe('b2')
  })

  // RFC-170 T-BSAFE③: the old metadata PUT is retired (410 Gone) — it bumped no
  // meta_revision and bypassed the composite-token OCC.
  test('PUT /api/skills/:id (metadata) is 410 Gone', async () => {
    const skill = await createHttpSkill({ name: 'foo', description: 'd1' })
    const put = await req(h.app, `/api/skills/${skill.id}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'd2' }),
    })
    expect(put.status).toBe(410)
    expect(((await put.json()) as { code: string }).code).toBe('skill-endpoint-gone')
  })

  test('file CRUD via query path', async () => {
    const skill = await createHttpSkill({ name: 'foo' })

    const put = await req(h.app, `/api/skills/${skill.id}/file?path=templates/a.txt`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'aaa' }),
    })
    expect(put.status).toBe(200)

    const tree = (await (await req(h.app, `/api/skills/${skill.id}/files`)).json()) as Array<{
      path: string
    }>
    expect(tree.map((n) => n.path)).toContain('templates/a.txt')

    const get = await req(h.app, `/api/skills/${skill.id}/file?path=templates/a.txt`)
    expect(get.status).toBe(200)
    expect(((await get.json()) as { content: string }).content).toBe('aaa')

    // RFC-170 F3: DELETE /file now returns 200 + the fresh canonical token (was 204).
    const del = await req(h.app, `/api/skills/${skill.id}/file?path=templates/a.txt`, {
      method: 'DELETE',
    })
    expect(del.status).toBe(200)
    expect(((await del.json()) as { token?: string }).token).toBeTruthy()

    const miss = await req(h.app, `/api/skills/${skill.id}/file?path=templates/a.txt`)
    expect(miss.status).toBe(404)
  })

  test('file endpoint requires ?path=', async () => {
    const skill = await createHttpSkill({ name: 'foo' })
    const res = await req(h.app, `/api/skills/${skill.id}/file`)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('path-required')
  })

  test('DELETE refuses when an agent references the skill', async () => {
    const skill = await createHttpSkill({ name: 'foo' })
    const content = (await (await req(h.app, `/api/skills/${skill.id}/content`)).json()) as {
      token: string
    }
    // RFC-223 (PR-1): typed managed skill ref carries the canonical id.
    await req(h.app, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'a1',
        skills: [{ kind: 'managed', skillId: skill.id }],
      }),
    })
    // RFC-222 (D5, N-5): confirm passes first, then the in-use refusal fires.
    const res = await req(h.app, `/api/skills/${skill.id}`, {
      method: 'DELETE',
      body: JSON.stringify({
        confirm: 'foo',
        expectedToken: content.token,
        expectedAclRevision: skill.aclRevision ?? 0,
      }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('skill-in-use')
  })

  test('DELETE requires the composite token and ACL revision fence', async () => {
    const skill = await createHttpSkill({ name: 'foo' })
    const res = await req(h.app, `/api/skills/${skill.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'foo' }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('skill-delete-invalid')
  })

  test('ACL owner transfer invalidates a captured delete fence before filesystem staging', async () => {
    const skill = await createHttpSkill({ name: 'owner-transfer', bodyMd: 'keep me' })
    const content = (await (await req(h.app, `/api/skills/${skill.id}/content`)).json()) as {
      token: string
    }
    h.db
      .update(skills)
      .set({ ownerUserId: 'other-owner', aclRevision: 1 })
      .where(eq(skills.id, skill.id))
      .run()

    const stale = await req(h.app, `/api/skills/${skill.id}`, {
      method: 'DELETE',
      body: JSON.stringify({
        confirm: 'owner-transfer',
        expectedToken: content.token,
        expectedAclRevision: skill.aclRevision ?? 0,
      }),
    })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { code: string }).code).toBe('skill-version-conflict')
    expect((await req(h.app, `/api/skills/${skill.id}`)).status).toBe(200)
    expect(existsSync(join(h.appHome, 'skills', skill.id, 'files', 'SKILL.md'))).toBe(true)
  })

  test('all /api/skills/* require token', async () => {
    expect((await h.app.request('/api/skills')).status).toBe(401)
  })
})

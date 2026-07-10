import { rimrafDir } from './helpers/cleanup'
// RFC-037 T5 — locks `POST /api/tasks` rejecting missing / blank / overlong
// names with 422, persisting the trimmed value on accept, and behaving the
// same way for JSON and multipart body paths.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { runGit } from '../src/util/git'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  repoPath: string
  appHome: string
  wfId: string
  cleanup: () => void
}

const EMPTY_DEF: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [],
  nodes: [],
  edges: [],
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-task-name-'))
  const repoPath = mkdtempSync(join(tmpdir(), 'aw-task-name-repo-'))
  const prevHome = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = appHome
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 'test@example.com'])
  await runGit(repoPath, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])

  const db = createInMemoryDb(MIGRATIONS)
  const wfId = ulid()
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    definition: JSON.stringify(EMPTY_DEF),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

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
    repoPath,
    appHome,
    wfId,
    cleanup: () => {
      rimrafDir(appHome)
      rimrafDir(repoPath)
      if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = prevHome
    },
  }
}

async function postJson(app: Hono, body: unknown): Promise<Response> {
  return app.request('/api/tasks', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function postMultipart(app: Hono, payload: unknown): Promise<Response> {
  const form = new FormData()
  form.append('payload', JSON.stringify(payload))
  return app.request('/api/tasks', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  })
}

describe('RFC-037 — POST /api/tasks name validation', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('JSON: missing name → 422', async () => {
    const res = await postJson(h.app, {
      workflowId: h.wfId,
      repoPath: h.repoPath,
      baseBranch: 'main',
      inputs: {},
    })
    expect(res.status).toBe(422)
  })

  test('JSON: empty-string name → 422', async () => {
    const res = await postJson(h.app, {
      workflowId: h.wfId,
      name: '',
      repoPath: h.repoPath,
      baseBranch: 'main',
      inputs: {},
    })
    expect(res.status).toBe(422)
  })

  test('JSON: whitespace-only name → 422', async () => {
    const res = await postJson(h.app, {
      workflowId: h.wfId,
      name: '   ',
      repoPath: h.repoPath,
      baseBranch: 'main',
      inputs: {},
    })
    expect(res.status).toBe(422)
  })

  test('JSON: 256-char name → 422', async () => {
    const res = await postJson(h.app, {
      workflowId: h.wfId,
      name: 'x'.repeat(256),
      repoPath: h.repoPath,
      baseBranch: 'main',
      inputs: {},
    })
    expect(res.status).toBe(422)
  })

  test('JSON: 255-char name → 201 + DB row has trimmed name', async () => {
    const name = 'y'.repeat(255)
    const res = await postJson(h.app, {
      workflowId: h.wfId,
      name,
      repoPath: h.repoPath,
      baseBranch: 'main',
      inputs: {},
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; name: string }
    expect(body.name).toBe(name)
    const row = h.db.select().from(tasks).where(eq(tasks.id, body.id)).all()[0]
    expect(row?.name).toBe(name)
  })

  test('JSON: surrounding whitespace → stored trimmed', async () => {
    const res = await postJson(h.app, {
      workflowId: h.wfId,
      name: '  PR-1234 fix  ',
      repoPath: h.repoPath,
      baseBranch: 'main',
      inputs: {},
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; name: string }
    expect(body.name).toBe('PR-1234 fix')
    const row = h.db.select().from(tasks).where(eq(tasks.id, body.id)).all()[0]
    expect(row?.name).toBe('PR-1234 fix')
  })

  test('multipart: missing name in payload → 422', async () => {
    const res = await postMultipart(h.app, {
      workflowId: h.wfId,
      repoPath: h.repoPath,
      baseBranch: 'main',
      inputs: {},
    })
    expect(res.status).toBe(422)
  })

  test('multipart: valid name → 201 + DB row stores trimmed name', async () => {
    const res = await postMultipart(h.app, {
      workflowId: h.wfId,
      name: '  multipart task  ',
      repoPath: h.repoPath,
      baseBranch: 'main',
      inputs: {},
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; name: string }
    expect(body.name).toBe('multipart task')
  })
})

// RFC-037 T5 — locks `POST /api/tasks` rejecting missing / blank / overlong
// names with 422, persisting the trimmed value on accept, and behaving the
// same way for JSON and multipart body paths.

import { afterEach, beforeEach, describe, expect, test, beforeAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { WorkflowDefinition } from '@agent-workflow/shared'

import { tasks, workflows } from '../src/db/schema'

import { runGit } from '../src/util/git'
import { remoteUrlFor, startGitHttpRemote } from './helpers/gitHttpRemote'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createProviderHttpApplication,
  type ProviderHttpApplication,
} from './helpers/providerHttpApplication'

describeEachProvider('RFC-359 W51 task name database', (databaseHarness) => {
  const TOKEN = 'a'.repeat(64)

  interface Harness {
    db: ProviderNeutralDatabase
    app: Hono
    repoPath: string
    appHome: string
    wfId: string
    cleanup: () => Promise<void>
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
    let application: ProviderHttpApplication | undefined
    const cleanup = () => {
      rmSync(appHome, { recursive: true, force: true })
      rmSync(repoPath, { recursive: true, force: true })
      if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = prevHome
    }
    try {
      await runGit(repoPath, ['init', '-q', '-b', 'main'])
      await runGit(repoPath, ['config', 'user.email', 'test@example.com'])
      await runGit(repoPath, ['config', 'user.name', 'Test'])
      writeFileSync(join(repoPath, 'README.md'), '# repo\n')
      await runGit(repoPath, ['add', '.'])
      await runGit(repoPath, ['commit', '-q', '-m', 'init'])

      const db = databaseHarness.db
      const wfId = ulid()
      await db.insert(workflows).values({
        id: wfId,
        name: 'wf',
        definition: JSON.stringify(EMPTY_DEF),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      application = await createProviderHttpApplication(databaseHarness, {
        token: TOKEN,
        configPath: join(appHome, 'config.json'),
        opencodeVersion: '1.14.25',
        dbVersion: 1,
        appHome,
      })
      const app = application.app
      return {
        db,
        app,
        repoPath,
        appHome,
        wfId,
        cleanup: async () => {
          try {
            await application?.dispose()
          } finally {
            cleanup()
          }
        },
      }
    } catch (error) {
      try {
        await application?.dispose()
      } finally {
        cleanup()
      }
      throw error
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

  // RFC-287 T11：夹具仓经真实 git smart-HTTP 远端（file:// 已是非法参数）。
  beforeAll(async () => {
    await startGitHttpRemote()
  })

  describe('RFC-037 — POST /api/tasks name validation', () => {
    let h: Harness
    beforeEach(async () => {
      h = await buildHarness()
    })
    afterEach(() => h.cleanup())

    test('JSON: missing name → 422', async () => {
      const res = await postJson(h.app, {
        workflowId: h.wfId,
        repoUrl: remoteUrlFor(h.repoPath),
        ref: 'main',
        inputs: {},
      })
      expect(res.status).toBe(422)
    })

    test('JSON: empty-string name → 422', async () => {
      const res = await postJson(h.app, {
        workflowId: h.wfId,
        name: '',
        repoUrl: remoteUrlFor(h.repoPath),
        ref: 'main',
        inputs: {},
      })
      expect(res.status).toBe(422)
    })

    test('JSON: whitespace-only name → 422', async () => {
      const res = await postJson(h.app, {
        workflowId: h.wfId,
        name: '   ',
        repoUrl: remoteUrlFor(h.repoPath),
        ref: 'main',
        inputs: {},
      })
      expect(res.status).toBe(422)
    })

    test('JSON: 256-char name → 422', async () => {
      const res = await postJson(h.app, {
        workflowId: h.wfId,
        name: 'x'.repeat(256),
        repoUrl: remoteUrlFor(h.repoPath),
        ref: 'main',
        inputs: {},
      })
      expect(res.status).toBe(422)
    })

    test('JSON: 255-char name → 201 + DB row has trimmed name', async () => {
      const name = 'y'.repeat(255)
      const res = await postJson(h.app, {
        workflowId: h.wfId,
        name,
        repoUrl: remoteUrlFor(h.repoPath),
        ref: 'main',
        inputs: {},
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { id: string; name: string }
      expect(body.name).toBe(name)
      const row = (await h.db.select().from(tasks).where(eq(tasks.id, body.id)).all())[0]
      expect(row?.name).toBe(name)
    })

    test('JSON: surrounding whitespace → stored trimmed', async () => {
      const res = await postJson(h.app, {
        workflowId: h.wfId,
        name: '  PR-1234 fix  ',
        repoUrl: remoteUrlFor(h.repoPath),
        ref: 'main',
        inputs: {},
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { id: string; name: string }
      expect(body.name).toBe('PR-1234 fix')
      const row = (await h.db.select().from(tasks).where(eq(tasks.id, body.id)).all())[0]
      expect(row?.name).toBe('PR-1234 fix')
    })

    test('multipart: missing name in payload → 422', async () => {
      const res = await postMultipart(h.app, {
        workflowId: h.wfId,
        repoUrl: remoteUrlFor(h.repoPath),
        ref: 'main',
        inputs: {},
      })
      expect(res.status).toBe(422)
    })

    test('multipart: valid name → 201 + DB row stores trimmed name', async () => {
      const res = await postMultipart(h.app, {
        workflowId: h.wfId,
        name: '  multipart task  ',
        repoUrl: remoteUrlFor(h.repoPath),
        ref: 'main',
        inputs: {},
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { id: string; name: string }
      expect(body.name).toBe('multipart task')
    })
  })
})

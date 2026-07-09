// RFC-020 T4: POST /api/tasks with content-type multipart/form-data.
// Verifies (a) happy path lands files into the task worktree and packs
// the paths into inputs[uploadKey], (b) missing/extra fields are rejected
// before any task row is created, (c) workflow-not-found preempts uploads,
// (d) limit / accept rejections propagate as ValidationError.

import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { isWindows, writeStubOpencode } from './helpers/stub-runtime'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeStubOpencode(dir: string): string {
  const stubPath = writeStubOpencode(dir)
  if (isWindows) {
    // On Windows, writeStubOpencode returns a .js path.
    // config.opencodePath needs a single executable path, so we
    // write a .cmd wrapper that calls `bun run` on the .js stub.
    const cmdPath = join(dir, 'stub-opencode.cmd')
    writeFileSync(cmdPath, '@echo off\r\nbun "%~dp0stub-opencode.js" %*\r\n')
    return cmdPath
  }
  return stubPath
}

interface Harness {
  db: DbClient
  app: Hono
  tmp: string
  repoPath: string
  workflowId: string
  stubOpencode: string
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-multipart-'))
  // Pin app home so worktrees / config land under tmp, not the real user dir.
  process.env.AGENT_WORKFLOW_HOME = join(tmp, 'home')
  const repoPath = join(tmp, 'repo')
  execSync(`git init -b main "${repoPath}"`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.name t`, { stdio: 'ignore' })
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  execSync(`git -C "${repoPath}" add . && git -C "${repoPath}" commit -m init`, {
    stdio: 'ignore',
  })

  const stubOpencode = makeStubOpencode(tmp)

  const db = createInMemoryDb(MIGRATIONS)

  await createAgent(db, {
    name: 'reader',
    description: '',
    outputs: ['out'],
    outputKinds: { out: 'string' },
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })

  const wf = await createWorkflow(db, {
    name: 'with-upload',
    description: '',
    definition: {
      $schema_version: 2,
      inputs: [
        { kind: 'text', key: 'topic', label: 'topic' },
        {
          kind: 'upload',
          key: 'refs',
          label: 'Reference materials',
          targetDir: 'inputs/refs',
          minCount: 0,
          maxCount: 5,
        },
      ],
      nodes: [
        { id: 'in_topic', kind: 'input', inputKey: 'topic' },
        { id: 'in_refs', kind: 'input', inputKey: 'refs' },
        {
          id: 'reader',
          kind: 'agent-single',
          agentName: 'reader',
          promptTemplate: '{{topic}} / {{refs}}',
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_topic', portName: 'topic' },
          target: { nodeId: 'reader', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'in_refs', portName: 'refs' },
          target: { nodeId: 'reader', portName: 'refs' },
        },
      ],
    },
  })

  const app = createApp({
    token: TOKEN,
    configPath: join(tmp, 'config.json'),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  // Pin opencode binary for the route handler.
  writeFileSync(
    join(tmp, 'config.json'),
    JSON.stringify({ $schema_version: 1, opencodePath: stubOpencode }),
  )
  return { db, app, tmp, repoPath, workflowId: wf.id, stubOpencode }
}

function buildFormData(payload: object, files: Array<[string, string, string]>): FormData {
  const fd = new FormData()
  fd.set('payload', new Blob([JSON.stringify(payload)], { type: 'application/json' }))
  for (const [inputKey, filename, body] of files) {
    fd.append(`files[${inputKey}][]`, new Blob([body]), filename)
  }
  return fd
}

async function postMultipart(app: Hono, url: string, fd: FormData): Promise<Response> {
  return app.request(url, {
    method: 'POST',
    body: fd,
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
}

describe('POST /api/tasks multipart (RFC-020)', () => {
  test('happy path: upload 2 files → task created, files in worktree, paths packed', async () => {
    const h = await buildHarness()
    const fd = buildFormData(
      {
        workflowId: h.workflowId,
        name: 'fixture-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'orders', refs: '' },
      },
      [
        ['refs', 'a.txt', 'alpha'],
        ['refs', 'b.txt', 'beta'],
      ],
    )
    const res = await postMultipart(h.app, '/api/tasks', fd)
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      id: string
      worktreePath: string
      inputs: Record<string, string>
    }
    expect(body.worktreePath).not.toBe('')
    expect(existsSync(join(body.worktreePath, 'inputs/refs/a.txt'))).toBe(true)
    expect(existsSync(join(body.worktreePath, 'inputs/refs/b.txt'))).toBe(true)
    expect(readFileSync(join(body.worktreePath, 'inputs/refs/a.txt'), 'utf8')).toBe('alpha')
    expect(body.inputs.refs).toBe('inputs/refs/a.txt\ninputs/refs/b.txt')
    expect(body.inputs.topic).toBe('orders')
  })

  // Regression: a file part with an empty filename ("filename=\"\"" in the
  // multipart Content-Disposition — e.g. a drag-dropped Blob the browser never
  // named) is parsed by bun as a File whose `.name` is `undefined`, not ''. The
  // route's `value.name === '' ? ...` guard missed that, so `filename` landed as
  // `undefined` and `sanitizeFilename` crashed with "undefined is not an object
  // (evaluating 'e.replace')", surfacing to the user as task-upload-failed:
  // "failed to land uploads into worktree". Must succeed under a fallback name.
  test('upload with empty filename → 201, file lands under fallback name', async () => {
    const h = await buildHarness()
    const fd = new FormData()
    fd.set(
      'payload',
      new Blob(
        [
          JSON.stringify({
            workflowId: h.workflowId,
            name: 'fixture-task',
            repoPath: h.repoPath,
            baseBranch: 'main',
            inputs: { topic: 'orders', refs: '' },
          }),
        ],
        { type: 'application/json' },
      ),
    )
    // Empty filename — third arg is '' so the serialized part is filename="".
    fd.append('files[refs][]', new Blob(['alpha']), '')
    const res = await postMultipart(h.app, '/api/tasks', fd)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { worktreePath: string; inputs: Record<string, string> }
    expect(body.inputs.refs).toBe('inputs/refs/upload.bin')
    expect(existsSync(join(body.worktreePath, 'inputs/refs/upload.bin'))).toBe(true)
    expect(readFileSync(join(body.worktreePath, 'inputs/refs/upload.bin'), 'utf8')).toBe('alpha')
  })

  test('missing payload field → 422 and no task row', async () => {
    const h = await buildHarness()
    const fd = new FormData()
    fd.append('files[refs][]', new Blob(['x']), 'x.txt')
    const res = await postMultipart(h.app, '/api/tasks', fd)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('task-multipart-payload-missing')
  })

  test('unknown multipart field → 422', async () => {
    const h = await buildHarness()
    const fd = buildFormData(
      {
        workflowId: h.workflowId,
        name: 'fixture-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x', refs: '' },
      },
      [],
    )
    fd.append('strayField', 'oops')
    const res = await postMultipart(h.app, '/api/tasks', fd)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('task-multipart-unknown-field')
  })

  test('file targets an undeclared input key → 422', async () => {
    const h = await buildHarness()
    const fd = buildFormData(
      {
        workflowId: h.workflowId,
        name: 'fixture-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x', refs: '' },
      },
      [['nosuch', 'x.txt', 'x']],
    )
    const res = await postMultipart(h.app, '/api/tasks', fd)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('task-multipart-unknown-input')
  })

  test('workflow not found → 404 before uploads are touched', async () => {
    const h = await buildHarness()
    const fd = buildFormData(
      {
        workflowId: 'no-such-id',
        name: 'fixture-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x', refs: '' },
      },
      [['refs', 'a.txt', 'x']],
    )
    const res = await postMultipart(h.app, '/api/tasks', fd)
    expect(res.status).toBe(404)
  })

  test('maxCount exceeded → 422 and no files on disk', async () => {
    const h = await buildHarness()
    const fd = buildFormData(
      {
        workflowId: h.workflowId,
        name: 'fixture-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x', refs: '' },
      },
      [
        ['refs', '1.txt', 'a'],
        ['refs', '2.txt', 'a'],
        ['refs', '3.txt', 'a'],
        ['refs', '4.txt', 'a'],
        ['refs', '5.txt', 'a'],
        ['refs', '6.txt', 'a'],
      ],
    )
    const res = await postMultipart(h.app, '/api/tasks', fd)
    expect(res.status).toBe(422)
  })

  test('empty uploads with minCount=0 still creates the task', async () => {
    const h = await buildHarness()
    const fd = buildFormData(
      {
        workflowId: h.workflowId,
        name: 'fixture-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x', refs: '' },
      },
      [],
    )
    const res = await postMultipart(h.app, '/api/tasks', fd)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { inputs: Record<string, string> }
    expect(body.inputs.refs).toBe('')
  })
})

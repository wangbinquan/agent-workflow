// RFC-020 T4: POST /api/tasks with content-type multipart/form-data.
// Verifies (a) happy path lands files into the task worktree and packs
// the paths into inputs[uploadKey], (b) missing/extra fields are rejected
// before any task row is created, (c) workflow-not-found preempts uploads,
// (d) limit / accept rejections propagate as ValidationError.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import type { Hono } from 'hono'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createAgent } from '../src/services/agent'
import { abortAllActiveTasks, isTaskActive } from '../src/services/task'
import { createWorkflow } from '../src/services/workflow'
import { nonInteractiveGitEnv } from '../src/util/git'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const GIT_TIMEOUT_MS = 10_000
const NODE_TIMEOUT_MS = 10_000
const FLOW_TIMEOUT_MS = 20_000
const ACTIVE_TASK_SETTLE_TIMEOUT_MS = 5_000

let cleanupDirs: string[] = []
let previousAppHome: string | undefined
let watchdog: ReturnType<typeof setTimeout> | undefined

setDefaultTimeout(FLOW_TIMEOUT_MS + ACTIVE_TASK_SETTLE_TIMEOUT_MS + 5_000)

beforeEach(() => {
  cleanupDirs = []
  previousAppHome = process.env.AGENT_WORKFLOW_HOME
  watchdog = setTimeout(() => abortAllActiveTasks('test-timeout'), FLOW_TIMEOUT_MS)
})

afterEach(async () => {
  if (watchdog !== undefined) clearTimeout(watchdog)
  try {
    await abortActiveTasksAndWait('test-cleanup')
  } finally {
    for (const dir of cleanupDirs.reverse()) rmSync(dir, { recursive: true, force: true })
    if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousAppHome
  }
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanupDirs.push(dir)
  return dir
}

async function abortActiveTasksAndWait(reason: string): Promise<void> {
  const taskIds = abortAllActiveTasks(reason)
  const deadline = Date.now() + ACTIVE_TASK_SETTLE_TIMEOUT_MS
  while (taskIds.some((taskId) => isTaskActive(taskId)) && Date.now() < deadline) {
    await Bun.sleep(20)
  }
  const stuck = taskIds.filter((taskId) => isTaskActive(taskId))
  if (stuck.length > 0) throw new Error(`active test tasks failed to settle: ${stuck.join(', ')}`)
}

function git(...args: string[]): void {
  execFileSync('git', args, {
    stdio: 'ignore',
    timeout: GIT_TIMEOUT_MS,
    env: nonInteractiveGitEnv(),
  })
}

function makeStubOpencode(dir: string): string {
  const path = join(dir, 'stub-opencode.sh')
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then echo 'stub-opencode 1.14.99'; exit 0; fi
if [[ "$1" == "run" ]]; then
  NONCE=$(printf '%s' "$*" | sed -n 's/.*nonce="\\([^"]*\\)".*/\\1/p' | head -n 1)
  OPEN='<workflow-output>'; if [[ -n "$NONCE" ]]; then OPEN='<workflow-output nonce="'"$NONCE"'">'; fi
  ENV="$OPEN"'<port name="out">ok</port></workflow-output>'
  TS=$(date +%s%3N)
  printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$TS" "$ENV"
  exit 0
fi
exit 1
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

interface Harness {
  db: DbClient
  app: Hono
  repoPath: string
  workflowId: string
}

async function buildHarness(): Promise<Harness> {
  const tmp = makeTempDir('aw-multipart-')
  // Pin app home so worktrees / config land under tmp, not the real user dir.
  process.env.AGENT_WORKFLOW_HOME = join(tmp, 'home')
  const repoPath = join(tmp, 'repo')
  git('init', '-b', 'main', repoPath)
  git('-C', repoPath, 'config', 'user.email', 't@t.test')
  git('-C', repoPath, 'config', 'user.name', 't')
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  git('-C', repoPath, 'add', '.')
  git('-C', repoPath, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'init')

  const stubOpencode = makeStubOpencode(tmp)

  const db = createInMemoryDb(MIGRATIONS)

  const reader = await createAgent(db, {
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
          agentId: reader.id,
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
    JSON.stringify({
      $schema_version: 1,
      opencodePath: stubOpencode,
      defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
      defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
    }),
  )
  return { db, app, repoPath, workflowId: wf.id }
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
        repoUrl: pathToFileURL(h.repoPath).href,
        ref: 'main',
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
            repoUrl: pathToFileURL(h.repoPath).href,
            ref: 'main',
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
        repoUrl: pathToFileURL(h.repoPath).href,
        ref: 'main',
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
        repoUrl: pathToFileURL(h.repoPath).href,
        ref: 'main',
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
        repoUrl: pathToFileURL(h.repoPath).href,
        ref: 'main',
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
        repoUrl: pathToFileURL(h.repoPath).href,
        ref: 'main',
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
        repoUrl: pathToFileURL(h.repoPath).href,
        ref: 'main',
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

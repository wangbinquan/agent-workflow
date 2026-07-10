import { rimrafDir } from './helpers/cleanup'
// RFC-107 — URL-mode launches may now carry multipart file uploads.
//
// Before RFC-107 the multipart route refused any `repoUrl` body with
// `multipart-upload-requires-path-mode` ("URL launches are JSON-only"), because
// it materialized the worktree from a LOCAL repoPath before startTask and a URL
// repo isn't on disk at that point. RFC-107 resolves the URL into the
// gitRepoCache (reusing `resolveRepoSourceSingle`) BEFORE materializing, threads
// the resolved source into startTask via `preResolvedSource` (resolve exactly
// once), validates the workflow before cloning, and threads the working branch.
//
// These lock the four Codex design-gate findings folded into the RFC:
//   F1 — static validation runs BEFORE any clone (invalid workflow never clones)
//   F2 — workingBranch / git identity are threaded into the worktree
//   F3 — the URL is resolved exactly once (success + failure handoff)
//   F4 — a credentialed URL is persisted redacted (no cleartext in DB)
// plus the core lift (URL + upload succeeds) and the regression guards.
//
// All git is offline via a `file://` bare repo (mirrors start-task-url.test.ts);
// no `RUN_GIT_NETWORK` dependency.

import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { execSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos, tasks as tasksTable } from '../src/db/schema'
import { createApp } from '../src/server'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { materializeWorktree, startTask } from '../src/services/task'
import { isWindows, stubCmd } from './helpers/stub-runtime'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeStubOpencode(dir: string): string {
  if (isWindows) {
    const path = join(dir, 'stub-opencode.js')
    const js = `const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write(${JSON.stringify('stub-opencode 1.14.99\n')}); process.exit(0) }
if (args[0] === 'run') {
  const env = '<workflow-output><port name="out">ok</port></workflow-output>'
  process.stdout.write(JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: env } }) + '\\n')
  process.exit(0)
}
process.exit(1)
`
    writeFileSync(path, js)
    // .cmd wrapper so opencodePath can point to a directly executable file
    writeFileSync(join(dir, 'stub-opencode.cmd'), `@echo off\r\nbun "${path}" %*\r\n`)
    return path
  }
  const path = join(dir, 'stub-opencode.sh')
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then echo 'stub-opencode 1.14.99'; exit 0; fi
if [[ "$1" == "run" ]]; then
  ENV='<workflow-output><port name="out">ok</port></workflow-output>'
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

/** A bare repo we can clone via file:// — offline, fast, deterministic. */
function makeBareRepo(tmp: string): string {
  const working = join(tmp, 'src')
  mkdirSync(working, { recursive: true })
  execSync(`git init -b main "${working}"`, { stdio: 'ignore' })
  execSync(`git -C "${working}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${working}" config user.name t`, { stdio: 'ignore' })
  writeFileSync(join(working, 'README.md'), '# repo\n')
  execSync(`git -C "${working}" add . && git -C "${working}" commit -m init`, { stdio: 'ignore' })
  const bare = join(tmp, 'remote.git')
  execSync(`git clone --bare "${working}" "${bare}"`, { stdio: 'ignore' })
  return bare
}

const UPLOAD_WF_INPUTS = [
  { kind: 'text', key: 'topic', label: 'topic' },
  {
    kind: 'upload',
    key: 'refs',
    label: 'Reference materials',
    targetDir: 'inputs/refs',
    minCount: 0,
    maxCount: 5,
  },
] as const

interface Harness {
  db: DbClient
  app: Hono
  tmp: string
  bareUrl: string
  localRepo: string
  validWorkflowId: string
  invalidWorkflowId: string
  stubOpencode: string
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc107-'))
  process.env.AGENT_WORKFLOW_HOME = join(tmp, 'home')
  const bare = makeBareRepo(tmp)
  const bareUrl = isWindows ? pathToFileURL(bare).href : `file://${bare}`

  // A local clone usable as a path-mode repo for the path+workingBranch regression.
  const localRepo = join(tmp, 'local')
  execSync(`git clone "${bare}" "${localRepo}"`, { stdio: 'ignore' })

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

  const valid = await createWorkflow(db, {
    name: 'with-upload',
    description: '',
    definition: {
      $schema_version: 2,
      inputs: UPLOAD_WF_INPUTS as never,
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
    } as never,
  })

  // Invalid-but-saveable workflow (validation is a LAUNCH gate, not a save gate):
  // an agent node referencing an agent that does not exist → `agent-not-found`.
  // Still carries an upload input so it reaches the multipart path.
  const invalid = await createWorkflow(db, {
    name: 'with-upload-invalid',
    description: '',
    definition: {
      $schema_version: 2,
      inputs: UPLOAD_WF_INPUTS as never,
      nodes: [
        { id: 'in_topic', kind: 'input', inputKey: 'topic' },
        { id: 'in_refs', kind: 'input', inputKey: 'refs' },
        {
          id: 'ghost',
          kind: 'agent-single',
          agentName: 'no-such-agent',
          promptTemplate: '{{topic}}',
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_topic', portName: 'topic' },
          target: { nodeId: 'ghost', portName: 'topic' },
        },
      ],
    } as never,
  })

  const app = createApp({
    token: TOKEN,
    configPath: join(tmp, 'config.json'),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  writeFileSync(
    join(tmp, 'config.json'),
    JSON.stringify({
      $schema_version: 1,
      opencodePath: isWindows ? join(tmp, 'stub-opencode.cmd') : stubOpencode,
    }),
  )
  return {
    db,
    app,
    tmp,
    bareUrl,
    localRepo,
    validWorkflowId: valid.id,
    invalidWorkflowId: invalid.id,
    stubOpencode,
  }
}

function buildFormData(payload: object, files: Array<[string, string, string]>): FormData {
  const fd = new FormData()
  fd.set('payload', new Blob([JSON.stringify(payload)], { type: 'application/json' }))
  for (const [inputKey, filename, body] of files) {
    fd.append(`files[${inputKey}][]`, new Blob([body]), filename)
  }
  return fd
}

async function postMultipart(app: Hono, fd: FormData): Promise<Response> {
  return app.request('/api/tasks', {
    method: 'POST',
    body: fd,
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
}

describe('RFC-107 — URL launch + multipart upload', () => {
  test('CORE: url + upload → 201 (not 422), files land in worktree, paths packed, repoUrl preserved', async () => {
    const h = await buildHarness()
    const fd = buildFormData(
      {
        workflowId: h.validWorkflowId,
        name: 'url-upload',
        repoUrl: h.bareUrl,
        inputs: { topic: 'orders', refs: '' },
      },
      [
        ['refs', 'a.txt', 'alpha'],
        ['refs', 'b.txt', 'beta'],
      ],
    )
    const res = await postMultipart(h.app, fd)
    // The old behavior was a 422 multipart-upload-requires-path-mode.
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      worktreePath: string
      inputs: Record<string, string>
      repoUrl: string | null
    }
    expect(body.worktreePath).not.toBe('')
    // The worktree was built from the CACHED clone of the URL.
    expect(existsSync(join(body.worktreePath, 'inputs/refs/a.txt'))).toBe(true)
    expect(readFileSync(join(body.worktreePath, 'inputs/refs/a.txt'), 'utf8')).toBe('alpha')
    expect(body.inputs.refs).toBe('inputs/refs/a.txt\ninputs/refs/b.txt')
    // Provenance: the URL is preserved (file:// has no credentials → redaction is a no-op).
    expect(body.repoUrl).toBe(h.bareUrl)
    // Exactly one cache row was minted (resolved once).
    expect(h.db.select().from(cachedRepos).all().length).toBe(1)
    rimrafDir(h.tmp)
  })

  test('F1: invalid workflow + url upload → workflow-invalid BEFORE any clone (no cache row, no task)', async () => {
    const h = await buildHarness()
    const fd = buildFormData(
      {
        workflowId: h.invalidWorkflowId,
        name: 'invalid-url-upload',
        repoUrl: h.bareUrl,
        inputs: { topic: 'x', refs: '' },
      },
      [['refs', 'a.txt', 'alpha']],
    )
    const res = await postMultipart(h.app, fd)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('workflow-invalid')
    // The decisive assertion: validation ran BEFORE resolve/clone, so the repo
    // cache was never touched and no task row exists.
    expect(h.db.select().from(cachedRepos).all().length).toBe(0)
    expect(h.db.select().from(tasksTable).all().length).toBe(0)
    rimrafDir(h.tmp)
  })

  test('F3 (parity): a bad ref on a url upload → structured error, no task row', async () => {
    const h = await buildHarness()
    const fd = buildFormData(
      {
        workflowId: h.validWorkflowId,
        name: 'bad-ref',
        repoUrl: h.bareUrl,
        ref: 'no-such-branch',
        inputs: { topic: 'x', refs: '' },
      },
      [['refs', 'a.txt', 'alpha']],
    )
    const res = await postMultipart(h.app, fd)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    // No half-created task.
    expect(h.db.select().from(tasksTable).all().length).toBe(0)
    rimrafDir(h.tmp)
  })

  test('Codex impl-gate: url + INVALID upload (maxCount) rejected BEFORE clone — no cache row, no task', async () => {
    const h = await buildHarness()
    // The `refs` input declares maxCount: 5; sending 6 trips `upload-max-count`.
    // RFC-107 must reject this BEFORE resolving/cloning the URL, otherwise a bad
    // upload would clone the repo + leave an orphan worktree.
    const fd = buildFormData(
      {
        workflowId: h.validWorkflowId,
        name: 'url-bad-upload',
        repoUrl: h.bareUrl,
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
    const res = await postMultipart(h.app, fd)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('upload-max-count')
    // Decisive: the upload was rejected before the repo was resolved/cloned.
    expect(h.db.select().from(cachedRepos).all().length).toBe(0)
    expect(h.db.select().from(tasksTable).all().length).toBe(0)
    rimrafDir(h.tmp)
  })

  test('F2: url + upload + workingBranch → worktree is actually on that branch', async () => {
    const h = await buildHarness()
    const fd = buildFormData(
      {
        workflowId: h.validWorkflowId,
        name: 'url-upload-wb',
        repoUrl: h.bareUrl,
        workingBranch: 'feature/rfc107',
        inputs: { topic: 'x', refs: '' },
      },
      [['refs', 'a.txt', 'alpha']],
    )
    const res = await postMultipart(h.app, fd)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { worktreePath: string }
    const branch = execSync(`git -C "${body.worktreePath}" rev-parse --abbrev-ref HEAD`)
      .toString()
      .trim()
    expect(branch).toBe('feature/rfc107')
    rimrafDir(h.tmp)
  })

  test('F2 (path regression): path + upload + workingBranch also checks out the branch', async () => {
    const h = await buildHarness()
    const fd = buildFormData(
      {
        workflowId: h.validWorkflowId,
        name: 'path-upload-wb',
        repoPath: h.localRepo,
        baseBranch: 'main',
        workingBranch: 'feature/path-wb',
        inputs: { topic: 'x', refs: '' },
      },
      [['refs', 'a.txt', 'alpha']],
    )
    const res = await postMultipart(h.app, fd)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { worktreePath: string }
    const branch = execSync(`git -C "${body.worktreePath}" rev-parse --abbrev-ref HEAD`)
      .toString()
      .trim()
    expect(branch).toBe('feature/path-wb')
    rimrafDir(h.tmp)
  })

  test('REGRESSION: multi-repo + upload still rejected (multi-repo-upload-unsupported)', async () => {
    const h = await buildHarness()
    const fd = buildFormData(
      {
        workflowId: h.validWorkflowId,
        name: 'multi-upload',
        repos: [{ repoUrl: h.bareUrl }, { repoUrl: h.bareUrl }],
        inputs: { topic: 'x', refs: '' },
      },
      [['refs', 'a.txt', 'alpha']],
    )
    const res = await postMultipart(h.app, fd)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('multi-repo-upload-unsupported')
    rimrafDir(h.tmp)
  })
})

// ---------------------------------------------------------------------------
// Codex impl-gate (pass 2) — RFC-107 opened URL+upload to arbitrary remote
// repos, so a repo that commits its `targetDir` (or an ancestor) as a symlink
// pointing outside the worktree could make the upload land outside it under
// daemon permissions. applyUploadsToWorktree's lexical containment is not
// enough; the realpath guard must reject it. Before RFC-107 this was
// unreachable via URL+multipart (URL uploads were refused outright).
// ---------------------------------------------------------------------------
describe('RFC-107 — security: a cloned repo cannot make uploads escape the worktree', () => {
  // App + workflow setup shared by the escape cases; only the (malicious) repo
  // differs. Returns the live Hono app + the upload workflow id.
  async function buildUploadApp(tmp: string): Promise<{ db: DbClient; app: Hono; wfId: string }> {
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
        inputs: UPLOAD_WF_INPUTS as never,
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
      } as never,
    })
    const app = createApp({
      token: TOKEN,
      configPath: join(tmp, 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    writeFileSync(
      join(tmp, 'config.json'),
      JSON.stringify({
        $schema_version: 1,
        opencodePath: isWindows ? join(tmp, 'stub-opencode.cmd') : stubOpencode,
      }),
    )
    return { db, app, wfId: wf.id }
  }

  function commitBareRepo(working: string, bare: string): void {
    execSync(`git -C "${working}" init -b main`, { stdio: 'ignore' })
    execSync(`git -C "${working}" config user.email t@t.test`, { stdio: 'ignore' })
    execSync(`git -C "${working}" config user.name t`, { stdio: 'ignore' })
    writeFileSync(join(working, 'README.md'), '# r\n')
    execSync(`git -C "${working}" add -A && git -C "${working}" commit -m init`, {
      stdio: 'ignore',
    })
    execSync(`git clone --bare "${working}" "${bare}"`, { stdio: 'ignore' })
  }

  // Codex impl-gate (pass 2): an ANCESTOR of targetDir is a symlink escaping the
  // worktree. The realpath dir-guard must reject before any write.
  test('committed `inputs/` ancestor symlink → rejected (path-traversal), nothing written outside', async () => {
    if (isWindows) return // symlink requires developer mode on Windows; security guarantee tested in platform-fs.test.ts
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc107-sym-'))
    process.env.AGENT_WORKFLOW_HOME = join(tmp, 'home')
    const evil = join(tmp, 'evil')
    mkdirSync(evil, { recursive: true })
    const working = join(tmp, 'src')
    mkdirSync(working, { recursive: true })
    // `inputs` is a symlink to evil; targetDir `inputs/refs` → `evil/refs`.
    symlinkSync(evil, join(working, 'inputs'))
    const bare = join(tmp, 'remote.git')
    commitBareRepo(working, bare)

    const { app, wfId } = await buildUploadApp(tmp)
    const fd = buildFormData(
      {
        workflowId: wfId,
        name: 'evil-upload',
        repoUrl: isWindows ? pathToFileURL(bare).href : `file://${bare}`,
        inputs: { topic: 'x', refs: '' },
      },
      [['refs', 'pwn.txt', 'pwned']],
    )
    const res = await postMultipart(app, fd)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('path-traversal')
    // Decisive: nothing was written into the attacker directory.
    expect(existsSync(join(evil, 'refs'))).toBe(false)
    rimrafDir(tmp)
  })

  // Codex impl-gate (pass 3): the LEAF is a dangling symlink named like the
  // uploaded file, inside a REAL targetDir. The dir-guard passes; the writer must
  // not follow the leaf symlink (lstat-collision rename + O_EXCL).
  test('committed leaf symlink `inputs/refs/<name>` (dangling) → write does not follow it outside', async () => {
    if (isWindows) return // symlink requires developer mode on Windows; security guarantee tested in platform-fs.test.ts
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc107-leaf-'))
    process.env.AGENT_WORKFLOW_HOME = join(tmp, 'home')
    const outsideTarget = join(tmp, 'pwned-leaf') // does NOT exist (dangling link)
    const working = join(tmp, 'src')
    mkdirSync(join(working, 'inputs', 'refs'), { recursive: true })
    symlinkSync(outsideTarget, join(working, 'inputs', 'refs', 'pwn.txt'))
    const bare = join(tmp, 'remote.git')
    commitBareRepo(working, bare)

    const { app, wfId } = await buildUploadApp(tmp)
    const fd = buildFormData(
      {
        workflowId: wfId,
        name: 'leaf-evil',
        repoUrl: isWindows ? pathToFileURL(bare).href : `file://${bare}`,
        inputs: { topic: 'x', refs: '' },
      },
      [['refs', 'pwn.txt', 'pwned']],
    )
    const res = await postMultipart(app, fd)
    // Never a 5xx / escape; the writer renames around the leaf symlink.
    expect(res.status).toBeLessThan(500)
    // Decisive: the dangling symlink's outside target was NOT created through it.
    expect(existsSync(outsideTarget)).toBe(false)
    rimrafDir(tmp)
  })
})

// ---------------------------------------------------------------------------
// Unit: startTask honors `preResolvedSource` — the URL is resolved EXACTLY ONCE
// (F3) and a credentialed URL is persisted redacted (F4). Both are proven via a
// BOGUS/credentialed URL that would FAIL if startTask tried to clone it: because
// preResolvedSource short-circuits resolution, the launch succeeds and never
// touches the network.
// ---------------------------------------------------------------------------
describe('RFC-107 — startTask preResolvedSource (resolve-once + redaction)', () => {
  async function unitSetup() {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc107-unit-'))
    const appHome = join(tmp, 'home')
    mkdirSync(appHome, { recursive: true })
    process.env.AGENT_WORKFLOW_HOME = appHome
    const db = createInMemoryDb(MIGRATIONS)

    const realRepo = join(tmp, 'real')
    mkdirSync(realRepo, { recursive: true })
    execSync(`git init -b main "${realRepo}"`, { stdio: 'ignore' })
    execSync(`git -C "${realRepo}" config user.email t@t.test`, { stdio: 'ignore' })
    execSync(`git -C "${realRepo}" config user.name t`, { stdio: 'ignore' })
    writeFileSync(join(realRepo, 'README.md'), '# r\n')
    execSync(`git -C "${realRepo}" add . && git -C "${realRepo}" commit -m init`, {
      stdio: 'ignore',
    })

    const stubOpencode = makeStubOpencode(tmp)
    await createAgent(db, {
      name: 'echoer',
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
      name: 'trivial',
      description: '',
      definition: {
        $schema_version: 2,
        inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic' },
          { id: 'echoer', kind: 'agent-single', agentName: 'echoer', promptTemplate: '{{topic}}' },
        ],
        edges: [
          {
            id: 'e1',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'echoer', portName: 'topic' },
          },
        ],
      } as never,
    })
    return { tmp, appHome, db, realRepo, stubOpencode, wf }
  }

  test('credentialed URL never cloned (resolve-once) and persisted redacted (F3 + F4)', async () => {
    const { tmp, appHome, db, realRepo, stubOpencode, wf } = await unitSetup()
    const taskId = 'task-rfc107-unit'
    // A real worktree built from the real repo so the scheduler can run.
    const wt = await materializeWorktree({
      repoPath: realRepo,
      baseBranch: 'main',
      taskId,
      appHome,
    })
    expect(wt.earlyError).toBeNull()

    // This URL is unreachable + carries credentials. If startTask resolved it,
    // the clone would fail. It must NOT: preResolvedSource short-circuits the
    // single repo (index 0).
    const credentialedUrl = 'https://user:s3cr3t@example.invalid/repo.git'
    const task = await startTask(
      { workflowId: wf.id, name: 'unit', repoUrl: credentialedUrl, inputs: { topic: 'hi' } },
      {
        db,
        appHome,
        opencodeCmd: stubCmd(stubOpencode),
        awaitScheduler: true,
        preResolvedSource: {
          repoPath: realRepo,
          baseBranch: 'main',
          repoUrl: credentialedUrl,
          pathFetchError: null,
          ffWarnings: [],
        },
        preCreatedWorktree: {
          taskId,
          worktreePath: wt.worktreePath,
          branch: wt.branch,
          baseCommit: wt.baseCommit,
        },
      },
    )
    // Launch succeeded ⟹ the unreachable URL was never cloned (resolved once).
    expect(task.status).not.toBe('failed')
    // F4: persisted repoUrl is redacted — no cleartext credential in the DB.
    expect(task.repoUrl ?? '').not.toContain('s3cr3t')
    rimrafDir(tmp)
  })
})

// ---------------------------------------------------------------------------
// Source anchor — the lift must not silently regress: the old path-mode-only
// throw is gone, and BOTH startTask handoffs thread the pre-resolved source.
// ---------------------------------------------------------------------------
describe('RFC-107 — source anchors', () => {
  test('route no longer hard-refuses url uploads, and threads preResolvedSource on both handoffs', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'routes', 'tasks.ts'), 'utf8')
    expect(src).not.toContain('multipart uploads currently require launching with a local repoPath')
    expect(src).not.toContain('if (startInput.repoUrl) {')
    // success + earlyError handoffs both pass the pre-resolved source.
    expect(src.split('preResolvedSource: resolvedSource').length - 1).toBe(2)
  })
})

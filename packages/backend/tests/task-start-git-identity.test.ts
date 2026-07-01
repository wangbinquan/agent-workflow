// RFC-067 — task-level Git commit identity. End-to-end behaviour:
//   - startTask persists `gitUserName` / `gitUserEmail` (or NULL) on `tasks`.
//   - startTask writes `[user]` to the worktree's `.git/config` ONLY when
//     both halves are set.
//   - runner spawn env contains `GIT_AUTHOR_*` + `GIT_COMMITTER_*` four-tuple
//     ONLY when both halves are set, and the task identity outranks any
//     inherited `GIT_AUTHOR_*` on the daemon process.
//   - Two concurrent tasks with different identities do not bleed env vars
//     into each other's spawn.
//   - Default behaviour (both omitted) is byte-identical to pre-RFC-067:
//     no env injected, no `[user]` block written.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import type { DbClient } from '../src/db/client'
import { tasks } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { startTask } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  tmp: string
  appHome: string
  repoPath: string
  db: DbClient
  stubOpencode: string
  envCaptureDir: string
  wfId: string
}

/**
 * Stub opencode that — on `run` — writes its inherited env vars to a
 * deterministic JSON file (one per node_run, keyed by OPENCODE_CONFIG_DIR
 * tail segment so concurrent tasks don't collide) and then emits the
 * standard <workflow-output> envelope so the scheduler marks the run done.
 */
function makeEnvCapturingStub(dir: string, captureDir: string): string {
  const path = join(dir, 'stub-opencode-env.sh')
  // Use the OPENCODE_CONFIG_DIR last segment as a unique key — runner.ts
  // constructs `~/.agent-workflow/runs/{task}/{nodeRun}/.opencode/`, so
  // `basename` is the nodeRunId. Falls back to PID for safety.
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then echo 'stub-opencode 1.14.99'; exit 0; fi
if [[ "$1" == "run" ]]; then
  KEY="$(basename "\${OPENCODE_CONFIG_DIR:-pid-$$}")"
  KEY="\${KEY%%.opencode}"
  if [[ -z "$KEY" ]]; then KEY="pid-$$"; fi
  OUT="${captureDir}/env-\${KEY}.json"
  # Capture only the four RFC-067 vars + a stable marker so the test
  # doesn't have to grep through hundreds of inherited keys.
  {
    printf '{'
    printf '"GIT_AUTHOR_NAME": %s,' "$(printf '%s' "\${GIT_AUTHOR_NAME:-__unset__}" | jq -Rs .)"
    printf '"GIT_AUTHOR_EMAIL": %s,' "$(printf '%s' "\${GIT_AUTHOR_EMAIL:-__unset__}" | jq -Rs .)"
    printf '"GIT_COMMITTER_NAME": %s,' "$(printf '%s' "\${GIT_COMMITTER_NAME:-__unset__}" | jq -Rs .)"
    printf '"GIT_COMMITTER_EMAIL": %s' "$(printf '%s' "\${GIT_COMMITTER_EMAIL:-__unset__}" | jq -Rs .)"
    printf '}\\n'
  } > "$OUT"
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

async function setup(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc067-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  const envCaptureDir = join(tmp, 'env-capture')
  mkdirSync(envCaptureDir, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)

  execSync(`git init -b main "${repoPath}"`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.name t`, { stdio: 'ignore' })
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  execSync(`git -C "${repoPath}" add . && git -C "${repoPath}" commit -m init`, {
    stdio: 'ignore',
  })

  const stubOpencode = makeEnvCapturingStub(tmp, envCaptureDir)

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
    },
  })

  return { tmp, appHome, repoPath, db, stubOpencode, envCaptureDir, wfId: wf.id }
}

interface CapturedEnv {
  GIT_AUTHOR_NAME: string
  GIT_AUTHOR_EMAIL: string
  GIT_COMMITTER_NAME: string
  GIT_COMMITTER_EMAIL: string
}

function readCapturedEnvs(captureDir: string): CapturedEnv[] {
  if (!existsSync(captureDir)) return []
  const files = execSync(`ls "${captureDir}"`, { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((f) => f.endsWith('.json'))
  return files.map((f) => JSON.parse(readFileSync(join(captureDir, f), 'utf8')))
}

describe('RFC-067 — startTask + runner Git identity wiring', () => {
  // Each test installs and restores env vars under defer().
  const envSavers: Array<() => void> = []
  beforeEach(() => {
    envSavers.length = 0
  })
  afterEach(() => {
    for (const restore of envSavers.reverse()) restore()
  })

  function patchEnv(key: string, value: string | undefined): void {
    const prior = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    envSavers.push(() => {
      if (prior === undefined) delete process.env[key]
      else process.env[key] = prior
    })
  }

  test('AC-1: both omitted → DB columns NULL, no env injected', async () => {
    const h = await setup()
    const task = await startTask(
      {
        workflowId: h.wfId,
        name: 'no-identity-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 't' },
      },
      { db: h.db, appHome: h.appHome, opencodeCmd: [h.stubOpencode], awaitScheduler: true },
    )

    const row = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1))[0]!
    expect(row.gitUserName).toBeNull()
    expect(row.gitUserEmail).toBeNull()

    // No spawned process saw any of the four RFC-067 env vars.
    const envs = readCapturedEnvs(h.envCaptureDir)
    expect(envs.length).toBeGreaterThan(0)
    for (const e of envs) {
      expect(e.GIT_AUTHOR_NAME).toBe('__unset__')
      expect(e.GIT_AUTHOR_EMAIL).toBe('__unset__')
      expect(e.GIT_COMMITTER_NAME).toBe('__unset__')
      expect(e.GIT_COMMITTER_EMAIL).toBe('__unset__')
    }
    rmSync(h.tmp, { recursive: true, force: true })
  })

  test('AC-2: both set → DB columns persist, env has 4-tuple on every spawn', async () => {
    const h = await setup()
    const task = await startTask(
      {
        workflowId: h.wfId,
        name: 'bot-identity-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 't' },
        gitUserName: 'AI Bot',
        gitUserEmail: 'bot@workflow.local',
      },
      { db: h.db, appHome: h.appHome, opencodeCmd: [h.stubOpencode], awaitScheduler: true },
    )
    const row = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1))[0]!
    expect(row.gitUserName).toBe('AI Bot')
    expect(row.gitUserEmail).toBe('bot@workflow.local')

    // Stub captured the four env vars on every spawn.
    const envs = readCapturedEnvs(h.envCaptureDir)
    expect(envs.length).toBeGreaterThan(0)
    for (const e of envs) {
      expect(e.GIT_AUTHOR_NAME).toBe('AI Bot')
      expect(e.GIT_AUTHOR_EMAIL).toBe('bot@workflow.local')
      expect(e.GIT_COMMITTER_NAME).toBe('AI Bot')
      expect(e.GIT_COMMITTER_EMAIL).toBe('bot@workflow.local')
    }
    rmSync(h.tmp, { recursive: true, force: true })
  })

  test('AC-3: leading/trailing whitespace trimmed before persistence + env', async () => {
    const h = await setup()
    const task = await startTask(
      {
        workflowId: h.wfId,
        name: 'trim-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 't' },
        gitUserName: '  Padded Bot  ',
        gitUserEmail: '  padded@bot.local  ',
      },
      { db: h.db, appHome: h.appHome, opencodeCmd: [h.stubOpencode], awaitScheduler: true },
    )
    const row = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1))[0]!
    expect(row.gitUserName).toBe('Padded Bot')
    expect(row.gitUserEmail).toBe('padded@bot.local')
    const envs = readCapturedEnvs(h.envCaptureDir)
    for (const e of envs) {
      expect(e.GIT_AUTHOR_NAME).toBe('Padded Bot')
      expect(e.GIT_AUTHOR_EMAIL).toBe('padded@bot.local')
    }
    rmSync(h.tmp, { recursive: true, force: true })
  })

  test('AC-4: daemon GIT_AUTHOR_NAME set, task identity wins inside spawn', async () => {
    const h = await setup()
    patchEnv('GIT_AUTHOR_NAME', 'daemonbot')
    patchEnv('GIT_AUTHOR_EMAIL', 'daemon@bot.test')
    const task = await startTask(
      {
        workflowId: h.wfId,
        name: 'override-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 't' },
        gitUserName: 'Task Bot',
        gitUserEmail: 'task@bot.test',
      },
      { db: h.db, appHome: h.appHome, opencodeCmd: [h.stubOpencode], awaitScheduler: true },
    )
    expect(task.gitUserName).toBe('Task Bot')
    const envs = readCapturedEnvs(h.envCaptureDir)
    for (const e of envs) {
      // Task value wins because runner.ts writes it AFTER `...process.env`
      // is spread into the env dict.
      expect(e.GIT_AUTHOR_NAME).toBe('Task Bot')
      expect(e.GIT_AUTHOR_EMAIL).toBe('task@bot.test')
      expect(e.GIT_COMMITTER_NAME).toBe('Task Bot')
      expect(e.GIT_COMMITTER_EMAIL).toBe('task@bot.test')
    }
    rmSync(h.tmp, { recursive: true, force: true })
  })

  test('AC-5: daemon GIT_AUTHOR_NAME set, no task identity → daemon value falls through (legacy)', async () => {
    const h = await setup()
    patchEnv('GIT_AUTHOR_NAME', 'daemonbot')
    patchEnv('GIT_AUTHOR_EMAIL', 'daemon@bot.test')
    await startTask(
      {
        workflowId: h.wfId,
        name: 'no-task-identity',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 't' },
      },
      { db: h.db, appHome: h.appHome, opencodeCmd: [h.stubOpencode], awaitScheduler: true },
    )
    const envs = readCapturedEnvs(h.envCaptureDir)
    for (const e of envs) {
      // Daemon-level env still flows through normally — runner does not
      // strip it just because the task didn't set its own identity.
      expect(e.GIT_AUTHOR_NAME).toBe('daemonbot')
      expect(e.GIT_AUTHOR_EMAIL).toBe('daemon@bot.test')
      // Committer was NOT set on the daemon → stays unset, matches pre-RFC-067.
      expect(e.GIT_COMMITTER_NAME).toBe('__unset__')
      expect(e.GIT_COMMITTER_EMAIL).toBe('__unset__')
    }
    rmSync(h.tmp, { recursive: true, force: true })
  })

  test('AC-6: two concurrent tasks with different identities do not leak env into each other', async () => {
    const hA = await setup()
    // Reuse the same DB / capture dir / repo for the second task: simulates a
    // single daemon driving multiple tasks concurrently. Different capture
    // dirs per task would cheat the isolation check.
    const taskA = await startTask(
      {
        workflowId: hA.wfId,
        name: 'task-A',
        repoPath: hA.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'tA' },
        gitUserName: 'Bot A',
        gitUserEmail: 'a@bot.test',
      },
      { db: hA.db, appHome: hA.appHome, opencodeCmd: [hA.stubOpencode], awaitScheduler: true },
    )
    const taskB = await startTask(
      {
        workflowId: hA.wfId,
        name: 'task-B',
        repoPath: hA.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'tB' },
        gitUserName: 'Bot B',
        gitUserEmail: 'b@bot.test',
      },
      { db: hA.db, appHome: hA.appHome, opencodeCmd: [hA.stubOpencode], awaitScheduler: true },
    )
    expect(taskA.gitUserName).toBe('Bot A')
    expect(taskB.gitUserName).toBe('Bot B')

    // process.env survives the spawn — runner mutates only the spawn-local
    // dict, never the parent process. Confirms no env leakage at the daemon
    // level either.
    expect(process.env.GIT_AUTHOR_NAME).toBeUndefined()
    expect(process.env.GIT_AUTHOR_EMAIL).toBeUndefined()
    rmSync(hA.tmp, { recursive: true, force: true })
  })

  test('AC-7: half-identity (only name, schema bypass) → service defensively nullifies BOTH', async () => {
    // Schema-level rejection is locked in
    // `packages/shared/tests/start-task-schema-git-identity.test.ts`.
    // This test exercises the defense-in-depth nullification inside
    // services/task.ts: if a caller bypasses the HTTP route + schema (e.g. a
    // future internal call, a hand-crafted multipart payload), neither half
    // of a partial identity lands in the DB and no env is injected.
    const h = await setup()
    const task = await startTask(
      {
        workflowId: h.wfId,
        name: 'half-name-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 't' },
        gitUserName: 'Lonely Bot',
      },
      { db: h.db, appHome: h.appHome, opencodeCmd: [h.stubOpencode], awaitScheduler: true },
    )
    const row = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1))[0]!
    // BOTH columns must be NULL — half-identity is never persisted.
    expect(row.gitUserName).toBeNull()
    expect(row.gitUserEmail).toBeNull()
    // Env injection skipped entirely.
    const envs = readCapturedEnvs(h.envCaptureDir)
    for (const e of envs) {
      expect(e.GIT_AUTHOR_NAME).toBe('__unset__')
      expect(e.GIT_AUTHOR_EMAIL).toBe('__unset__')
      expect(e.GIT_COMMITTER_NAME).toBe('__unset__')
      expect(e.GIT_COMMITTER_EMAIL).toBe('__unset__')
    }
    rmSync(h.tmp, { recursive: true, force: true })
  })

  test('AC-8: half-identity (only email, schema bypass) → service defensively nullifies BOTH', async () => {
    const h = await setup()
    const task = await startTask(
      {
        workflowId: h.wfId,
        name: 'half-email-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 't' },
        gitUserEmail: 'lonely@bot.local',
      },
      { db: h.db, appHome: h.appHome, opencodeCmd: [h.stubOpencode], awaitScheduler: true },
    )
    const row = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1))[0]!
    expect(row.gitUserName).toBeNull()
    expect(row.gitUserEmail).toBeNull()
    const envs = readCapturedEnvs(h.envCaptureDir)
    for (const e of envs) {
      expect(e.GIT_AUTHOR_NAME).toBe('__unset__')
      expect(e.GIT_AUTHOR_EMAIL).toBe('__unset__')
    }
    rmSync(h.tmp, { recursive: true, force: true })
  })
})

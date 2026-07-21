// RFC-024 T4 — locks the URL-mode branch of startTask:
//   1. Cold path: clones the URL into the cache, materializes a worktree
//      under appHome/worktrees/, persists tasks.repoUrl, does NOT touch
//      recent_repos.
//   2. Warm path: same URL on a second launch reuses the cache (single row
//      in cached_repos).
//   3. ref-not-found rewrap: a missing ref produces ValidationError
//      `repo-ref-not-found` whose details carry availableRefs[] + redacted URL.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { abortAllActiveTasks, isTaskActive, startTask as startTaskBase } from '../src/services/task'
import { nonInteractiveGitEnv } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const GIT_TIMEOUT_MS = 10_000
const NODE_TIMEOUT_MS = 10_000
const FLOW_TIMEOUT_MS = 20_000
const ACTIVE_TASK_SETTLE_TIMEOUT_MS = 5_000

let cleanupDir: string | undefined
let watchdog: ReturnType<typeof setTimeout> | undefined

setDefaultTimeout(FLOW_TIMEOUT_MS + ACTIVE_TASK_SETTLE_TIMEOUT_MS + 5_000)

beforeEach(() => {
  cleanupDir = undefined
  watchdog = setTimeout(() => abortAllActiveTasks('test-timeout'), FLOW_TIMEOUT_MS)
})

afterEach(async () => {
  if (watchdog !== undefined) clearTimeout(watchdog)
  try {
    await abortActiveTasksAndWait('test-cleanup')
  } finally {
    if (cleanupDir !== undefined) rmSync(cleanupDir, { recursive: true, force: true })
  }
})

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

function startTask(
  input: Parameters<typeof startTaskBase>[0],
  deps: Parameters<typeof startTaskBase>[1],
) {
  return startTaskBase(input, {
    ...deps,
    defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
    defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
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
  ENV="$OPEN"'<port name="out">hello</port></workflow-output>'
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

async function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-start-url-'))
  cleanupDir = tmp
  const appHome = join(tmp, 'home')
  mkdirSync(appHome, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)

  // Build a fixture bare repo we can clone via file://.
  const working = join(tmp, 'src')
  mkdirSync(working, { recursive: true })
  git('init', '-b', 'main', working)
  git('-C', working, 'config', 'user.email', 't@t.test')
  git('-C', working, 'config', 'user.name', 't')
  writeFileSync(join(working, 'README.md'), '# repo\n')
  git('-C', working, 'add', '.')
  git('-C', working, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'init')
  const bare = join(tmp, 'remote.git')
  git('clone', '--bare', working, bare)
  const remoteUrl = `file://${bare}`

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
        {
          id: 'echoer',
          kind: 'agent-single',
          agentName: 'echoer',
          promptTemplate: '{{topic}}',
        },
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

  return { tmp, appHome, db, stubOpencode, wf, remoteUrl }
}

describe('startTask URL mode (RFC-024)', () => {
  test('cold launch clones URL, persists repoUrl, does not write recent_repos', async () => {
    const { appHome, db, stubOpencode, wf, remoteUrl } = await setup()
    const task = await startTask(
      { workflowId: wf.id, name: 'fixture-task', repoUrl: remoteUrl, inputs: { topic: 'orders' } },
      { db, appHome, opencodeCmd: [stubOpencode], awaitScheduler: true },
    )
    expect(task.repoUrl).toBe(remoteUrl)
    expect(task.repoPath.startsWith(join(appHome, 'repos'))).toBe(true)
    // Worktree is under appHome/worktrees and was created from the cache.
    expect(task.worktreePath.startsWith(join(appHome, 'worktrees'))).toBe(true)
    // cached_repos got exactly one row (recent_repos retired by RFC-165).
    expect(db.select().from(cachedRepos).all().length).toBe(1)
  })

  // RFC-175 §2c: the immediate-submit workflow-version OCC guard for relaunch.
  test('expectedWorkflowVersion mismatch → 409 before any materialization', async () => {
    const { appHome, db, wf, remoteUrl } = await setup()
    // Fires right after getWorkflow (pre-materialize / pre-input-validation), so
    // a relaunch that normalized inputs against version N cannot silently store
    // them into a concurrently-PUT N+1 snapshot. No repo/scheduler is reached.
    await expect(
      startTask(
        {
          workflowId: wf.id,
          name: 'stale-relaunch',
          repoUrl: remoteUrl,
          inputs: { topic: 'x' },
          expectedWorkflowVersion: wf.version + 999,
        },
        { db, appHome },
      ),
    ).rejects.toMatchObject({ code: 'workflow-version-mismatch' })
    // No task row, no cached clone (guard short-circuited before repo work).
    expect((await db.select().from(cachedRepos)).length).toBe(0)
  })

  test('warm launch (second task same URL) reuses cache', async () => {
    const { appHome, db, stubOpencode, wf, remoteUrl } = await setup()
    const t1 = await startTask(
      { workflowId: wf.id, name: 'fixture-task', repoUrl: remoteUrl, inputs: { topic: 'a' } },
      { db, appHome, opencodeCmd: [stubOpencode], awaitScheduler: true },
    )
    const t2 = await startTask(
      { workflowId: wf.id, name: 'fixture-task', repoUrl: remoteUrl, inputs: { topic: 'b' } },
      { db, appHome, opencodeCmd: [stubOpencode], awaitScheduler: true },
    )
    expect(t1.repoPath).toBe(t2.repoPath)
    expect(db.select().from(cachedRepos).all().length).toBe(1)
  })

  test('unknown ref → ValidationError repo-ref-not-found with available refs', async () => {
    const { appHome, db, stubOpencode, wf, remoteUrl } = await setup()
    let err: unknown
    try {
      await startTask(
        {
          workflowId: wf.id,
          name: 'fixture-task',
          repoUrl: remoteUrl,
          ref: 'this-ref-does-not-exist',
          inputs: { topic: 'orders' },
        },
        { db, appHome, opencodeCmd: [stubOpencode], awaitScheduler: true },
      )
    } catch (e) {
      err = e
    }
    // @ts-expect-error runtime probe
    expect(err?.code).toBe('repo-ref-not-found')
    // @ts-expect-error runtime probe
    const details = err?.details as { availableRefs?: string[]; url?: string; ref?: string }
    expect(Array.isArray(details?.availableRefs)).toBe(true)
    expect((details?.availableRefs ?? []).includes('main')).toBe(true)
    expect(details?.ref).toBe('this-ref-does-not-exist')
  })
})

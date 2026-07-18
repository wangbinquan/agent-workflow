// RFC-075 T4/T5/T6 — startTask wiring for the working branch.
//   - workingBranch + autoCommitPush persist on `tasks` and `task_repos`,
//     and getTask surfaces them.
//   - omitted → NULL working branch + auto_commit_push false, worktree stays
//     on the legacy `agent-workflow/{taskId}` isolation branch (byte-compat).
//   - a working branch already checked out by another task's worktree →
//     ValidationError(working-branch-in-use) (a 422 launch failure).
//   - reusing an existing branch that conflicts with base on merge →
//     ValidationError(working-branch-base-merge-conflict).

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { taskRepos, tasks } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import {
  abortAllActiveTasks,
  getTask,
  isTaskActive,
  startTaskWithLocalRepo as startTaskWithLocalRepoBase,
} from '../src/services/task'
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

function startTaskWithLocalRepo(
  input: Parameters<typeof startTaskWithLocalRepoBase>[0],
  deps: Parameters<typeof startTaskWithLocalRepoBase>[1],
) {
  return startTaskWithLocalRepoBase(input, {
    ...deps,
    defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
    defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
  })
}

interface Harness {
  appHome: string
  repoPath: string
  db: DbClient
  stubOpencode: string
  wfId: string
}

function makeStub(dir: string): string {
  const path = join(dir, 'stub-opencode.sh')
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then echo 'stub-opencode 1.14.99'; exit 0; fi
if [[ "$1" == "run" ]]; then
  ENV='<workflow-output><port name="out">ok</port></workflow-output>'
  printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$(date +%s%3N)" "$ENV"
  exit 0
fi
exit 1
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

async function setup(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc075-'))
  cleanupDir = tmp
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)

  git('init', '-b', 'main', repoPath)
  git('-C', repoPath, 'config', 'user.email', 't@t.test')
  git('-C', repoPath, 'config', 'user.name', 't')
  writeFileSync(join(repoPath, 'a.txt'), 'original\n')
  git('-C', repoPath, 'add', '.')
  git('-C', repoPath, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', 'init')

  const stubOpencode = makeStub(tmp)

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

  return { appHome, repoPath, db, stubOpencode, wfId: wf.id }
}

describe('RFC-075 — startTask working branch', () => {
  let h: Harness
  beforeEach(async () => {
    h = await setup()
  })

  function launch(extra: Record<string, unknown>) {
    return startTaskWithLocalRepo(
      {
        workflowId: h.wfId,
        name: 'wb-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 't' },
        ...extra,
      },
      { db: h.db, appHome: h.appHome, opencodeCmd: [h.stubOpencode], awaitScheduler: true },
    )
  }

  test('workingBranch + autoCommitPush persist on tasks + task_repos and surface via getTask', async () => {
    const task = await launch({ workingBranch: 'feature/wb', autoCommitPush: true })

    const row = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1))[0]!
    expect(row.workingBranch).toBe('feature/wb')
    expect(row.autoCommitPush).toBe(true)
    expect(row.branch).toBe('feature/wb')

    const repoRow = (await h.db.select().from(taskRepos).where(eq(taskRepos.taskId, task.id)))[0]!
    expect(repoRow.workingBranch).toBe('feature/wb')
    expect(repoRow.branch).toBe('feature/wb')

    const fetched = (await getTask(h.db, task.id))!
    expect(fetched.workingBranch).toBe('feature/wb')
    expect(fetched.autoCommitPush).toBe(true)
    expect(fetched.repos[0]!.workingBranch).toBe('feature/wb')
  })

  test('omitted → NULL working branch, auto_commit_push false, legacy isolation branch', async () => {
    const task = await launch({})
    const row = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1))[0]!
    expect(row.workingBranch).toBeNull()
    expect(row.autoCommitPush).toBe(false)
    expect(row.branch).toBe(`agent-workflow/${task.id}`)

    const fetched = (await getTask(h.db, task.id))!
    expect(fetched.workingBranch).toBeNull()
    expect(fetched.autoCommitPush).toBe(false)
  })

  test('working branch already checked out by another task → working-branch-in-use (422)', async () => {
    await launch({ workingBranch: 'feature/shared' })
    let thrown: unknown
    try {
      await launch({ workingBranch: 'feature/shared' })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeDefined()
    expect((thrown as { code?: string; status?: number }).code).toBe('working-branch-in-use')
    expect((thrown as { status?: number }).status).toBe(422)
  })

  test('reuse existing branch that conflicts with base on merge → working-branch-base-merge-conflict', async () => {
    // feature/cf and main both edit a.txt differently.
    git('-C', h.repoPath, 'checkout', '-q', '-b', 'feature/cf', 'main')
    writeFileSync(join(h.repoPath, 'a.txt'), 'from branch\n')
    git('-C', h.repoPath, 'add', '.')
    git(
      '-C',
      h.repoPath,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-q',
      '-m',
      'branch-edit',
    )
    git('-C', h.repoPath, 'checkout', '-q', 'main')
    writeFileSync(join(h.repoPath, 'a.txt'), 'from base\n')
    git('-C', h.repoPath, 'add', '.')
    git(
      '-C',
      h.repoPath,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-q',
      '-m',
      'base-edit',
    )

    let thrown: unknown
    try {
      await launch({ workingBranch: 'feature/cf' })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe('working-branch-base-merge-conflict')
  })
})

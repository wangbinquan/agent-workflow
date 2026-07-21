// RFC-020 T3: startTask now accepts a `preCreatedWorktree` so the multipart
// RFC-165: multi-repo/pre-created PATH bodies are the framework-internal face
// now (the wire is URL-only) — bodies are cast through the internal
// RepoSourceSpec widening; runtime behavior is byte-identical to pre-165.
// upload route can land user-uploaded files into the worktree BEFORE the
// task row is created. When passed, startTask must NOT shell out to git;
// when omitted, behavior is identical to the pre-RFC-020 path.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { DEFAULT_PROTOCOL_RETRY_BUDGET, type StartTask } from '@agent-workflow/shared'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import {
  abortAllActiveTasks,
  isTaskActive,
  materializeWorktree,
  startTask as startTaskBase,
} from '../src/services/task'
import { nonInteractiveGitEnv } from '../src/util/git'
import { ulid } from 'ulid'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const GIT_TIMEOUT_MS = 10_000
const NODE_TIMEOUT_MS = 10_000
const FLOW_TIMEOUT_MS = 20_000
const ACTIVE_TASK_SETTLE_TIMEOUT_MS = 5_000

let cleanupDirs: string[] = []
let watchdog: ReturnType<typeof setTimeout> | undefined

setDefaultTimeout(FLOW_TIMEOUT_MS + ACTIVE_TASK_SETTLE_TIMEOUT_MS + 5_000)

beforeEach(() => {
  cleanupDirs = []
  watchdog = setTimeout(() => abortAllActiveTasks('test-timeout'), FLOW_TIMEOUT_MS)
})

afterEach(async () => {
  if (watchdog !== undefined) clearTimeout(watchdog)
  try {
    await abortActiveTasksAndWait('test-cleanup')
  } finally {
    for (const dir of cleanupDirs.reverse()) rmSync(dir, { recursive: true, force: true })
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
  const tmp = makeTempDir('aw-start-pre-')
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  const db = createInMemoryDb(MIGRATIONS)

  git('init', '-b', 'main', repoPath)
  git('-C', repoPath, 'config', 'user.email', 't@t.test')
  git('-C', repoPath, 'config', 'user.name', 't')
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  git('-C', repoPath, 'add', '.')
  git('-C', repoPath, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'init')

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

  return { appHome, repoPath, db, stubOpencode, wf }
}

describe('startTask with preCreatedWorktree (RFC-020)', () => {
  test('honors caller-supplied taskId / worktreePath / branch / baseCommit', async () => {
    const { appHome, repoPath, db, stubOpencode, wf } = await setup()
    // Caller pre-creates the worktree (simulating the multipart route).
    const taskId = ulid()
    const wt = await materializeWorktree({
      repoPath,
      baseBranch: 'main',
      taskId,
      appHome,
    })
    expect(wt.earlyError).toBeNull()
    expect(existsSync(wt.worktreePath)).toBe(true)
    // Write a marker into the worktree to simulate an uploaded file landing
    // there before startTask runs.
    writeFileSync(join(wt.worktreePath, 'uploaded.txt'), 'hi')

    // RFC-165: preCreatedWorktree's surviving consumer (fusion) pairs it with
    // the internal launch face — the local repo rides deps.internalSource,
    // never the retired repoPath wire field.
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 'fixture-task',
        inputs: { topic: 'orders' },
      } as unknown as StartTask,
      {
        db,
        appHome,
        opencodeCmd: [stubOpencode],
        awaitScheduler: true,
        internalSource: { kind: 'local-path', repoPath, baseBranch: 'main' },
        preCreatedWorktree: {
          taskId,
          worktreePath: wt.worktreePath,
          branch: wt.branch,
          baseCommit: wt.baseCommit,
          cleanup: { kind: 'linked-worktree', provenance: wt.cleanup! },
        },
      },
    )

    expect(task.id).toBe(taskId)
    expect(task.worktreePath).toBe(wt.worktreePath)
    expect(task.branch).toBe(wt.branch)
    // Marker file is still where the caller put it.
    expect(readFileSync(join(wt.worktreePath, 'uploaded.txt'), 'utf8')).toBe('hi')
  })

  test('without preCreatedWorktree, falls back to the original git path', async () => {
    const { appHome, repoPath, db, stubOpencode, wf } = await setup()
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 'fixture-task',
        repoPath,
        baseBranch: 'main',
        inputs: { topic: 'orders' },
      } as unknown as StartTask,
      { db, appHome, opencodeCmd: [stubOpencode], awaitScheduler: true },
    )
    expect(task.worktreePath).not.toBe('')
    expect(existsSync(task.worktreePath)).toBe(true)
  })

  test('materializeWorktree returns earlyError on bad repo', async () => {
    const tmp = makeTempDir('aw-materialize-')
    const wt = await materializeWorktree({
      repoPath: join(tmp, 'no-such-repo'),
      baseBranch: 'main',
      taskId: ulid(),
      appHome: join(tmp, 'home'),
    })
    expect(wt.earlyError).not.toBeNull()
    expect(wt.worktreePath).toBe('')
  })
})

// RFC-320 — account profile is the only user-task Git identity source. The
// task row freezes it once and every runtime spawn consumes that snapshot.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, users } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import {
  abortAllActiveTasks,
  isTaskActive,
  resolveTaskGitCommitIdentity,
  startTaskWithLocalRepo,
} from '../src/services/task'
import { createWorkflow } from '../src/services/workflow'
import { DomainError } from '../src/util/errors'
import { nonInteractiveGitEnv } from '../src/util/git'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const GIT_TIMEOUT_MS = 10_000
const NODE_TIMEOUT_MS = 10_000
const FLOW_TIMEOUT_MS = 60_000
const ACTIVE_TASK_SETTLE_TIMEOUT_MS = 5_000

setDefaultTimeout(FLOW_TIMEOUT_MS + ACTIVE_TASK_SETTLE_TIMEOUT_MS + 5_000)

interface Harness {
  readonly db: DbClient
  readonly root: string
  readonly appHome: string
  readonly repoPath: string
  readonly workflowId: string
  readonly envLog: string
}

let roots: string[] = []
let databases: DbClient[] = []
let watchdog: ReturnType<typeof setTimeout> | undefined

beforeEach(() => {
  roots = []
  databases = []
  watchdog = setTimeout(() => abortAllActiveTasks('test-timeout'), FLOW_TIMEOUT_MS)
})

afterEach(async () => {
  if (watchdog !== undefined) clearTimeout(watchdog)
  try {
    await abortActiveTasksAndWait('test-cleanup')
  } finally {
    for (const db of databases.reverse()) db.$client.close()
    for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true })
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

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    timeout: GIT_TIMEOUT_MS,
    env: nonInteractiveGitEnv(),
  })
}

async function setup(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc320-git-identity-'))
  roots.push(root)
  const appHome = join(root, 'home')
  const repoPath = join(root, 'repo')
  const envLog = join(root, 'env.jsonl')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  databases.push(db)
  await seedTestDefaultOpencodeRuntime(db)

  git(repoPath, 'init', '-q', '-b', 'main')
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  git(repoPath, 'add', '.')
  git(
    repoPath,
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'user.name=fixture',
    'commit',
    '-q',
    '-m',
    'init',
  )

  const agent = await createAgent(db, {
    name: 'echoer',
    description: '',
    outputs: ['out'],
    outputKinds: { out: 'string' },
    syncOutputsOnIterate: false,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })
  const workflow = await createWorkflow(db, {
    name: 'identity-fixture',
    description: '',
    definition: {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'topic' },
        {
          id: 'agent',
          kind: 'agent-single',
          agentId: agent.id,
          agentName: agent.name,
          promptTemplate: '{{topic}}',
        },
      ],
      edges: [
        {
          id: 'edge',
          source: { nodeId: 'in', portName: 'topic' },
          target: { nodeId: 'agent', portName: 'topic' },
        },
      ],
    },
  })
  return { db, root, appHome, repoPath, workflowId: workflow.id, envLog }
}

async function seedUser(
  db: DbClient,
  id: string,
  displayName: string,
  email: string | null,
  gitName: string = displayName,
): Promise<void> {
  await db.insert(users).values({
    id,
    username: id,
    email,
    displayName,
    gitName,
    passwordHash: null,
    role: 'user',
    status: 'active',
    forcePasswordChange: false,
    createdBy: null,
    createdAt: 1,
    updatedAt: 1,
    lastLoginAt: null,
    schemaVersion: 1,
  })
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prior = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    prior.set(key, process.env[key])
    process.env[key] = value
  }
  return body().finally(() => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

async function launch(h: Harness, name: string, actorUserId?: string) {
  return await withEnv(
    {
      MOCK_OPENCODE_OUTPUTS: JSON.stringify({ out: 'ok' }),
      MOCK_OPENCODE_CAPTURE_ENV_TO: h.envLog,
    },
    () => launchWithoutEnv(h, name, actorUserId),
  )
}

function launchWithoutEnv(h: Harness, name: string, actorUserId?: string) {
  return startTaskWithLocalRepo(
    {
      workflowId: h.workflowId,
      name,
      repoPath: h.repoPath,
      baseBranch: 'main',
      inputs: { topic: name },
    },
    {
      db: h.db,
      schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
        .schedulerDriver,
      appHome: h.appHome,
      ...(actorUserId === undefined ? {} : { actorUserId }),
      binaryOverride: [process.execPath, 'run', MOCK_OPENCODE],
      awaitScheduler: true,
      defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
      defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
    },
  )
}

function readCaptured(h: Harness): Array<Record<string, string | null>> {
  if (!Bun.file(h.envLog).size) return []
  return readFileSync(h.envLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, string | null>)
}

describe('RFC-320 task Git identity snapshot', () => {
  test('human root task freezes gitName/email, independent from displayName', async () => {
    const h = await setup()
    await seedUser(h.db, 'alice', 'Alice Chen', 'alice@example.test', 'A. Chen')
    const task = await launch(h, 'human-root', 'alice')

    expect(task.gitUserName).toBe('A. Chen')
    expect(task.gitUserEmail).toBe('alice@example.test')
    for (const env of readCaptured(h)) {
      expect(env.GIT_AUTHOR_NAME).toBe('A. Chen')
      expect(env.GIT_AUTHOR_EMAIL).toBe('alice@example.test')
      expect(env.GIT_COMMITTER_NAME).toBe('A. Chen')
      expect(env.GIT_COMMITTER_EMAIL).toBe('alice@example.test')
    }
  })

  test('profile changes affect future tasks only; the first row stays frozen', async () => {
    const h = await setup()
    await seedUser(h.db, 'alice', 'Alice A', 'alice-a@example.test')
    const first = await launch(h, 'first', 'alice')
    await h.db
      .update(users)
      .set({
        displayName: 'Unrelated Display B',
        gitName: 'Alice B',
        email: 'alice-b@example.test',
        updatedAt: 2,
      })
      .where(eq(users.id, 'alice'))
    const second = await launch(h, 'second', 'alice')

    const rows = await h.db
      .select({ id: tasks.id, name: tasks.gitUserName, email: tasks.gitUserEmail })
      .from(tasks)
    expect(rows.find((row) => row.id === first.id)).toMatchObject({
      name: 'Alice A',
      email: 'alice-a@example.test',
    })
    expect(rows.find((row) => row.id === second.id)).toMatchObject({
      name: 'Alice B',
      email: 'alice-b@example.test',
    })
    expect(new Set(readCaptured(h).map((env) => env.GIT_AUTHOR_NAME))).toEqual(
      new Set(['Alice A', 'Alice B']),
    )
  })

  test('missing account email rejects a human task instead of using daemon identity', async () => {
    const h = await setup()
    await seedUser(h.db, 'alice', 'Alice', null)
    const error = await launch(h, 'missing-email', 'alice').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('git-identity-email-missing')
    expect((await h.db.select().from(tasks)).length).toBe(0)
  })

  test('missing Git name rejects a human task even when displayName exists', async () => {
    const h = await setup()
    await seedUser(h.db, 'alice', 'Visible Alice', 'alice@example.test', '')
    const error = await launch(h, 'missing-git-name', 'alice').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('git-identity-name-missing')
    expect((await h.db.select().from(tasks)).length).toBe(0)
  })

  test('task snapshot overrides daemon Git environment without mutating process.env', async () => {
    const h = await setup()
    await seedUser(h.db, 'alice', 'Task Owner', 'owner@example.test')
    await withEnv(
      {
        GIT_AUTHOR_NAME: 'daemon',
        GIT_AUTHOR_EMAIL: 'daemon@example.test',
        GIT_COMMITTER_NAME: 'daemon',
        GIT_COMMITTER_EMAIL: 'daemon@example.test',
      },
      () => launch(h, 'override', 'alice'),
    )
    for (const env of readCaptured(h)) {
      expect(env.GIT_AUTHOR_NAME).toBe('Task Owner')
      expect(env.GIT_AUTHOR_EMAIL).toBe('owner@example.test')
      expect(env.GIT_COMMITTER_NAME).toBe('Task Owner')
      expect(env.GIT_COMMITTER_EMAIL).toBe('owner@example.test')
    }
  })

  test('concurrent user tasks keep their own profile identity', async () => {
    const h = await setup()
    await seedUser(h.db, 'alice', 'Alice', 'alice@example.test')
    await seedUser(h.db, 'bob', 'Bob', 'bob@example.test')
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ out: 'ok' }),
        MOCK_OPENCODE_CAPTURE_ENV_TO: h.envLog,
      },
      async () => {
        const [taskA, taskB] = await Promise.all([
          launchWithoutEnv(h, 'parallel-a', 'alice'),
          launchWithoutEnv(h, 'parallel-b', 'bob'),
        ])
        expect([taskA.gitUserName, taskB.gitUserName].sort()).toEqual(['Alice', 'Bob'])

        const captured = readCaptured(h)
          .map((env) => ({
            authorName: env.GIT_AUTHOR_NAME,
            authorEmail: env.GIT_AUTHOR_EMAIL,
            committerName: env.GIT_COMMITTER_NAME,
            committerEmail: env.GIT_COMMITTER_EMAIL,
          }))
          .sort((a, b) => String(a.authorName).localeCompare(String(b.authorName)))
        expect(captured).toEqual([
          {
            authorName: 'Alice',
            authorEmail: 'alice@example.test',
            committerName: 'Alice',
            committerEmail: 'alice@example.test',
          },
          {
            authorName: 'Bob',
            authorEmail: 'bob@example.test',
            committerName: 'Bob',
            committerEmail: 'bob@example.test',
          },
        ])
      },
    )
  })

  test('explicit system-internal task keeps the nullable snapshot branch', async () => {
    const h = await setup()
    const task = await launch(h, 'internal')
    expect(task.gitUserName).toBeNull()
    expect(task.gitUserEmail).toBeNull()
  })

  test('child resolution inherits the parent snapshot after the owner profile changes', async () => {
    const h = await setup()
    await seedUser(h.db, 'alice', 'Parent Owner', 'parent@example.test')
    const parent = await launch(h, 'parent', 'alice')
    await h.db
      .update(users)
      .set({
        displayName: 'Later Display',
        gitName: 'Later Git Name',
        email: 'later@example.test',
        updatedAt: 2,
      })
      .where(eq(users.id, 'alice'))

    expect(
      await resolveTaskGitCommitIdentity({
        db: h.db,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        actorUserId: 'alice',
        callLaunch: {
          parentTaskId: parent.id,
          parentNodeRunId: 'node-run',
          invocationDepth: 1,
          frozenSnapshotJson: null,
          refClosureJson: null,
        },
      }),
    ).toEqual({ name: 'Parent Owner', email: 'parent@example.test' })
  })
})

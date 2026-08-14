// RFC-300 T14 — real Webhook dispatcher -> executor -> task driver -> terminal
// CAS -> owner release -> physical cleanup. No launch/cancel fake is injected.

import {
  WORKFLOW_SCHEMA_VERSION,
  gitUrlCacheKeyWith,
  parseGitUrl,
  type CodeHostEvent,
} from '@agent-workflow/shared'
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { buildActor } from '../src/auth/actor'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb } from '../src/db/client'
import {
  cachedRepos,
  tasks,
  webhookDeliveries,
  webhookEndpoints,
  webhookTriggerFires,
  webhookTriggers,
} from '../src/db/schema'
import { cancelExecution } from '../src/services/execution/executor'
import { finishClaimedWebhookWorkspacePrune } from '../src/services/gc'
import {
  registerTerminalWorkspacePruneEffect,
  registerTerminalWorkspacePrunePolicy,
  setTaskStatus,
} from '../src/services/lifecycle'
import { getTask, isTaskActive } from '../src/services/task'
import { createUser } from '../src/services/users'
import { createWebhookDispatcher } from '../src/services/webhook/webhookDispatch'
import { shouldRequestWebhookWorkspacePrune } from '../src/services/webhook/terminalWorkspaceCleanup'
import { createWorkflow } from '../src/services/workflow'
import { sha1Hex } from '../src/util/hash'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

setDefaultTimeout(30_000)

let currentRoot: string | null = null
let previousHome: string | undefined

afterEach(() => {
  registerTerminalWorkspacePrunePolicy(null)
  registerTerminalWorkspacePruneEffect(null)
  if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = previousHome
  previousHome = undefined
  if (currentRoot !== null) rmSync(currentRoot, { recursive: true, force: true })
  currentRoot = null
})

async function waitFor<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(20)
  }
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path })
  writeFileSync(join(path, 'README.md'), 'RFC-300\n')
  execFileSync('git', ['add', 'README.md'], { cwd: path })
  execFileSync(
    'git',
    [
      '-c',
      'user.name=RFC300',
      '-c',
      'user.email=rfc300@example.test',
      'commit',
      '-q',
      '-m',
      'base',
    ],
    { cwd: path },
  )
}

test('real Webhook remote/scratch done/canceled delete while failed/interrupted controls retain', async () => {
  currentRoot = mkdtempSync(join(tmpdir(), 'aw-rfc300-webhook-e2e-'))
  previousHome = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = currentRoot
  const configPath = join(currentRoot, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({ $schema_version: 1, webhookTaskWorkspaceAutoCleanup: true }),
  )

  const db = createInMemoryDb(MIGRATIONS)
  const box = createSecretBoxFromKey(Buffer.alloc(32, 30))
  const owner = await createUser(db, {
    username: 'rfc300-owner',
    displayName: 'RFC 300 Owner',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const actor = buildActor({
    user: {
      id: owner.id,
      username: owner.username,
      displayName: owner.displayName,
      role: owner.role,
      status: owner.status,
    },
    source: 'session',
  })
  const doneWorkflow = await createWorkflow(
    db,
    {
      name: 'rfc300-done',
      description: '',
      definition: {
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [],
        nodes: [
          {
            id: 'persisted',
            kind: 'script',
            language: 'bash',
            script: "printf 'persisted-output'",
            readonly: false,
          },
        ],
        edges: [],
      },
    },
    { ownerUserId: owner.id, actor },
  )
  const canceledWorkflow = await createWorkflow(
    db,
    {
      name: 'rfc300-canceled',
      description: '',
      definition: {
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [],
        nodes: [
          {
            id: 'slow',
            kind: 'script',
            language: 'bash',
            script: 'sleep 30',
            readonly: false,
          },
        ],
        edges: [],
      },
    },
    { ownerUserId: owner.id, actor },
  )
  const failedWorkflow = await createWorkflow(
    db,
    {
      name: 'rfc300-failed',
      description: '',
      definition: {
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [],
        nodes: [
          {
            id: 'fail',
            kind: 'script',
            language: 'bash',
            script: 'exit 7',
            readonly: false,
          },
        ],
        edges: [],
      },
    },
    { ownerUserId: owner.id, actor },
  )
  const interruptedWorkflow = await createWorkflow(
    db,
    {
      name: 'rfc300-interrupted',
      description: '',
      definition: {
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [],
        nodes: [
          {
            id: 'briefly-running',
            kind: 'script',
            language: 'bash',
            script: 'sleep 1',
            readonly: false,
          },
        ],
        edges: [],
      },
    },
    { ownerUserId: owner.id, actor },
  )

  const originRepo = join(currentRoot, 'origin-source')
  const sourceRepo = join(currentRoot, 'cached-source')
  initRepo(originRepo)
  execFileSync('git', ['clone', '-q', originRepo, sourceRepo])
  const repoUrl = pathToFileURL(originRepo).href
  const parsed = parseGitUrl(repoUrl)
  if (parsed === null) throw new Error('fixture URL did not parse')
  const cacheKey = gitUrlCacheKeyWith(parsed, sha1Hex)
  await db.insert(cachedRepos).values({
    id: 'cached-rfc300',
    urlHash: cacheKey.hash,
    urlEnc: box.seal(repoUrl),
    urlRedacted: repoUrl,
    localPath: sourceRepo,
    defaultBranch: 'main',
    lastFetchedAt: Date.now(),
    createdAt: Date.now(),
  })
  await db.insert(webhookEndpoints).values({
    id: 'endpoint-rfc300',
    name: 'RFC 300 endpoint',
    provider: 'gitlab',
    urlToken: 'aw_whk_rfc300',
    secretEnc: box.seal('webhook-secret'),
    enabled: true,
  })
  const endpoint = (
    await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, 'endpoint-rfc300'))
      .limit(1)
  )[0]!

  registerTerminalWorkspacePrunePolicy((row, to) =>
    shouldRequestWebhookWorkspacePrune(true, { ...row, to }),
  )
  registerTerminalWorkspacePruneEffect((effectDb, taskId) => {
    if (isTaskActive(taskId)) return
    void finishClaimedWebhookWorkspacePrune(effectDb, taskId)
  })

  const dispatcher = createWebhookDispatcher({
    db,
    configPath,
    secretBox: box,
    getDefaultRuntime: async () => null,
  })

  for (const [index, one] of (
    [
      { space: 'remote', terminal: 'done', workflowId: doneWorkflow.id },
      { space: 'remote', terminal: 'canceled', workflowId: canceledWorkflow.id },
      { space: 'scratch', terminal: 'done', workflowId: doneWorkflow.id },
      { space: 'scratch', terminal: 'canceled', workflowId: canceledWorkflow.id },
      { space: 'remote', terminal: 'failed', workflowId: failedWorkflow.id },
      { space: 'scratch', terminal: 'failed', workflowId: failedWorkflow.id },
      { space: 'scratch', terminal: 'interrupted', workflowId: interruptedWorkflow.id },
    ] as const
  ).entries()) {
    const triggerId = `trigger-rfc300-${index}`
    await db.insert(webhookTriggers).values({
      id: triggerId,
      name: `${one.space}-${one.terminal}`,
      endpointId: endpoint.id,
      ownerUserId: owner.id,
      repoScope: JSON.stringify({ kind: 'all' }),
      eventTypes: JSON.stringify(['pipeline_failed']),
      ignoreUsernames: JSON.stringify([]),
      launchKind: 'workflow',
      launchRefId: one.workflowId,
      launchPayload: JSON.stringify({
        inputs: {},
        ...(one.space === 'scratch' ? { scratch: true } : {}),
      }),
      autoRegisterRepos: false,
    })

    const event: CodeHostEvent = {
      provider: 'gitlab',
      eventUuid: ulid(),
      eventType: 'pipeline_failed',
      repoPath: 'platform/rfc300',
      repoHttpUrl: repoUrl,
      repoSshUrl: 'git@gitlab.example.test:platform/rfc300.git',
      branch: 'main',
      pipelineStatus: 'failed',
      author: { username: 'developer' },
      raw: {},
    }
    const deliveryId = ulid()
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      endpointId: endpoint.id,
      eventUuid: event.eventUuid,
      status: 'received',
      eventType: event.eventType,
      repoPath: event.repoPath,
    })
    await dispatcher.dispatch({ deliveryId, endpoint, event })

    const fire = await waitFor(async () => {
      const row = (
        await db
          .select()
          .from(webhookTriggerFires)
          .where(eq(webhookTriggerFires.triggerId, triggerId))
          .limit(1)
      )[0]
      return row ?? null
    }, `${one.space}/${one.terminal} Webhook launch`)
    expect({ outcome: fire.outcome, error: fire.error }).toEqual({
      outcome: 'launched',
      error: null,
    })
    expect(fire.taskId).not.toBeNull()
    const taskId = fire.taskId!

    if (one.terminal === 'canceled' || one.terminal === 'interrupted') {
      await waitFor(async () => {
        const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
        return row?.status === 'running' && isTaskActive(taskId) ? true : null
      }, `${one.space} task driver`)
      if (one.terminal === 'canceled') {
        await cancelExecution(db, taskId)
      } else {
        await setTaskStatus({
          db,
          taskId,
          to: 'interrupted',
          allowedFrom: ['running'],
          extra: { finishedAt: Date.now(), errorSummary: 'daemon restart fixture' },
          reason: 'rfc300-interrupted-control',
        })
        await waitFor(
          async () => (isTaskActive(taskId) ? null : true),
          `${one.space} interrupted driver settlement`,
        )
      }
    }

    if (one.terminal === 'failed' || one.terminal === 'interrupted') {
      const failed = await waitFor(async () => {
        const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
        return row?.status === one.terminal ? row : null
      }, `${one.space} ${one.terminal} control`)
      expect(failed.workspacePruningAt).toBeNull()
      expect(failed.workspacePruneCause).toBeNull()
      expect(failed.workspacePrunedAt).toBeNull()
      expect(existsSync(failed.worktreePath)).toBe(true)
      expect((await getTask(db, taskId))?.workspaceState).toBe('available')
      await db.delete(webhookTriggers).where(eq(webhookTriggers.id, triggerId))
      continue
    }

    const final = await waitFor(async () => {
      const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
      return row?.workspacePrunedAt === null || row?.workspacePrunedAt === undefined ? null : row
    }, `${one.space}/${one.terminal} workspace prune`)
    expect(final.status).toBe(one.terminal)
    expect(final.workspacePruningAt).not.toBeNull()
    expect(final.workspacePruneCause).toBe('webhook-terminal')
    expect(existsSync(final.worktreePath)).toBe(false)
    expect((await getTask(db, taskId))?.workspaceState).toBe('pruned')
    expect(final.workflowSnapshot).toContain(one.terminal === 'done' ? 'persisted' : 'slow')

    if (one.space === 'remote') {
      const registry = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: sourceRepo,
        encoding: 'utf8',
      })
      expect(registry).not.toContain(final.worktreePath)
    } else {
      expect(final.repoPath).toBe(final.worktreePath)
    }

    await db.delete(webhookTriggers).where(eq(webhookTriggers.id, triggerId))
  }
})

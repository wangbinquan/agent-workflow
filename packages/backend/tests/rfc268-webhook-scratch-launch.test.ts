// RFC-268 T5 — 走 webhook dispatcher 的真实 startExecution 收口，证明三种目标
// 都落成 RFC-165 scratch task：main 空根提交、空 tree、无 remote。这里不注入
// launch fake；若 dispatcher 只“长得像” scratch 而未接进物化层，本测试会红。
import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { isTerminalTaskStatus, type CodeHostEvent } from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb } from '../src/db/client'
import { tasks, webhookDeliveries, webhookEndpoints, webhookTriggers } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { cancelExecution } from '../src/services/execution/executor'
import { createRuntime } from '../src/services/runtimeRegistry'
import { createUser } from '../src/services/users'
import { createWebhookDispatcher } from '../src/services/webhook/webhookDispatch'
import { createWorkflow } from '../src/services/workflow'
import { createWorkgroup } from '../src/services/workgroups'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const RUNTIME = 'rfc268-opencode'

const AGENT_FIELDS = {
  description: '',
  outputs: [] as string[],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [] as string[],
  mcp: [] as string[],
  plugins: [] as string[],
  frontmatterExtra: {},
  bodyMd: 'do it',
  runtime: RUNTIME,
}

test('RFC-268 · workflow / agent / workgroup webhook fires create real empty scratch repos', async () => {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc268-webhook-'))
  const previousHome = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = appHome
  try {
    const configPath = join(appHome, 'config.json')
    writeFileSync(configPath, JSON.stringify({ $schema_version: 1 }))
    const db = createInMemoryDb(MIGRATIONS)
    await createRuntime(db, { name: RUNTIME, protocol: 'opencode', model: 'openai/gpt-5.6' })
    const owner = await createUser(db, {
      username: 'rfc268-owner',
      displayName: 'RFC 268 Owner',
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
    const workflow = await createWorkflow(
      db,
      {
        name: 'rfc268-workflow',
        description: '',
        definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] } as never,
      },
      { ownerUserId: owner.id, actor },
    )
    const agent = await createAgent(
      db,
      { ...AGENT_FIELDS, name: 'rfc268-agent' },
      {
        ownerUserId: owner.id,
        actor,
        executionPolicy: { defaultRuntime: RUNTIME },
      },
    )
    const workgroup = await createWorkgroup(
      db,
      {
        name: 'rfc268-workgroup',
        description: '',
        instructions: '',
        mode: 'leader_worker',
        leaderDisplayName: 'lead',
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 3,
        completionGate: false,
        members: [{ memberType: 'agent', agentId: agent.id, displayName: 'lead', roleDesc: '' }],
      },
      { ownerUserId: owner.id, actor },
    )

    const box = createSecretBoxFromKey(Buffer.alloc(32, 8))
    await db.insert(webhookEndpoints).values({
      id: 'ep-rfc268',
      name: 'RFC 268 endpoint',
      provider: 'gitlab',
      urlToken: 'aw_whk_rfc268',
      secretEnc: box.seal('secret'),
      enabled: true,
    })
    const endpoint = (
      await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, 'ep-rfc268')).limit(1)
    )[0]!
    const triggerRows = [
      {
        id: 'tr-rfc268-workflow',
        name: 'workflow scratch',
        launchKind: 'workflow' as const,
        launchRefId: workflow.id,
        launchPayload: { inputs: {}, scratch: true },
      },
      {
        id: 'tr-rfc268-agent',
        name: 'agent scratch',
        launchKind: 'agent' as const,
        launchRefId: agent.id,
        launchPayload: { description: 'handle {{repo_path}}', scratch: true },
      },
      {
        id: 'tr-rfc268-workgroup',
        name: 'workgroup scratch',
        launchKind: 'workgroup' as const,
        launchRefId: workgroup.id,
        launchPayload: { goal: 'handle {{repo_path}}', scratch: true },
      },
    ]
    for (const row of triggerRows) {
      await db.insert(webhookTriggers).values({
        id: row.id,
        name: row.name,
        endpointId: endpoint.id,
        ownerUserId: owner.id,
        repoScope: JSON.stringify({ kind: 'all' }),
        eventTypes: JSON.stringify(['pipeline_failed']),
        ignoreUsernames: JSON.stringify([]),
        launchKind: row.launchKind,
        launchRefId: row.launchRefId,
        launchPayload: JSON.stringify(row.launchPayload),
        autoRegisterRepos: false,
      })
    }

    const event: CodeHostEvent = {
      provider: 'gitlab',
      eventUuid: ulid(),
      eventType: 'pipeline_failed',
      repoPath: 'platform/api',
      repoHttpUrl: 'https://gitlab.invalid/platform/api.git',
      repoSshUrl: 'git@gitlab.invalid:platform/api.git',
      branch: 'feature/rfc268',
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
    const dispatcher = createWebhookDispatcher({
      db,
      configPath,
      secretBox: box,
      getDefaultRuntime: async () => RUNTIME,
    })
    await dispatcher.dispatch({ deliveryId, endpoint, event })

    const launched = await db.select().from(tasks)
    expect(launched).toHaveLength(3)
    expect(new Set(launched.map((task) => task.webhookTriggerId))).toEqual(
      new Set(triggerRows.map((row) => row.id)),
    )
    for (const task of launched) {
      expect(task.spaceKind).toBe('scratch')
      expect(task.repoPath).toBe(task.worktreePath)
      expect(
        execFileSync('git', ['-C', task.worktreePath, 'branch', '--show-current'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('main')
      expect(
        execFileSync('git', ['-C', task.worktreePath, 'rev-list', '--count', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('1')
      expect(
        execFileSync('git', ['-C', task.worktreePath, 'ls-tree', '--name-only', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('')
      expect(
        execFileSync('git', ['-C', task.worktreePath, 'remote'], { encoding: 'utf8' }).trim(),
      ).toBe('')
    }
    // workgroup 会异步进入首轮；测试收尾前显式取消，避免 finally 删除目录时让
    // 后台 runner 把清理竞态误报成 workspace-missing。
    for (const task of await db.select().from(tasks)) {
      if (isTerminalTaskStatus(task.status)) continue
      try {
        await cancelExecution(db, task.id)
      } catch (error) {
        // runner 可在 select 与 cancel 之间自行失败；只吞已经确认的终态竞态。
        const current = (await db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1))[0]
        if (current === undefined || !isTerminalTaskStatus(current.status)) throw error
      }
    }
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousHome
    rmSync(appHome, { recursive: true, force: true })
  }
})

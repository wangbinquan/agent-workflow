// RFC-223 PR-9 (T16) — cross-tenant same-name adversarial coverage.
//
// This suite deliberately exercises the real id-canonical consumers that were
// not already covered together:
//   - rename → same-name recreate → resume still runs the frozen agent id;
//   - fusion apply/restore mutates only the selected same-name skill id;
//   - MCP probe opens and persists only the requested same-name MCP id;
//   - review sibling resolution and deferred-dispatch override stamping use the
//     frozen agent id when two owners share one display name.
//
// Existing strong coverage is intentionally not duplicated:
//   - portable import 0/1/N + stale mapping: rfc223-import-refs.test.ts
//   - five-type transfer collision + workflow exception:
//     rfc223-owner-transfer.test.ts

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { docVersions, mcps, memories, nodeRuns, tasks, users, workflows } from '../src/db/schema'
import { __setProbeOptionsForTesting } from '../src/routes/mcps'
import { createApp } from '../src/server'
import { createAgent, renameAgent } from '../src/services/agent'
import {
  approveFusion,
  createFusion,
  getFusion,
  reconcileFusion,
  type FusionDeps,
} from '../src/services/fusion'
import type { ProbedMcpClient } from '../src/services/mcpProbe'
import { buildSiblingOutputsBlock } from '../src/services/review'
import { createManagedSkill, type SkillFsOptions } from '../src/services/skill'
import { getSkillVersionContent, restoreSkillVersion } from '../src/services/skillVersion'
import { buildFrontierMintPlan } from '../src/services/taskQuestionDispatch'
import { abortAllActiveTasks, getTask, resumeTask } from '../src/services/task'
import { runGit } from '../src/util/git'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const TOKEN = 'rfc223-pr9-token'
const TEST_TIMEOUT_MS = 30_000

setDefaultTimeout(TEST_TIMEOUT_MS)

const ADMIN_ACTOR: Actor = {
  user: {
    id: '__system__',
    username: '__system__',
    displayName: 'System',
    role: 'admin',
    status: 'active',
  },
  source: 'daemon',
  permissions: new Set(),
}

async function seedUser(db: DbClient, id: string): Promise<void> {
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
}

function agentInput(
  name: string,
  bodyMd: string,
  opts: {
    outputs?: string[]
    outputKinds?: Record<string, string>
    syncOutputsOnIterate?: boolean
  } = {},
) {
  return {
    name,
    description: '',
    outputs: opts.outputs ?? [],
    ...(opts.outputKinds === undefined ? {} : { outputKinds: opts.outputKinds }),
    syncOutputsOnIterate: opts.syncOutputsOnIterate ?? true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd,
  }
}

async function checkedGit(cwd: string, args: string[]): Promise<void> {
  const result = await runGit(cwd, args)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`)
  }
}

async function waitForTaskTerminal(db: DbClient, taskId: string): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const row = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get()
    if (row !== undefined && ['done', 'failed', 'canceled', 'interrupted'].includes(row.status)) {
      return row.status
    }
    await Bun.sleep(20)
  }
  throw new Error(`task '${taskId}' did not become terminal`)
}

function makeClarifyStub(dir: string): string {
  const path = join(dir, 'stub-opencode.sh')
  const clarifyBody =
    '{\\"questions\\":[{\\"id\\":\\"q1\\",\\"title\\":\\"Proceed?\\",\\"kind\\":\\"single\\",\\"options\\":[{\\"label\\":\\"yes\\"},{\\"label\\":\\"no\\"}]}]}</workflow-clarify>'
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then echo 'stub-opencode 1.14.99'; exit 0; fi
if [[ "$1" == "run" ]]; then
  NONCE=$(printf '%s\\n' "$@" | sed -n 's/.*nonce="\\([^"]*\\)".*/\\1/p' | head -n 1)
  OPEN='<workflow-clarify>'; if [[ -n "$NONCE" ]]; then OPEN='<workflow-clarify nonce=\\"'"$NONCE"'\\">'; fi
  ENV="$OPEN"'${clarifyBody}'
  TS=$(date +%s)
  printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$TS" "$ENV"
  exit 0
fi
exit 1
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

function approvedGlobalMemory(db: DbClient, title: string): string {
  const id = ulid()
  db.insert(memories)
    .values({
      id,
      scopeType: 'global',
      scopeId: null,
      title,
      bodyMd: `body of ${title}`,
      tags: '[]',
      status: 'approved',
      sourceKind: 'manual',
      createdAt: Date.now(),
      version: 1,
    })
    .run()
  return id
}

function fakeProbeClient(): ProbedMcpClient {
  return {
    serverInfo: { name: 'fake', version: '1.0' },
    protocolVersion: '2024-11-05',
    capabilities: {},
    listTools: async () => [{ name: 'selected-tool' }],
    listResources: async () => [],
    listResourceTemplates: async () => [],
    listPrompts: async () => [],
    capturedStderr: () => '',
    close: async () => {},
  }
}

async function apiReq(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

afterEach(() => {
  abortAllActiveTasks('rfc223-pr9-test-cleanup')
  __setProbeOptionsForTesting(undefined)
  resetBroadcastersForTests()
})

describe('RFC-223 PR-9 cross-tenant same-name adversarial suite', () => {
  test('rename + same-name recreate + resume executes the frozen agent id, never the replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc223-pr9-resume-'))
    const appHome = join(root, 'home')
    const repoPath = join(root, 'repo')
    const capturePath = join(root, 'captured-inline-config.json')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(repoPath, { recursive: true })

    const previousOutputs = process.env.MOCK_OPENCODE_OUTPUTS
    const previousCapture = process.env.MOCK_OPENCODE_CAPTURE_CONFIG_JSON_TO
    try {
      await checkedGit(repoPath, ['init', '-q', '-b', 'main'])
      await checkedGit(repoPath, ['config', 'user.email', 't@t.test'])
      await checkedGit(repoPath, ['config', 'user.name', 't'])
      writeFileSync(join(repoPath, 'README.md'), '# RFC-223 PR-9\n')
      await checkedGit(repoPath, ['add', '.'])
      await checkedGit(repoPath, ['commit', '-q', '-m', 'init'])

      const db = createInMemoryDb(MIGRATIONS)
      await seedUser(db, 'owner-a')
      await seedUser(db, 'owner-b')

      const original = await createAgent(
        db,
        agentInput('shared-runner', 'TENANT_A_PROMPT', { outputs: ['out'] }),
        { ownerUserId: 'owner-a' },
      )
      const definition: WorkflowDefinition = {
        $schema_version: 4,
        inputs: [],
        nodes: [
          {
            id: 'worker',
            kind: 'agent-single',
            agentId: original.id,
            agentName: 'shared-runner',
            promptTemplate: 'work',
          } as WorkflowNode,
        ],
        edges: [],
        outputs: [],
      }
      const workflowId = ulid()
      await db.insert(workflows).values({
        id: workflowId,
        name: 'frozen-id',
        definition: JSON.stringify(definition),
      })
      const taskId = ulid()
      await db.insert(tasks).values({
        id: taskId,
        name: 'frozen-id',
        workflowId,
        workflowSnapshot: JSON.stringify(definition),
        repoPath,
        worktreePath: repoPath,
        baseBranch: 'main',
        branch: `agent-workflow/${taskId}`,
        status: 'failed',
        inputs: '{}',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        sourceAgentName: 'shared-runner',
        sourceAgentId: original.id,
      })

      await renameAgent(db, original.id, { newName: 'renamed-runner' })
      const replacement = await createAgent(
        db,
        agentInput('shared-runner', 'TENANT_B_PROMPT', { outputs: ['out'] }),
        { ownerUserId: 'owner-b' },
      )
      expect(replacement.id).not.toBe(original.id)

      process.env.MOCK_OPENCODE_OUTPUTS = JSON.stringify({ out: 'done' })
      process.env.MOCK_OPENCODE_CAPTURE_CONFIG_JSON_TO = capturePath
      await resumeTask(db, taskId, {
        db,
        appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        defaultNodeRetries: 0,
        defaultPerNodeTimeoutMs: 5_000,
      })
      expect(await waitForTaskTerminal(db, taskId)).toBe('done')

      const config = JSON.parse(readFileSync(capturePath, 'utf-8')) as {
        agent?: Record<string, { prompt?: string }>
      }
      expect(config.agent?.['renamed-runner']?.prompt).toContain('TENANT_A_PROMPT')
      expect(config.agent?.['shared-runner']).toBeUndefined()
      expect(JSON.stringify(config)).not.toContain('TENANT_B_PROMPT')
    } finally {
      if (previousOutputs === undefined) delete process.env.MOCK_OPENCODE_OUTPUTS
      else process.env.MOCK_OPENCODE_OUTPUTS = previousOutputs
      if (previousCapture === undefined) {
        delete process.env.MOCK_OPENCODE_CAPTURE_CONFIG_JSON_TO
      } else {
        process.env.MOCK_OPENCODE_CAPTURE_CONFIG_JSON_TO = previousCapture
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('fusion apply and restore stay on the selected id when two owners share the skill name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc223-pr9-fusion-'))
    const appHome = join(root, 'home')
    const db = createInMemoryDb(MIGRATIONS)
    const deps: FusionDeps = {
      db,
      appHome,
      opencodeCmd: [makeClarifyStub(root)],
      awaitScheduler: true,
    }
    const fsOpts: SkillFsOptions = { appHome }

    try {
      await seedUser(db, 'owner-a')
      await seedUser(db, 'owner-b')
      const skillA = await createManagedSkill(
        db,
        fsOpts,
        {
          name: 'shared-skill',
          description: 'A',
          bodyMd: 'TENANT_A_SKILL',
          frontmatterExtra: {},
        },
        { ownerUserId: 'owner-a' },
      )
      const skillB = await createManagedSkill(
        db,
        fsOpts,
        {
          name: 'shared-skill',
          description: 'B',
          bodyMd: 'TENANT_B_SKILL',
          frontmatterExtra: {},
        },
        { ownerUserId: 'owner-b' },
      )
      const memoryId = approvedGlobalMemory(db, 'tenant-a-rule')

      const fusion = await createFusion(
        { skillId: skillA.id, memoryIds: [memoryId], intent: 'apply only to A' },
        deps,
        ADMIN_ACTOR,
      )
      expect(fusion.skillId).toBe(skillA.id)
      const task = await getTask(db, fusion.currentTaskId!)
      expect(task).not.toBeNull()
      const worktree = task!.worktreePath
      writeFileSync(
        join(worktree, 'SKILL.md'),
        '---\nname: shared-skill\ndescription: A\n---\nTENANT_A_FUSED',
      )
      mkdirSync(join(worktree, '__fusion__'), { recursive: true })
      writeFileSync(
        join(worktree, '__fusion__', 'result.json'),
        JSON.stringify({
          incorporatedMemoryIds: [memoryId],
          skipped: [],
          changelog: 'A only',
        }),
      )
      await db
        .update(tasks)
        .set({ status: 'done', finishedAt: Date.now() })
        .where(eq(tasks.id, task!.id))

      await reconcileFusion(deps, fusion.id)
      const ready = await getFusion(deps, fusion.id)
      expect(ready).toMatchObject({
        skillId: skillA.id,
        skillName: 'shared-skill',
        status: 'awaiting_approval',
      })
      const done = await approveFusion(deps, fusion.id, ADMIN_ACTOR)
      expect(done).toMatchObject({
        skillId: skillA.id,
        skillName: 'shared-skill',
        status: 'done',
        appliedSkillVersion: 2,
      })
      expect(getSkillVersionContent(db, fsOpts, skillA.id, 2).content.bodyMd).toContain(
        'TENANT_A_FUSED',
      )
      expect(getSkillVersionContent(db, fsOpts, skillB.id, 1).content.bodyMd).toContain(
        'TENANT_B_SKILL',
      )
      expect(
        await db
          .select({
            status: memories.status,
            skillId: memories.fusedIntoSkillId,
          })
          .from(memories)
          .where(eq(memories.id, memoryId))
          .get(),
      ).toEqual({ status: 'fused', skillId: skillA.id })

      restoreSkillVersion(db, fsOpts, skillA.id, 1, '__system__', 'PR-9 restore')
      expect(
        await db
          .select({
            status: memories.status,
            skillId: memories.fusedIntoSkillId,
          })
          .from(memories)
          .where(eq(memories.id, memoryId))
          .get(),
      ).toEqual({ status: 'approved', skillId: null })
      expect(getSkillVersionContent(db, fsOpts, skillB.id, 1).content.bodyMd).toContain(
        'TENANT_B_SKILL',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('admin probe opens and persists the selected same-name MCP id only', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'owner-a')
    await seedUser(db, 'owner-b')
    const mcpA = ulid()
    const mcpB = ulid()
    await db.insert(mcps).values({
      id: mcpA,
      name: 'shared-mcp',
      ownerUserId: 'owner-a',
      type: 'local',
      config: JSON.stringify({ command: ['tenant-a-command'] }),
    })
    await db.insert(mcps).values({
      id: mcpB,
      name: 'shared-mcp',
      ownerUserId: 'owner-b',
      type: 'local',
      config: JSON.stringify({ command: ['tenant-b-command'] }),
    })
    const app = createApp({
      token: TOKEN,
      configPath: '/tmp/aw-rfc223-pr9-config-never-used.json',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const detail = await apiReq(app, `/api/mcps/${mcpB}`)
    expect(detail.status).toBe(200)
    const expectedConfigHash = ((await detail.json()) as { operationConfigHash: string })
      .operationConfigHash
    const openedIds: string[] = []
    __setProbeOptionsForTesting({
      openClient: async (mcp) => {
        openedIds.push(mcp.id)
        return { client: fakeProbeClient(), handshakeMs: 1 }
      },
    })

    const probed = await apiReq(app, `/api/mcps/${mcpB}/probe`, {
      method: 'POST',
      body: JSON.stringify({ expectedConfigHash }),
    })
    expect(probed.status).toBe(200)
    expect(await probed.json()).toMatchObject({
      mcpId: mcpB,
      mcpName: 'shared-mcp',
      status: 'ok',
    })
    expect(openedIds).toEqual([mcpB])

    const selected = await apiReq(app, `/api/mcps/${mcpB}/probe`)
    expect(selected.status).toBe(200)
    expect(await selected.json()).toMatchObject({ mcpId: mcpB })
    const untouched = await apiReq(app, `/api/mcps/${mcpA}/probe`)
    expect(untouched.status).toBe(404)
    expect(await untouched.json()).toMatchObject({ code: 'probe-not-found' })

    const list = (await (await apiReq(app, '/api/mcps/probes')).json()) as Array<{
      mcpId: string
      mcpName: string
    }>
    expect(list).toEqual([expect.objectContaining({ mcpId: mcpB, mcpName: 'shared-mcp' })])
  })

  test('review sibling lookup follows the frozen id, not the first same-name agent row', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'owner-a')
    await seedUser(db, 'owner-b')
    // Insert B first so any accidental name+limit(1) lookup deterministically
    // selects the wrong tenant and makes this test red.
    await createAgent(
      db,
      agentInput('shared-reviewer', 'TENANT_B', {
        outputs: [],
        syncOutputsOnIterate: false,
      }),
      { ownerUserId: 'owner-b' },
    )
    const agentA = await createAgent(
      db,
      agentInput('shared-reviewer', 'TENANT_A', {
        outputs: ['proposal', 'design'],
        outputKinds: { proposal: 'markdown_file', design: 'markdown_file' },
        syncOutputsOnIterate: true,
      }),
      { ownerUserId: 'owner-a' },
    )
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'writer',
          kind: 'agent-single',
          agentId: agentA.id,
          agentName: 'shared-reviewer',
        } as WorkflowNode,
      ],
      edges: [],
      outputs: [],
    }
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'review-id-isolation',
      definition: JSON.stringify(definition),
    })
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 'review-id-isolation',
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: '/tmp/rfc223-review',
      worktreePath: '/tmp/rfc223-review',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'awaiting_review',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const reviewNodeRunId = ulid()
    await db.insert(nodeRuns).values({
      id: reviewNodeRunId,
      taskId,
      nodeId: 'review-proposal',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now(),
    })
    await db.insert(docVersions).values({
      id: ulid(),
      taskId,
      reviewNodeId: 'review-proposal',
      reviewNodeRunId,
      sourceNodeId: 'writer',
      sourcePortName: 'proposal',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'reviews/proposal.md',
      sourceFilePath: 'docs/proposal.md',
      createdAt: 1,
    })

    const block = await buildSiblingOutputsBlock({
      db,
      appHome: '/tmp/rfc223-review-home',
      taskId,
      upstreamNodeId: 'writer',
      targetPortName: 'design',
    })
    expect(block).toContain('- proposal: docs/proposal.md')
  })

  test('borrow/deferred-dispatch mint stamps the selected same-name target agent id', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'owner-a')
    await seedUser(db, 'owner-b')
    const agentA = await createAgent(db, agentInput('shared-member', 'A'), {
      ownerUserId: 'owner-a',
    })
    const agentB = await createAgent(db, agentInput('shared-member', 'B'), {
      ownerUserId: 'owner-b',
    })
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'home',
          kind: 'agent-single',
          agentId: agentA.id,
          agentName: 'shared-member',
        } as WorkflowNode,
        {
          id: 'target',
          kind: 'agent-single',
          agentId: agentB.id,
          agentName: 'shared-member',
        } as WorkflowNode,
      ],
      edges: [],
      outputs: [],
    }
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'borrow-id-isolation',
      definition: JSON.stringify(definition),
    })
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 'borrow-id-isolation',
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: '/tmp/rfc223-borrow',
      worktreePath: '/tmp/rfc223-borrow',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'home',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: 1,
      finishedAt: 2,
    })

    const plan = await buildFrontierMintPlan(
      db,
      taskId,
      'home',
      'target',
      'cross-clarify-answer',
      definition,
      undefined,
    )
    expect(plan.values.agentOverrideName).toBe('shared-member')
    expect(plan.values.agentOverrideId).toBe(agentB.id)
    expect(plan.values.agentOverrideId).not.toBe(agentA.id)
  })
})

// Regression lock for the "node-level model override silently dropped" bug.
//
// Pre-fix the canvas inspector saved `node.overrides.{model,variant,temperature}`
// onto every agent-single / agent-multi node, but services/scheduler.ts never
// read that field — both runNode() call sites omitted `overrides`. The runner
// accepted the field as dead code, so opencode always saw the agent's default
// model (and per-node tweaks were effectively a no-op).
//
// These tests assert the value the user typed in the inspector survives the
// scheduler → runner → env-var → subprocess hop. The mock-opencode writes one
// JSONL line per spawn into MOCK_OPENCODE_CAPTURE_CONFIG_TO; we read it back
// and compare against expectations.
//
// If a future refactor drops the override on the floor again, these tests go
// red — the captured `model` will fall back to agent's default (or undefined).

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { createRuntime, seedBuiltinRuntimes } from '../src/services/runtimeRegistry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  capturePath: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-override-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const capturePath = join(appHome, 'inline-config.jsonl')
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    capturePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgentWithDefaults(
  db: DbClient,
  name: string,
  outputs: string[],
  defaults: { model?: string; variant?: string; temperature?: number },
): Promise<void> {
  // RFC-113: the model/variant/temperature live on the agent's RUNTIME, not the
  // agent. Create a per-agent runtime carrying the defaults + point the agent at
  // it (the agent itself no longer stores model/variant/temperature).
  await seedBuiltinRuntimes(db)
  const runtimeName = `rt-${name}`
  await createRuntime(db, {
    name: runtimeName,
    protocol: 'opencode',
    model: defaults.model ?? null,
    variant: defaults.variant ?? null,
    temperature: defaults.temperature ?? null,
  })
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    runtime: runtimeName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify(inputs),
    startedAt: Date.now(),
  })
  return taskId
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

function readCapture(path: string): Array<{
  agent: string
  model: string | null
  variant: string | null
  temperature: number | null
}> {
  const text = readFileSync(path, 'utf-8')
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

describe("RFC-113: the agent's RUNTIME drives the model; node param overrides are IGNORED", () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('a node param override is IGNORED — the agent runtime model comes through (D3)', async () => {
    await seedAgentWithDefaults(h.db, 'writer', ['summary'], {
      model: 'anthropic/claude-haiku-4-5',
    })
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'requirement' },
        {
          id: 'w1',
          kind: 'agent-single',
          agentName: 'writer',
          // The exact shape the canvas inspector persists.
          overrides: {
            model: 'anthropic/claude-opus-4-7',
            variant: 'high',
            temperature: 0.4,
          },
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portName: 'requirement' },
          target: { nodeId: 'w1', portName: 'requirement' },
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def, { requirement: 'do it' })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_CAPTURE_CONFIG_TO: h.capturePath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    const rows = readCapture(h.capturePath)
    expect(rows.length).toBe(1)
    // RFC-113: the node override (opus/high/0.4) is IGNORED — the model/variant/
    // temperature come from the agent's RUNTIME (haiku, the seeded default).
    expect(rows[0]).toEqual({
      agent: 'writer',
      model: 'anthropic/claude-haiku-4-5',
      variant: null,
      temperature: null,
    })
  })

  test('the agent runtime model/variant/temperature flow to the opencode inline config', async () => {
    await seedAgentWithDefaults(h.db, 'writer', ['summary'], {
      model: 'anthropic/claude-haiku-4-5',
      variant: 'low',
      temperature: 0.1,
    })
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'requirement' },
        // No `overrides` field at all — agent defaults must come through.
        { id: 'w1', kind: 'agent-single', agentName: 'writer' },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portName: 'requirement' },
          target: { nodeId: 'w1', portName: 'requirement' },
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def, { requirement: 'do it' })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_CAPTURE_CONFIG_TO: h.capturePath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const rows = readCapture(h.capturePath)
    expect(rows.length).toBe(1)
    expect(rows[0]).toEqual({
      agent: 'writer',
      model: 'anthropic/claude-haiku-4-5',
      variant: 'low',
      temperature: 0.1,
    })
  })

  test('empty-string node overrides are ignored; the runtime model still comes through', async () => {
    await seedAgentWithDefaults(h.db, 'writer', ['summary'], {
      model: 'anthropic/claude-haiku-4-5',
    })
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'requirement' },
        {
          id: 'w1',
          kind: 'agent-single',
          agentName: 'writer',
          // Inspector writes '' when the user clears the field; the runner
          // would otherwise reject empty model strings — the scheduler must
          // drop them so agent defaults apply.
          overrides: { model: '', variant: '' },
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portName: 'requirement' },
          target: { nodeId: 'w1', portName: 'requirement' },
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def, { requirement: 'do it' })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_CAPTURE_CONFIG_TO: h.capturePath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const rows = readCapture(h.capturePath)
    expect(rows[0]?.model).toBe('anthropic/claude-haiku-4-5')
  })

  // RFC-060 PR-E: agent-multi removed; the per-shard-child overrides test is
  // no longer applicable. wrapper-fanout inner agents receive overrides
  // through the same agent-single path (covered by the agent-single override
  // test above) — see services/scheduler.ts:dispatchFanoutShard, which
  // forwards `pickOverrides(innerNode)` into `runNode(...)`.
})

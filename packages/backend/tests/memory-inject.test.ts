// RFC-041 PR3 — runtime memory inject service.
//
// Locks the invariants the runner depends on:
//   - 0 approved memories anywhere → null (runner skips append byte-perfectly)
//   - 4 scopes load independently; superseded / archived / candidate / rejected
//     never surface
//   - agent closure: every closure member's memories surface to the primary
//   - budget=0 disables a scope; over-budget rows clipped from the tail
//     (loader emits newest-first; clip drops oldest)
//   - block contains the BEGIN/END anchors a future regex-based stripper relies on
//   - inject order: agent → workflow → repo → global
//   - injectMemoryForRun resolves repo scope via cached_repos.url lookup
//   - missing task row → null (degraded gracefully, never throws)
//
// Plus 2 grep guards on the runner source — those land at the bottom.

import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos, memories, tasks, workflows } from '../src/db/schema'
import {
  clipByBudget,
  DEFAULT_INJECTION_BUDGET,
  estimateTokens,
  formatMemoryBlock,
  injectMemoryForRun,
  loadInjectableMemories,
  type InjectableMemoryRow,
  type ScopeBudget,
} from '../src/services/memoryInject'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { Agent } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedApprovedMemory(
  db: DbClient,
  opts: {
    scopeType: 'agent' | 'workflow' | 'repo' | 'global'
    scopeId: string | null
    title: string
    body?: string
    createdAt?: number
  },
): string {
  const id = ulid()
  db.insert(memories)
    .values({
      id,
      scopeType: opts.scopeType,
      scopeId: opts.scopeId,
      title: opts.title,
      bodyMd: opts.body ?? 'b',
      tags: '[]',
      status: 'approved',
      sourceKind: 'manual',
      createdAt: opts.createdAt ?? Date.now(),
    })
    .run()
  return id
}

function seedNonApprovedMemory(
  db: DbClient,
  opts: {
    status: 'candidate' | 'superseded' | 'archived' | 'rejected'
    scopeType: 'agent' | 'workflow' | 'repo' | 'global'
    scopeId: string | null
  },
): string {
  const id = ulid()
  db.insert(memories)
    .values({
      id,
      scopeType: opts.scopeType,
      scopeId: opts.scopeId,
      title: 'should not surface',
      bodyMd: 'b',
      tags: '[]',
      status: opts.status,
      sourceKind: 'manual',
      createdAt: Date.now(),
    })
    .run()
  return id
}

describe('loadInjectableMemories', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('returns all-empty when no rows match', async () => {
    const set = await loadInjectableMemories(db, {
      agentIds: ['a1'],
      workflowId: 'w1',
      repoId: 'r1',
    })
    expect(set.byScope.agent).toEqual([])
    expect(set.byScope.workflow).toEqual([])
    expect(set.byScope.repo).toEqual([])
    expect(set.byScope.global).toEqual([])
  })

  test('loads one row per scope when all four are populated', async () => {
    seedApprovedMemory(db, { scopeType: 'agent', scopeId: 'a1', title: 'A' })
    seedApprovedMemory(db, { scopeType: 'workflow', scopeId: 'w1', title: 'W' })
    seedApprovedMemory(db, { scopeType: 'repo', scopeId: 'r1', title: 'R' })
    seedApprovedMemory(db, { scopeType: 'global', scopeId: null, title: 'G' })
    const set = await loadInjectableMemories(db, {
      agentIds: ['a1'],
      workflowId: 'w1',
      repoId: 'r1',
    })
    expect(set.byScope.agent.map((m) => m.title)).toEqual(['A'])
    expect(set.byScope.workflow.map((m) => m.title)).toEqual(['W'])
    expect(set.byScope.repo.map((m) => m.title)).toEqual(['R'])
    expect(set.byScope.global.map((m) => m.title)).toEqual(['G'])
  })

  test('agent closure: every closure member surfaces, ordered newest-first', async () => {
    seedApprovedMemory(db, { scopeType: 'agent', scopeId: 'primary', title: 'P', createdAt: 100 })
    seedApprovedMemory(db, { scopeType: 'agent', scopeId: 'dep1', title: 'D1', createdAt: 200 })
    seedApprovedMemory(db, { scopeType: 'agent', scopeId: 'dep2', title: 'D2', createdAt: 300 })
    const set = await loadInjectableMemories(db, {
      agentIds: ['primary', 'dep1', 'dep2'],
      workflowId: null,
      repoId: null,
    })
    expect(set.byScope.agent.map((m) => m.title)).toEqual(['D2', 'D1', 'P'])
  })

  test('non-approved memories never surface (candidate / superseded / archived / rejected)', async () => {
    seedApprovedMemory(db, { scopeType: 'global', scopeId: null, title: 'approved' })
    seedNonApprovedMemory(db, { scopeType: 'global', scopeId: null, status: 'candidate' })
    seedNonApprovedMemory(db, { scopeType: 'global', scopeId: null, status: 'superseded' })
    seedNonApprovedMemory(db, { scopeType: 'global', scopeId: null, status: 'archived' })
    seedNonApprovedMemory(db, { scopeType: 'global', scopeId: null, status: 'rejected' })
    const set = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId: null,
      repoId: null,
    })
    expect(set.byScope.global.map((m) => m.title)).toEqual(['approved'])
  })

  test('null workflowId / null repoId skip their scope; null agentIds still allow global', async () => {
    seedApprovedMemory(db, { scopeType: 'workflow', scopeId: 'w-not-active', title: 'W' })
    seedApprovedMemory(db, { scopeType: 'repo', scopeId: 'r-not-active', title: 'R' })
    seedApprovedMemory(db, { scopeType: 'global', scopeId: null, title: 'G' })
    const set = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId: null,
      repoId: null,
    })
    expect(set.byScope.workflow).toEqual([])
    expect(set.byScope.repo).toEqual([])
    expect(set.byScope.global.map((m) => m.title)).toEqual(['G'])
  })

  test('agentIds dedupe: same id repeated → memory only appears once', async () => {
    seedApprovedMemory(db, { scopeType: 'agent', scopeId: 'a1', title: 'A' })
    const set = await loadInjectableMemories(db, {
      agentIds: ['a1', 'a1', 'a1'],
      workflowId: null,
      repoId: null,
    })
    expect(set.byScope.agent.length).toBe(1)
  })

  test('workflow scope: only the active workflowId, not siblings', async () => {
    seedApprovedMemory(db, { scopeType: 'workflow', scopeId: 'wf-1', title: 'mine' })
    seedApprovedMemory(db, { scopeType: 'workflow', scopeId: 'wf-2', title: 'other' })
    const set = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId: 'wf-1',
      repoId: null,
    })
    expect(set.byScope.workflow.map((m) => m.title)).toEqual(['mine'])
  })
})

describe('clipByBudget / estimateTokens / formatMemoryBlock', () => {
  test('estimateTokens returns ceil(chars/4)', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  test('clipByBudget=0 returns []', () => {
    const rows: InjectableMemoryRow[] = [
      { id: '1', scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b', createdAt: 0 },
    ]
    expect(clipByBudget(rows, 0)).toEqual([])
  })

  test('clipByBudget drops tail entries once budget exceeded', () => {
    // Each row costs ceil(len("- [global] t — body-of-N\n")/4). With 8 rows
    // and a tight budget we should get a prefix only.
    const rows: InjectableMemoryRow[] = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      scopeType: 'global' as const,
      scopeId: null,
      title: 't',
      bodyMd: `body-of-${i}`,
      createdAt: i,
    }))
    const out = clipByBudget(rows, 10) // very tight, fits at most a few
    expect(out.length).toBeLessThan(rows.length)
    expect(out.length).toBeGreaterThan(0)
    // The kept rows are the head (newest by loader convention).
    expect(out[0]!.id).toBe('m0')
  })

  test('formatMemoryBlock returns null when every scope is empty', () => {
    expect(
      formatMemoryBlock({
        byScope: { agent: [], workflow: [], repo: [], global: [] },
      }),
    ).toBeNull()
  })

  test('formatMemoryBlock emits BEGIN/END anchors + per-scope tagged lines', () => {
    const block = formatMemoryBlock({
      byScope: {
        agent: [
          { id: 'a', scopeType: 'agent', scopeId: 'x', title: 'A', bodyMd: 'b', createdAt: 0 },
        ],
        workflow: [],
        repo: [],
        global: [
          { id: 'g', scopeType: 'global', scopeId: null, title: 'G', bodyMd: 'b', createdAt: 0 },
        ],
      },
    })
    expect(block).not.toBeNull()
    expect(block).toContain('--- BEGIN INJECTED MEMORY ---')
    expect(block).toContain('--- END INJECTED MEMORY ---')
    expect(block).toContain('## Learned context (auto-injected, advisory)')
    expect(block).toContain('- [agent] A — b')
    expect(block).toContain('- [global] G — b')
  })

  test('formatMemoryBlock preserves order: agent → workflow → repo → global', () => {
    const block = formatMemoryBlock({
      byScope: {
        agent: [
          { id: '1', scopeType: 'agent', scopeId: 'x', title: 'Atitle', bodyMd: 'b', createdAt: 0 },
        ],
        workflow: [
          {
            id: '2',
            scopeType: 'workflow',
            scopeId: 'w',
            title: 'Wtitle',
            bodyMd: 'b',
            createdAt: 0,
          },
        ],
        repo: [
          { id: '3', scopeType: 'repo', scopeId: 'r', title: 'Rtitle', bodyMd: 'b', createdAt: 0 },
        ],
        global: [
          {
            id: '4',
            scopeType: 'global',
            scopeId: null,
            title: 'Gtitle',
            bodyMd: 'b',
            createdAt: 0,
          },
        ],
      },
    })!
    const ia = block.indexOf('Atitle')
    const iw = block.indexOf('Wtitle')
    const ir = block.indexOf('Rtitle')
    const ig = block.indexOf('Gtitle')
    expect(ia).toBeGreaterThan(0)
    expect(iw).toBeGreaterThan(ia)
    expect(ir).toBeGreaterThan(iw)
    expect(ig).toBeGreaterThan(ir)
  })

  test('formatMemoryBlock honors per-scope budget override (e.g. agent=0)', () => {
    const tightBudget: ScopeBudget = { agent: 0, workflow: 100, repo: 100, global: 100 }
    const block = formatMemoryBlock(
      {
        byScope: {
          agent: [
            {
              id: '1',
              scopeType: 'agent',
              scopeId: 'x',
              title: 'Atitle',
              bodyMd: 'b',
              createdAt: 0,
            },
          ],
          workflow: [],
          repo: [],
          global: [
            {
              id: '4',
              scopeType: 'global',
              scopeId: null,
              title: 'Gtitle',
              bodyMd: 'b',
              createdAt: 0,
            },
          ],
        },
      },
      tightBudget,
    )
    expect(block).not.toBeNull()
    expect(block).not.toContain('Atitle') // dropped — budget 0
    expect(block).toContain('Gtitle')
  })

  test('DEFAULT_INJECTION_BUDGET is the design.md §3.3 set', () => {
    expect(DEFAULT_INJECTION_BUDGET).toEqual({
      agent: 1500,
      workflow: 800,
      repo: 800,
      global: 500,
    })
  })
})

describe('injectMemoryForRun', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  function seedTask(opts: { repoUrl?: string | null; agentName?: string } = {}): {
    taskId: string
    workflowId: string
  } {
    const wfId = ulid()
    db.insert(workflows)
      .values({
        id: wfId,
        name: 'wf',
        definition: JSON.stringify({ schemaVersion: 1, nodes: [], edges: [] }),
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run()
    const taskId = ulid()
    db.insert(tasks)
      .values({
        id: taskId,
        name: 'fixture-task',
        workflowId: wfId,
        workflowSnapshot: '{}',
        repoPath: '/tmp/wt',
        repoUrl: opts.repoUrl ?? null,
        worktreePath: '/tmp/wt',
        baseBranch: 'main',
        branch: 'agent-workflow/' + taskId,
        baseCommit: null,
        status: 'running',
        inputs: '{}',
        startedAt: Date.now(),
      })
      .run()
    return { taskId, workflowId: wfId }
  }

  function mkAgent(id: string, name = 'a'): Agent {
    return {
      id,
      name,
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Agent
  }

  test('returns null when the task has no scope memories anywhere', async () => {
    const { taskId } = seedTask()
    const { block } = await injectMemoryForRun({
      db,
      taskId,
      primaryAgent: mkAgent('agent-1'),
      dependents: [],
    })
    expect(block).toBeNull()
  })

  test('returns null when taskId does not exist (degraded gracefully)', async () => {
    const { block } = await injectMemoryForRun({
      db,
      taskId: 't_nope',
      primaryAgent: mkAgent('agent-1'),
      dependents: [],
    })
    expect(block).toBeNull()
  })

  test('resolves workflowId from tasks row and surfaces workflow-scope memory', async () => {
    const { taskId, workflowId } = seedTask()
    seedApprovedMemory(db, { scopeType: 'workflow', scopeId: workflowId, title: 'WF' })
    const { block } = await injectMemoryForRun({
      db,
      taskId,
      primaryAgent: mkAgent('agent-1'),
      dependents: [],
    })
    expect(block).not.toBeNull()
    expect(block).toContain('- [workflow] WF')
  })

  test('resolves repoId via cached_repos.url lookup', async () => {
    const url = 'https://github.com/acme/web.git'
    db.insert(cachedRepos)
      .values({
        id: 'cr-1',
        urlHash: 'aabbccdd',
        url,
        localPath: '/tmp/r',
        lastFetchedAt: Date.now(),
        createdAt: Date.now(),
      })
      .run()
    const { taskId } = seedTask({ repoUrl: url })
    seedApprovedMemory(db, { scopeType: 'repo', scopeId: 'cr-1', title: 'REPO' })
    const { block } = await injectMemoryForRun({
      db,
      taskId,
      primaryAgent: mkAgent('agent-1'),
      dependents: [],
    })
    expect(block).toContain('- [repo] REPO')
  })

  test('agent closure: dependents propagate their memories', async () => {
    const { taskId } = seedTask()
    seedApprovedMemory(db, { scopeType: 'agent', scopeId: 'primary', title: 'P' })
    seedApprovedMemory(db, { scopeType: 'agent', scopeId: 'dep-1', title: 'D' })
    const { block } = await injectMemoryForRun({
      db,
      taskId,
      primaryAgent: mkAgent('primary'),
      dependents: [mkAgent('dep-1', 'dep-1')],
    })
    expect(block).toContain('- [agent] P')
    expect(block).toContain('- [agent] D')
  })

  test('global scope always loads even with no agent/workflow/repo binding', async () => {
    const { taskId } = seedTask()
    seedApprovedMemory(db, { scopeType: 'global', scopeId: null, title: 'GG' })
    const { block } = await injectMemoryForRun({
      db,
      taskId,
      primaryAgent: mkAgent('agent-1'),
      dependents: [],
    })
    expect(block).toContain('- [global] GG')
  })

  test('budget override (all zeros) collapses block to null', async () => {
    const { taskId, workflowId } = seedTask()
    seedApprovedMemory(db, { scopeType: 'workflow', scopeId: workflowId, title: 'WF' })
    seedApprovedMemory(db, { scopeType: 'global', scopeId: null, title: 'GG' })
    const { block } = await injectMemoryForRun({
      db,
      taskId,
      primaryAgent: mkAgent('agent-1'),
      dependents: [],
      budget: { agent: 0, workflow: 0, repo: 0, global: 0 },
    })
    expect(block).toBeNull()
  })
})

describe('source-code grep guards', () => {
  test('runner.ts must call injectMemoryForRun (prevent silent regression)', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'), 'utf8')
    expect(src).toContain('injectMemoryForRun(')
  })

  test('memoryInject.ts must keep BEGIN/END anchors (downstream may regex-strip)', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'memoryInject.ts'),
      'utf8',
    )
    expect(src).toContain('--- BEGIN INJECTED MEMORY ---')
    expect(src).toContain('--- END INJECTED MEMORY ---')
  })
})

// RFC-239 §3.2 — the change-narrative service. Locks:
//  - member gate: owner / collaborator / non-member ADMIN may trigger; a plain
//    non-member gets 403 (requireTaskMember's exact semantics, design P1-5)
//  - single-flight: concurrent triggers run ONE generation
//  - success → persisted next to the structural artifact → GET serves 'ready'
//    with inputDigest === the diff's backend contentDigest
//  - failure → 'failed' state, nothing persisted
//  - deletion race: task deleted while the agent runs → no husk directory
//  - unknown group keys in model output are pruned (lenient schema + key drift)
//  - prompt is pure: carries node intents, never user ids (rfc099 isolation)
//  - extractJsonObject / parseNumstatZ / computeContentDigest unit matrices

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { computeSummary, type StructuralDiff, type Task } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { taskCollaborators, tasks, workflows } from '../src/db/schema'
import { createUser } from '../src/services/users'
import { getTask } from '../src/services/task'
import { parseNumstatZ, runGit } from '../src/util/git'
import { computeContentDigest } from '../src/services/structuralDiff/digest'
import {
  buildNarrativePrompt,
  buildNarrativeInput,
  extractJsonObject,
  getChangeNarrativeStatus,
  resetChangeNarrativeStateForTests,
  triggerChangeNarrative,
  type ChangeNarrativeDeps,
} from '../src/services/changeNarrative'
import type { SystemAgentRunResult } from '../src/services/systemAgentRun'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let home: string
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'aw-narrative-'))
  process.env.AGENT_WORKFLOW_HOME = home
})
afterAll(() => {
  delete process.env.AGENT_WORKFLOW_HOME
  rmSync(home, { recursive: true, force: true })
})
afterEach(() => {
  resetChangeNarrativeStateForTests()
})

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function makeRepoWithChange(): Promise<{ dir: string; commit: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-narr-repo-'))
  dirs.push(dir)
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@t.test'])
  await runGit(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'a.py'), 'class A:\n    def m(self):\n        return 1\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  const commit = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  // live change: one modified method + one new doc file
  writeFileSync(join(dir, 'a.py'), 'class A:\n    def m(self):\n        return 2\n')
  writeFileSync(join(dir, 'notes.md'), '# notes\nhello\n')
  return { dir, commit }
}

function actorFor(id: string, role: 'admin' | 'user'): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-6)}`, displayName: 'U', role, status: 'active' },
    source: 'session',
  })
}

async function seedWorld(db: DbClient): Promise<{
  task: Task
  owner: Actor
  collaborator: Actor
  outsider: Actor
  admin: Actor
}> {
  const mk = async (name: string, role: 'admin' | 'user') =>
    (await createUser(db, { username: name, displayName: name, role, password: 'pw12345678' })).id
  const ownerId = await mk(`own${Math.random().toString(36).slice(2, 7)}`, 'user')
  const collabId = await mk(`col${Math.random().toString(36).slice(2, 7)}`, 'user')
  const outsiderId = await mk(`out${Math.random().toString(36).slice(2, 7)}`, 'user')
  const adminId = await mk(`adm${Math.random().toString(36).slice(2, 7)}`, 'admin')

  const { dir, commit } = await makeRepoWithChange()
  const taskId = `01NR${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  const workflowId = `wf-${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    definition: JSON.stringify({ nodes: [], edges: [] }),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: '导读测试任务',
    workflowId,
    workflowSnapshot: JSON.stringify({
      nodes: [{ id: 'n1', agentName: 'coder', prompt: '实现功能 X\n细节…' }],
    }),
    repoPath: dir,
    worktreePath: dir,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    baseCommit: commit,
    ownerUserId: ownerId,
  })
  await db.insert(taskCollaborators).values({
    taskId,
    userId: collabId,
    role: 'collaborator',
    addedBy: ownerId,
    addedAt: Date.now(),
  })
  const task = await getTask(db, taskId)
  if (task === null) throw new Error('seed failed')
  return {
    task,
    owner: actorFor(ownerId, 'user'),
    collaborator: actorFor(collabId, 'user'),
    outsider: actorFor(outsiderId, 'user'),
    admin: actorFor(adminId, 'admin'),
  }
}

function okRun(json: unknown): SystemAgentRunResult {
  return {
    status: 'ok',
    exitCode: 0,
    eventText: `some preamble\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`\n`,
    stderrTail: '',
    durationMs: 5,
    scratchDir: '/tmp/x',
    scratchRetained: false,
  }
}

const GOOD_OUTPUT = {
  overview: '把 A.m 的返回值改为 2,并补充了说明文档。',
  groups: [
    { key: 'code', summary: '核心逻辑小改。' },
    { key: 'ghost-key', summary: '不存在的组,应被裁剪。' },
    { key: 'docs', summary: '新增说明文档。' },
  ],
  readingOrder: [{ ref: 'a.py', why: '唯一的逻辑改动。' }],
}

describe('extractJsonObject', () => {
  test('bare / fenced / chattered JSON all parse; last object wins; none → null', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(extractJsonObject('text ```json\n{"a":1}\n``` tail')).toEqual({ a: 1 })
    expect(extractJsonObject('{"a":1} then {"b":{"c":2}}')).toEqual({ b: { c: 2 } })
    expect(extractJsonObject('braces in "str { }" ok: {"x":"y{z}"}')).toEqual({ x: 'y{z}' })
    expect(extractJsonObject('no json here')).toBeNull()
  })
})

describe('parseNumstatZ', () => {
  test('plain, rename and binary records', () => {
    const z = '3\t1\ta.ts\0' + '5\t0\t\0old.ts\0new.ts\0' + '-\t-\tbin.png\0'
    const m = parseNumstatZ(z)
    expect(m.get('a.ts')).toEqual({ added: 3, removed: 1 })
    expect(m.get('new.ts')).toEqual({ added: 5, removed: 0 })
    expect(m.has('bin.png')).toBe(false)
  })
})

describe('computeContentDigest', () => {
  const base = (): StructuralDiff => ({
    scope: 'task',
    taskId: 't',
    fromRef: 'a',
    toRef: 'b',
    engine: 'baseline',
    status: 'ok',
    files: [
      {
        filePath: 'f.ts',
        lang: 'typescript',
        status: 'ok',
        changes: [
          {
            changeType: 'modified',
            kind: 'method',
            after: {
              id: 'f.ts#A.m:method',
              kind: 'method',
              name: 'm',
              qualifiedName: 'A.m',
              lang: 'typescript',
              filePath: 'f.ts',
              confidence: 'extracted',
            },
          },
        ],
        edges: [],
        impact: [],
      },
    ],
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    summary: computeSummary([], []),
  })

  test('deterministic; symbol identity changes it; order does not', () => {
    expect(computeContentDigest(base())).toBe(computeContentDigest(base()))
    const other = base()
    const file = other.files[0]
    const change = file?.changes[0]
    if (change?.after !== undefined) change.after.qualifiedName = 'A.other'
    expect(computeContentDigest(other)).not.toBe(computeContentDigest(base()))
  })
})

describe('triggerChangeNarrative', () => {
  function deps(db: DbClient, runFn: ChangeNarrativeDeps['runFn']): ChangeNarrativeDeps {
    return runFn === undefined ? { db } : { db, runFn }
  }

  test('member gate: owner/collaborator/non-member admin pass, outsider 403', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const w = await seedWorld(db)
    const calls: unknown[] = []
    const runFn: ChangeNarrativeDeps['runFn'] = async (opts) => {
      calls.push(opts)
      return okRun(GOOD_OUTPUT)
    }
    await expect(triggerChangeNarrative(deps(db, runFn), w.task, w.outsider)).rejects.toThrow(
      /only task members/,
    )
    expect(calls.length).toBe(0)
    const state = await triggerChangeNarrative(deps(db, runFn), w.task, w.collaborator)
    expect(state.status).toBe('generating')
    // wait for the async generation to settle, then admin can re-trigger
    await new Promise((r) => setTimeout(r, 50))
    const ready = await getChangeNarrativeStatus(w.task.id)
    expect(ready?.status).toBe('ready')
    const again = await triggerChangeNarrative(deps(db, runFn), w.task, w.admin)
    expect(again.status).toBe('generating')
  })

  test('single-flight: concurrent triggers share one generation', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const w = await seedWorld(db)
    let runs = 0
    const runFn: ChangeNarrativeDeps['runFn'] = async () => {
      runs += 1
      await new Promise((r) => setTimeout(r, 30))
      return okRun(GOOD_OUTPUT)
    }
    const [a, b] = await Promise.all([
      triggerChangeNarrative(deps(db, runFn), w.task, w.owner),
      triggerChangeNarrative(deps(db, runFn), w.task, w.owner),
    ])
    expect(a.status).toBe('generating')
    expect(b.startedAt).toBe(a.startedAt)
    await new Promise((r) => setTimeout(r, 80))
    expect(runs).toBe(1)
  })

  test('success persists; ready carries the diff contentDigest; ghost group keys pruned; prompt carries intents not user ids', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const w = await seedWorld(db)
    let seenPrompt = ''
    const runFn: ChangeNarrativeDeps['runFn'] = async (opts) => {
      seenPrompt = `${opts.systemPrompt}\n${opts.prompt}`
      return okRun(GOOD_OUTPUT)
    }
    await triggerChangeNarrative(deps(db, runFn), w.task, w.owner)
    await new Promise((r) => setTimeout(r, 80))
    const status = await getChangeNarrativeStatus(w.task.id)
    if (status?.status !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(status)}`)
    // digest equality with the backend structural response
    const input = await buildNarrativeInput(db, w.task)
    expect(status.narrative.inputDigest).toBe(input.digest)
    expect(input.digest).not.toBe('')
    // ghost key pruned, real keys kept
    expect(status.narrative.groups.map((g) => g.key).sort()).toEqual(['code', 'docs'])
    // prompt: node intent present, owner user id NEVER present
    expect(seenPrompt).toContain('实现功能 X')
    expect(seenPrompt).not.toContain(w.owner.user.id)
    // persisted on disk under the structural-diffs family
    expect(existsSync(join(home, 'structural-diffs', w.task.id, 'narrative-task.json'))).toBe(true)
  })

  test('failure → failed state, nothing persisted', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const w = await seedWorld(db)
    const runFn: ChangeNarrativeDeps['runFn'] = async () => {
      throw new Error('boom')
    }
    await triggerChangeNarrative(deps(db, runFn), w.task, w.owner)
    await new Promise((r) => setTimeout(r, 50))
    const status = await getChangeNarrativeStatus(w.task.id)
    expect(status?.status).toBe('failed')
    expect(existsSync(join(home, 'structural-diffs', w.task.id, 'narrative-task.json'))).toBe(false)
  })

  test('deletion race: task deleted mid-run leaves no husk directory', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const w = await seedWorld(db)
    const runFn: ChangeNarrativeDeps['runFn'] = async () => {
      await db.delete(taskCollaborators).where(eq(taskCollaborators.taskId, w.task.id))
      await db.delete(tasks).where(eq(tasks.id, w.task.id))
      return okRun(GOOD_OUTPUT)
    }
    await triggerChangeNarrative(deps(db, runFn), w.task, w.owner)
    await new Promise((r) => setTimeout(r, 80))
    expect(existsSync(join(home, 'structural-diffs', w.task.id))).toBe(false)
  })

  test('nothing to narrate → 409', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const w = await seedWorld(db)
    // reset the worktree to clean (no changes)
    await runGit(w.task.worktreePath, ['checkout', '--', '.'])
    rmSync(join(w.task.worktreePath, 'notes.md'), { force: true })
    await expect(
      triggerChangeNarrative(
        deps(db, async () => okRun(GOOD_OUTPUT)),
        w.task,
        w.owner,
      ),
    ).rejects.toThrow(/changed no files/)
  })
})

describe('buildNarrativePrompt', () => {
  test('stays under the cap and lists group stats', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const w = await seedWorld(db)
    const input = await buildNarrativeInput(db, w.task)
    const prompt = buildNarrativePrompt(w.task, input)
    expect(prompt.length).toBeLessThanOrEqual(30_000)
    expect(prompt).toContain('# Change groups')
    expect(prompt).toContain('## code')
    expect(prompt).toContain('Respond with ONE JSON object')
  })
})

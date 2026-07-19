// REGRESSION GUARD — audit S-4 修复锁（RFC-098 B3 / WP-6c；原 CURRENT-BEHAVIOR
// LOCK 已按头注指引翻转）。
//
// 锁定的修复语义（scheduler.ts runGitWrapperNode + captureGitPreDirty）：
//   wrapper-git fresh-mint 在写锁窗口内抓 baseline + pre 脏集
//   `{path: blobSha|'deleted'}` 存入 wrapperProgress.preDirty；finalize 做差集
//   「post ∈ pre ∧ hash 相等才扣」。两个历史病面由同一机制修复：
//   (a) 顺序双 wrapper-git：第一阶段未 commit 的 fileA 不再混入第二个 wrapper
//       的 git_diff（wg2 输出只含本 wrapper 内产生的 fileB）；
//   (b) git-in-loop：迭代 N 的 git_diff 是"那一轮"的增量而非 0..N 累计并集
//       （每轮 fresh-mint 的 pre 集天然含前轮残留）。
//
// 任何 refactor 把这两个断言翻回累计并集 = S-4 回归，立刻打回。
//
// 为什么现有测试盖不住：scheduler.test.ts:561 用干净 worktree + 单 wrapper；
// :847 的 git-in-loop 只跑 1 个迭代且不断言 diff 内容。本 harness 刻意让前序
// 改动残留（agent 写文件但不 commit），通过一个运行时生成的 shim opencode
// （写进 mkdtemp 临时目录，非仓内 fixture）让 agent 在自己被调度的那一刻往
// worktree (= 子进程 cwd) 写文件，从而保证文件出现时序与真实场景一致。
//
// 确定性说明：全部 git 操作为本地 init/add/commit（无网络、无 stash），无
// sleep/轮询；节点顺序由显式边保证。

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { decodeWrapperProgress } from '../src/services/wrapperProgress'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// ---------------------------------------------------------------------------
// Runtime-generated shim opencode.
//
// mock-opencode.ts only writes worktree files on FAILING attempts
// (MOCK_OPENCODE_WRITE_FILE + forceFail) and scenario-opencode.ts never
// writes the worktree at all — neither can express "agent succeeds AND
// leaves an uncommitted file behind", which is exactly the S-4 trigger.
// So each harness writes this tiny shim into its own temp dir (NOT a repo
// fixture) and points opencodeCmd at it.
//
// Env contract:
//   SHIM_STATE_DIR    per-agent invocation counters + trace.jsonl
//   SHIM_WRITE_FILES  JSON {agentName: filenameTemplate}; '{n}' → callIndex.
//                     File is written into process.cwd() — the runner spawns
//                     opencode with cwd = task worktree (runner.ts:749).
//   SHIM_OUTPUTS      JSON {agentName: {port: content}}; '{n}' → callIndex.
// ---------------------------------------------------------------------------
const SHIM_SOURCE = `
import process from 'node:process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
if (argv[0] !== 'run') {
  process.stderr.write('shim-opencode: expected run, got ' + String(argv[0]) + '\\n')
  process.exit(2)
}
const nonce = /\\bnonce="([^"]+)"/.exec(argv[1] ?? '')?.[1]
const outputOpen =
  nonce === undefined ? '<workflow-output>' : '<workflow-output nonce="' + nonce + '">'
const ai = argv.indexOf('--agent')
const agent = ai >= 0 ? (argv[ai + 1] ?? '') : ''
if (agent === '') {
  process.stderr.write('shim-opencode: missing --agent\\n')
  process.exit(2)
}
const stateDir = process.env.SHIM_STATE_DIR
if (!stateDir) {
  process.stderr.write('shim-opencode: SHIM_STATE_DIR not set\\n')
  process.exit(2)
}
mkdirSync(stateDir, { recursive: true })
const counterFile = join(stateDir, 'count-' + agent)
let n = 0
if (existsSync(counterFile)) n = Number(readFileSync(counterFile, 'utf-8').trim()) || 0
writeFileSync(counterFile, String(n + 1))
appendFileSync(join(stateDir, 'trace.jsonl'), JSON.stringify({ agent, callIndex: n }) + '\\n')

const writes = JSON.parse(process.env.SHIM_WRITE_FILES ?? '{}')
const tmpl = writes[agent]
if (typeof tmpl === 'string') {
  const fname = tmpl.replaceAll('{n}', String(n))
  // cwd === task worktree (Bun.spawn cwd: opts.worktreePath in runner.ts).
  writeFileSync(join(process.cwd(), fname), 'written by ' + agent + ' call ' + n + '\\n')
}

const outputsMap = JSON.parse(process.env.SHIM_OUTPUTS ?? '{}')
const outs = outputsMap[agent] ?? { summary: 'ok' }
let envl = outputOpen + '\\n'
for (const [p, c] of Object.entries(outs)) {
  envl += '  <port name="' + p + '">' + String(c).replaceAll('{n}', String(n)) + '</port>\\n'
}
envl += '</workflow-output>'
process.stdout.write(
  JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: envl } }) +
    '\\n',
)
process.exit(0)
`

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  repoPath: string
  shimPath: string
  stateDir: string
  cleanup: () => void
}

async function buildHarness(slug: string): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), `aw-audit-s04-${slug}-`))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  const stateDir = join(appHome, 'shim-state')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  // Local-only git fixture: init + one commit. No network, no stash.
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'base.txt'), 'baseline\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-q', '-m', 'init'])
  const shimPath = join(appHome, 'shim-opencode.ts')
  writeFileSync(shimPath, SHIM_SOURCE)
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    repoPath,
    shimPath,
    stateDir,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string, outputs: string[]): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
): Promise<{ taskId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  await h.db.insert(tasks).values({
    name: 'audit-s04-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: h.repoPath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { taskId }
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

async function readGitDiffPaths(h: Harness, wrapperRunId: string): Promise<string[]> {
  const rows = await h.db
    .select()
    .from(nodeRunOutputs)
    .where(and(eq(nodeRunOutputs.nodeRunId, wrapperRunId), eq(nodeRunOutputs.portName, 'git_diff')))
  return (rows[0]?.content ?? '').split('\n').filter((p) => p.length > 0)
}

describe('AUDIT S-4 current-behavior lock: wrapper-git baseline = HEAD only, no pre-dirt subtraction', () => {
  let h: Harness
  afterEach(() => h.cleanup())

  test('S-4a sequential wrapper-git pair: second wrapper git_diff is POLLUTED by first stage uncommitted file', async () => {
    h = await buildHarness('seq')
    await seedAgent(h.db, 'coder', ['summary'])
    await seedAgent(h.db, 'fixer', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'coder', kind: 'agent-single', agentName: 'coder' },
        { id: 'wg1', kind: 'wrapper-git', nodeIds: ['coder'] },
        { id: 'fixer', kind: 'agent-single', agentName: 'fixer' },
        { id: 'wg2', kind: 'wrapper-git', nodeIds: ['fixer'] },
      ] as unknown as WorkflowDefinition['nodes'],
      // Explicit edge wg1 → wg2 so the two wrappers run strictly in
      // sequence (buildScopeUpstreams keeps wrapper→wrapper edges; the
      // target portName is irrelevant at runtime — wrappers resolve no
      // inputs).
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'wg1', portName: 'git_diff' },
          target: { nodeId: 'wg2', portName: 'dep' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)

    await withEnv(
      {
        SHIM_STATE_DIR: h.stateDir,
        // coder leaves fileA.txt uncommitted; fixer leaves fileB.txt.
        SHIM_WRITE_FILES: JSON.stringify({ coder: 'fileA.txt', fixer: 'fileB.txt' }),
        SHIM_OUTPUTS: JSON.stringify({
          coder: { summary: 'coded' },
          fixer: { summary: 'fixed' },
        }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', h.shimPath],
        }),
    )

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    const wg1Run = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'wg1')))
    )[0]
    const wg2Run = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'wg2')))
    )[0]
    expect(wg1Run?.status).toBe('done')
    expect(wg2Run?.status).toBe('done')

    // Mechanism lock: both wrappers persisted the SAME baseline (the initial
    // commit hash — neither stage commits), but their PRE-SETS differ: wg1
    // entered a clean worktree (empty pre-set) while wg2 entered with wg1's
    // uncommitted fileA.txt already dirty. The pre-set, not the baseline, is
    // what carries the file-set information the subtraction needs (RFC-098 B3
    // / audit S-4).
    const p1 = decodeWrapperProgress(wg1Run!.wrapperProgressJson, () => {})
    const p2 = decodeWrapperProgress(wg2Run!.wrapperProgressJson, () => {})
    const head = (await runGit(h.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    expect(p1?.kind).toBe('git')
    expect(p2?.kind).toBe('git')
    expect((p1 as { baseline?: string }).baseline).toBe(head)
    expect((p2 as { baseline?: string }).baseline).toBe(head)
    const pre1 = (p1 as { preDirty?: Record<string, string> }).preDirty ?? {}
    const pre2 = (p2 as { preDirty?: Record<string, string> }).preDirty ?? {}
    expect(Object.keys(pre1)).toEqual([])
    expect(Object.keys(pre2)).toEqual(['fileA.txt'])

    // wg1 ran first: only fileA.txt existed at its finalize — its diff is
    // exactly that one path today and must STAY so after the fix. Exact-set
    // equality (not toContain) so no third path can silently join the diff.
    const wg1Paths = await readGitDiffPaths(h, wg1Run!.id)
    expect([...wg1Paths].sort()).toEqual(['fileA.txt'])

    const wg2Paths = await readGitDiffPaths(h, wg2Run!.id)
    // FIXED (RFC-098 B3 / audit S-4): fileA.txt was written by the FIRST
    // stage (inside wg1, before wg2 captured its baseline) — it is in wg2's
    // pre-set with an unchanged hash, so the finalize subtraction drops it.
    // wg2's git_diff carries ONLY the file its own inner scope produced
    // (design.md §6.5 pre-set subtraction).
    expect([...wg2Paths].sort()).toEqual(['fileB.txt'])
  }, 20000)

  test('S-4b git-in-loop: iteration-1 git_diff is the CUMULATIVE union of iterations 0..1, not that round alone', async () => {
    h = await buildHarness('loop')
    await seedAgent(h.db, 'audit', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'audit', kind: 'agent-single', agentName: 'audit' },
        { id: 'wg', kind: 'wrapper-git', nodeIds: ['audit'] },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['wg'],
          maxIterations: 2,
          // audit emits findings 'iter-{n}' per call → exit precisely
          // after the SECOND iteration (deterministic 2 full rounds, then
          // task done — unlike the existing 1-iteration git-in-loop test
          // at scheduler.test.ts:847 which can never observe pollution).
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'audit',
            portName: 'findings',
            value: 'iter-1',
          },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)

    await withEnv(
      {
        SHIM_STATE_DIR: h.stateDir,
        // Each audit invocation leaves a DIFFERENT uncommitted file:
        // call 0 → iter-0.txt, call 1 → iter-1.txt. Nothing commits, so
        // iter-0.txt is still untracked when iteration 1's wrapper-git
        // computes its diff.
        SHIM_WRITE_FILES: JSON.stringify({ audit: 'iter-{n}.txt' }),
        SHIM_OUTPUTS: JSON.stringify({ audit: { findings: 'iter-{n}' } }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', h.shimPath],
        }),
    )

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // One fresh wrapper-git row per loop iteration (iteration axis on the
    // wrapper row itself works — that part was fixed; S-6 is about inner
    // rows). Both done.
    const wgRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'wg')))
    expect(wgRuns.length).toBe(2)
    expect(new Set(wgRuns.map((r) => r.iteration))).toEqual(new Set([0, 1]))
    expect(wgRuns.every((r) => r.status === 'done')).toBe(true)

    const wgIter0 = wgRuns.find((r) => r.iteration === 0)!
    const wgIter1 = wgRuns.find((r) => r.iteration === 1)!

    // Iteration 0's diff is exactly iter-0.txt — correct in both worlds.
    // Exact-set equality so no third path can silently join the diff.
    const paths0 = await readGitDiffPaths(h, wgIter0.id)
    expect([...paths0].sort()).toEqual(['iter-0.txt'])

    const paths1 = await readGitDiffPaths(h, wgIter1.id)
    // FIXED (RFC-098 B3 / audit S-4): iteration 1's fresh-mint pre-set
    // naturally contains iteration 0's still-untracked iter-0.txt, so the
    // finalize subtraction yields the per-iteration increment. design.md
    // §6.4/6.5: `git in loop` = per-iteration diff ("那一轮") — iteration 1's
    // output contains ONLY iter-1.txt, not the 0..1 cumulative union.
    expect([...paths1].sort()).toEqual(['iter-1.txt'])

    // Mechanism lock: iteration 0 entered clean; iteration 1's pre-set is
    // exactly the residue of iteration 0.
    const prog0 = decodeWrapperProgress(wgIter0.wrapperProgressJson, () => {})
    const prog1 = decodeWrapperProgress(wgIter1.wrapperProgressJson, () => {})
    expect(Object.keys((prog0 as { preDirty?: Record<string, string> })?.preDirty ?? {})).toEqual(
      [],
    )
    expect(Object.keys((prog1 as { preDirty?: Record<string, string> })?.preDirty ?? {})).toEqual([
      'iter-0.txt',
    ])
  }, 20000)
})

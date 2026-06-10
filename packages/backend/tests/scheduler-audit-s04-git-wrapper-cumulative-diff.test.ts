// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-4 (WP-6c)
//
// 当前缺陷行为（本文件锁定的就是它）：
//   wrapper-git 进入时只记 baseline = `git rev-parse HEAD`（scheduler.ts
//   captureHead, :3176-3184），完全不抓 pre-existing 脏文件集；输出 git_diff =
//   `git diff --name-only <baseline>` + 全部 untracked 无条件并入
//   （util/git.ts gitChangedFiles, :627-667）。design.md §6.5 要求的 pre_diff
//   扣除未实现。后果两面：
//   (a) 顺序双 wrapper-git：第一阶段 agent 写了 fileA 不 commit，第二个
//       wrapper 的 git_diff 把 fileA 一并混入（应只含本 wrapper 内产生的
//       fileB）——下游 fan-out 分片集合失真；
//   (b) git-in-loop：迭代 N 的 git_diff 是 0..N 的累计并集而非"那一轮"的
//       增量，loop 第 2 轮起输出语义直接错。
//
// 正确语义：每个 wrapper-git 的 git_diff 只应包含**该 wrapper 执行期间**新产生
// /修改的路径（进入时抓 pre 文件集，输出时做差集；见报告建议修法）。
//
// 修复落点：WP-6c（pre_diff 扣除 + git-in-loop 每轮独立 diff）。修复落地时本
// 文件应翻红——按各断言旁 [FLIP-ON-FIX] 注释翻转期望值即可改造成回归防护。
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
let envl = '<workflow-output>\\n'
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

async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  readonly: boolean,
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    readonly,
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
    await seedAgent(h.db, 'coder', ['summary'], false)
    await seedAgent(h.db, 'fixer', ['summary'], false)
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

    // Mechanism lock: both wrappers persisted the SAME baseline — the
    // initial commit hash. The baseline carries no file-set information,
    // which is exactly why pre-existing dirt cannot be subtracted.
    // [FLIP-ON-FIX] when WP-6c lands a pre file-set (or stash snapshot) in
    // wrapperProgress, extend this to assert the pre-set differs between
    // the two wrappers (wg2's pre-set must contain fileA.txt).
    const p1 = decodeWrapperProgress(wg1Run!.wrapperProgressJson, () => {})
    const p2 = decodeWrapperProgress(wg2Run!.wrapperProgressJson, () => {})
    const head = (await runGit(h.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    expect(p1?.kind).toBe('git')
    expect(p2?.kind).toBe('git')
    expect((p1 as { baseline?: string }).baseline).toBe(head)
    expect((p2 as { baseline?: string }).baseline).toBe(head)

    // wg1 ran first: only fileA.txt existed at its finalize — its diff is
    // exactly that one path today and must STAY so after the fix. Exact-set
    // equality (not toContain) so no third path can silently join the diff.
    const wg1Paths = await readGitDiffPaths(h, wg1Run!.id)
    expect([...wg1Paths].sort()).toEqual(['fileA.txt'])

    const wg2Paths = await readGitDiffPaths(h, wg2Run!.id)
    // ⟵ THE DEFECT: fileB.txt was written inside wg2 (correct in both
    // worlds), but fileA.txt was written by the FIRST stage (inside wg1,
    // before wg2 even captured its baseline) — yet it appears in wg2's
    // git_diff because the untracked scan is unconditional and the
    // baseline is just a commit hash.
    // Correct semantics (design.md §6.5 pre_diff subtraction): wg2's
    // git_diff must contain ONLY fileB.txt.
    // [FLIP-ON-FIX] WP-6c: change to expect([...wg2Paths].sort()).toEqual(['fileB.txt'])
    expect([...wg2Paths].sort()).toEqual(['fileA.txt', 'fileB.txt'])
  }, 20000)

  test('S-4b git-in-loop: iteration-1 git_diff is the CUMULATIVE union of iterations 0..1, not that round alone', async () => {
    h = await buildHarness('loop')
    await seedAgent(h.db, 'audit', ['findings'], false)
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
    // ⟵ THE DEFECT: iter-1.txt belongs to iteration 1 (correct in both
    // worlds), but iteration 1's git_diff degenerates into the cumulative
    // 0..1 union because the baseline is still the same HEAD commit and
    // iter-0.txt is still untracked. design.md §6.4/6.5 says `git in loop`
    // = per-iteration diff ("那一轮"), so iteration 1's output must contain
    // ONLY iter-1.txt.
    // [FLIP-ON-FIX] WP-6c: change to expect([...paths1].sort()).toEqual(['iter-1.txt'])
    expect([...paths1].sort()).toEqual(['iter-0.txt', 'iter-1.txt'])
  }, 20000)
})

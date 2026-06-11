// RFC-098 B3 (audit S-4, 对抗检视修订 #9) — git wrapper pre-dirty 差集的
// hash 语义 oracle。
//
// 修订 #9 裁决：「post ∈ pre ∧ hash 相等才扣」是正确语义（与 git 状态语义一
// 致），并点名钉死「pre-dirty 改又改回 → 不出现在 git_diff」。本文件在一个
// harness 里同时锁四个方向：
//
//   fileA.txt  pre-dirty，inner 重写成**完全相同**内容（改又改回的终态等价
//              形态）→ hash 相等 → 扣除，不出现在 git_diff；
//   fileC.txt  pre-dirty，inner 重写成**不同**内容 → hash 不等 → 保留
//              （「wrapper 内又改过的文件保留」——按纯路径扣除会丢真改动，
//              修订 #9 明令否决的降级方向）；
//   fileD.txt  进入前被删除（tracked deletion），inner 不碰 → pre 'deleted'
//              ∧ post 'deleted'（哨兵按状态比较）→ 扣除；
//   fileE.txt  进入前被删除，inner 把它**重建**→ pre 'deleted' ∧ post 有
//              内容 → 状态不等 → 保留；
//   fileB.txt  inner 新建（不在 pre 集）→ 保留。
//
// 期望 git_diff 恰为 [fileB, fileC, fileE]——精确集合相等，防任何第三路径
// 静默混入/丢失。
//
// 时序：pre-dirt 由测试在 runTask 之前直接落盘（wrapper 是图中第一个节点，
// 进入时这些改动必然已存在）；inner 写文件经 runtime-shim（s04 同款手法，
// 但 shim 支持显式内容控制——hash 语义必须能写"相同内容"）。
// 确定性：本地 git、无网络、无 sleep。

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { decodeWrapperProgress } from '../src/services/wrapperProgress'
import { DELETED_BLOB_SENTINEL, gitBlobHashes, runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// Runtime-generated shim opencode（s04 同款骨架；SHIM_WRITES 提供显式
// per-agent {filename: content} 写入控制，'__DELETE__' 哨兵表示删除）。
const SHIM_SOURCE = `
import process from 'node:process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const ai = argv.indexOf('--agent')
const agent = ai >= 0 ? (argv[ai + 1] ?? '') : ''
const writes = JSON.parse(process.env.SHIM_WRITES ?? '{}')[agent] ?? {}
for (const [fname, content] of Object.entries(writes)) {
  if (content === '__DELETE__') {
    try { unlinkSync(join(process.cwd(), fname)) } catch {}
  } else {
    writeFileSync(join(process.cwd(), fname), String(content))
  }
}
const outs = JSON.parse(process.env.SHIM_OUTPUTS ?? '{}')[agent] ?? { summary: 'ok' }
let envl = '<workflow-output>\\n'
for (const [p, c] of Object.entries(outs)) {
  envl += '  <port name="' + p + '">' + String(c) + '</port>\\n'
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
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc098-predirty-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'base.txt'), 'baseline\n')
  writeFileSync(join(worktreePath, 'fileD.txt'), 'doomed\n')
  writeFileSync(join(worktreePath, 'fileE.txt'), 'phoenix\n')
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
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
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

describe('RFC-098 B3 (S-4) — pre-dirty 差集按 blob hash / deleted 哨兵判定', () => {
  let h: Harness
  afterEach(() => h.cleanup())

  test('改又改回不出现；改过的保留；重建的保留；持续删除扣除；新文件保留', async () => {
    h = await buildHarness()
    await h.db.insert(agents).values({
      id: ulid(),
      name: 'writer',
      description: 'test',
      outputs: JSON.stringify(['summary']),
      readonly: false,
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
    })
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'w', kind: 'agent-single', agentName: 'writer' },
        { id: 'wg', kind: 'wrapper-git', nodeIds: ['w'] },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const workflowId = ulid()
    const taskId = ulid()
    await h.db.insert(workflows).values({
      id: workflowId,
      name: 'wf',
      definition: JSON.stringify(def),
    })
    await h.db.insert(tasks).values({
      name: 'rfc098-predirty-task',
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(def),
      repoPath: h.repoPath,
      worktreePath: h.worktreePath,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
    })

    // ---- pre-entry dirt（wrapper 进入前已存在的脏改动）。----
    writeFileSync(join(h.worktreePath, 'fileA.txt'), 'SAME\n') // untracked
    writeFileSync(join(h.worktreePath, 'fileC.txt'), 'old-c\n') // untracked
    unlinkSync(join(h.worktreePath, 'fileD.txt')) // tracked deletion（持续）
    unlinkSync(join(h.worktreePath, 'fileE.txt')) // tracked deletion（将被重建）
    const preHashA = (await gitBlobHashes(h.worktreePath, ['fileA.txt']))['fileA.txt']!

    await withEnv(
      {
        SHIM_WRITES: JSON.stringify({
          writer: {
            'fileA.txt': 'SAME\n', // 改又改回（终态与进入时 hash 相等）
            'fileC.txt': 'new-c\n', // wrapper 内真实改写
            'fileB.txt': 'brand new\n', // wrapper 内新建
            'fileE.txt': 'reborn\n', // pre-deleted 被重建
          },
        }),
        SHIM_OUTPUTS: JSON.stringify({ writer: { summary: 'ok' } }),
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
    const wgRun = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'wg')))
    )[0]!
    expect(wgRun.status).toBe('done')

    // 机制锁：pre 集恰为进入时的四个脏路径；删除态记哨兵、存在态记 blob sha。
    const progress = decodeWrapperProgress(wgRun.wrapperProgressJson, () => {})
    const preDirty = (progress as { preDirty?: Record<string, string> })?.preDirty ?? {}
    expect(Object.keys(preDirty).sort()).toEqual([
      'fileA.txt',
      'fileC.txt',
      'fileD.txt',
      'fileE.txt',
    ])
    expect(preDirty['fileD.txt']).toBe(DELETED_BLOB_SENTINEL)
    expect(preDirty['fileE.txt']).toBe(DELETED_BLOB_SENTINEL)
    expect(preDirty['fileA.txt']).toBe(preHashA)

    // 行为锁：git_diff 精确等于「wrapper 内真实产生/改写/重建」的路径集。
    const outs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(and(eq(nodeRunOutputs.nodeRunId, wgRun.id), eq(nodeRunOutputs.portName, 'git_diff')))
    const paths = (outs[0]?.content ?? '').split('\n').filter((p) => p.length > 0)
    expect([...paths].sort()).toEqual(['fileB.txt', 'fileC.txt', 'fileE.txt'])
  }, 20000)
})

// gitBlobHashes 纯 util 面：哨兵 + 批量 hash 的最小锁（S-4 机制的底座）。
describe('RFC-098 B3 (S-4) — gitBlobHashes', () => {
  let h: Harness
  afterEach(() => h.cleanup())

  test('存在文件 → blob sha（与 git hash-object 一致）；缺失文件 → deleted 哨兵', async () => {
    h = await buildHarness()
    writeFileSync(join(h.worktreePath, 'x.txt'), 'xx\n')
    const m = await gitBlobHashes(h.worktreePath, ['x.txt', 'ghost.txt'])
    const expected = (await runGit(h.worktreePath, ['hash-object', '--', 'x.txt'])).stdout.trim()
    expect(m['x.txt']).toBe(expected)
    expect(m['ghost.txt']).toBe(DELETED_BLOB_SENTINEL)
  })
})

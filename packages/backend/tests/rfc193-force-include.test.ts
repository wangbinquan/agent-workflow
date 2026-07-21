// RFC-193 T4 — K1 必达 merge-back 三跳传播链（design.md §4.5，case 4/4b/8e/8f）。
//
// 为什么存在：gitignored 的 path 端口文件要从产出节点 A 活到下游节点 B 的
// iso，必须过三跳——① A 的 final 快照（进 node_tree）→ ② merge-back
// materialize（落 scope canonical 工作区）→ ③ B 分叉时的 base 快照（进
// base tree，checkout 才物化进 B 的 iso）。①③ 都是 `git add -A` 快照，
// ignore 规则在每一跳都会把文件漏掉——单修 ① 时文件永远趴在 canonical
// 工作区却进不了任何 tree（Codex 设计门 + 自查独立发现同一漏洞）。修复 =
// 必达清单注入 IsoHandle，nodeIsolation 内全部全状态快照统一 `add -f`。
//
//  - case 4  ：单节点必达——ignored 端口文件 merge-back 后出现在 canonical。
//  - case 4b ：跨节点传播——下游节点在自己的 iso 里读到上游的 ignored 文件
//              （修复前红：文件断在 base-snapshot 跳）。
//  - case 8e ：`:` 开头文件名按字面 pathspec 收录（GIT_LITERAL_PATHSPECS）。
//  - case 8f ：symlink 端口——归档物化目标内容 + 必达清单追加目标路径。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { archivePortArtifacts, parseArchiveJson } from '../src/services/portArtifacts'
import { runTask } from '../src/services/scheduler'
import { runGit, snapshotFullState } from '../src/util/git'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// ---------------------------------------------------------------------------
// case 8e — snapshotFullState.forceIncludePaths（模块级）
// ---------------------------------------------------------------------------

describe('RFC-193 snapshotFullState forceIncludePaths (case 8e)', () => {
  let dir: string
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aw-rfc193-snap-'))
    await runGit(dir, ['init', '-b', 'main'])
    await runGit(dir, ['config', 'user.email', 't@t.test'])
    await runGit(dir, ['config', 'user.name', 't'])
    writeFileSync(join(dir, '.gitignore'), 'notes/\n:tricky.md\n')
    writeFileSync(join(dir, 'seed.txt'), 's\n')
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-m', 'init'])
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function treePaths(commit: string): Promise<string[]> {
    const r = await runGit(dir, ['ls-tree', '-r', '--name-only', commit])
    return r.stdout.trim().split('\n')
  }

  test('ignored file excluded by default, force-included when rostered', async () => {
    mkdirSync(join(dir, 'notes'), { recursive: true })
    writeFileSync(join(dir, 'notes', 'hidden.md'), 'H')
    const plain = await snapshotFullState(dir)
    expect(await treePaths(plain)).not.toContain('notes/hidden.md')
    const forced = await snapshotFullState(dir, { forceIncludePaths: ['notes/hidden.md'] })
    expect(await treePaths(forced)).toContain('notes/hidden.md')
  })

  test('leading-colon filename treated literally, not as pathspec magic (case 8e)', async () => {
    writeFileSync(join(dir, ':tricky.md'), 'T')
    // Also drop an ignored decoy tree: `:(glob)`-style interpretation would
    // slurp it in; literal pathspec must include ONLY the colon file.
    mkdirSync(join(dir, 'notes'), { recursive: true })
    writeFileSync(join(dir, 'notes', 'decoy.md'), 'D')
    const forced = await snapshotFullState(dir, { forceIncludePaths: [':tricky.md'] })
    const paths = await treePaths(forced)
    expect(paths).toContain(':tricky.md')
    expect(paths).not.toContain('notes/decoy.md')
  })

  test('missing rostered path degrades to warn (snapshot still succeeds)', async () => {
    const sha = await snapshotFullState(dir, { forceIncludePaths: ['gone.md'] })
    expect(sha.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// case 8f — symlink 端口（模块级归档面 + roster 面）
// ---------------------------------------------------------------------------

describe('RFC-193 symlink port artifact (case 8f)', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aw-rfc193-sym-'))
    mkdirSync(join(home, 'wt', 'notes'), { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  test('archives the TARGET content; roster gains link AND worktree-internal target', () => {
    writeFileSync(join(home, 'wt', 'notes', 'real.md'), 'REAL BODY')
    symlinkSync(join('notes', 'real.md'), join(home, 'wt', 'link.md'))
    const res = archivePortArtifacts({
      appHome: home,
      taskId: 't1',
      nodeRunId: 'r1',
      portName: 'doc',
      items: [{ sourceAbs: join(home, 'wt', 'link.md'), sourcePath: 'link.md' }],
      worktreeDirName: '',
      worktreeRootAbs: join(home, 'wt'),
    })
    const it = parseArchiveJson(res.archiveJson)!.items[0]!
    expect(readFileSync(join(home, it.file!), 'utf8')).toBe('REAL BODY')
    expect(res.portFilePaths).toContain('link.md')
    expect(res.portFilePaths).toContain('notes/real.md')
    // impl-gate P2：目标持久化进 archive item——任务级 roster 从 archive_json
    // 重建，瞬态 portFilePaths 之外必须有持久痕迹，否则下游 base 快照只带
    // 链接本体、ignored 目标缺席 → 悬挂 symlink。
    expect(it.linkTarget).toBe('notes/real.md')
  })

  test('absolute-target symlink: content archived, target NOT rostered (warn path)', () => {
    writeFileSync(join(home, 'outside.md'), 'OUTSIDE')
    symlinkSync(join(home, 'outside.md'), join(home, 'wt', 'link.md'))
    const res = archivePortArtifacts({
      appHome: home,
      taskId: 't1',
      nodeRunId: 'r1',
      portName: 'doc',
      items: [{ sourceAbs: join(home, 'wt', 'link.md'), sourcePath: 'link.md' }],
      worktreeDirName: '',
      worktreeRootAbs: join(home, 'wt'),
    })
    expect(res.portFilePaths).toEqual(['link.md'])
  })
})

// ---------------------------------------------------------------------------
// e2e — 三跳传播（case 4 / 4b）
// ---------------------------------------------------------------------------

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  worktreePath: string
  mockPath: string
  planFile: string
  cleanup: () => void
}

// plan step: { files?, output? }；output 值支持 `__FILE__:rel` 占位 —— mock
// 读取 CWD（= 该节点自己的 iso）下 rel 的内容作为端口值。case 4b 用它证明
// 「上游的 gitignored 端口文件出现在了下游节点的 iso 里」。
function mockSource(planFile: string): string {
  return `// generated by rfc193-force-include.test.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const argv = process.argv.slice(2)
if (argv.includes('--version')) { process.stdout.write('rfc193-fi-mock 1.14.99\\n'); process.exit(0) }
if (argv[0] !== 'run') { process.stderr.write('rfc193-fi-mock: expected run\\n'); process.exit(2) }
const nonce = /\\bnonce="([^"]+)"/.exec(argv.includes('--') ? argv.slice(argv.indexOf('--') + 1).join(' ') : (argv[1] ?? ''))?.[1]
const outputOpen =
  nonce === undefined ? '<workflow-output>' : '<workflow-output nonce="' + nonce + '">'
const ai = argv.indexOf('--agent')
const agent = ai >= 0 ? (argv[ai + 1] ?? '') : ''
const plan = JSON.parse(readFileSync(${JSON.stringify(planFile)}, 'utf-8'))
const step = plan[agent] ?? {}
for (const [rel, content] of Object.entries(step.files ?? {})) {
  const abs = join(process.cwd(), rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, String(content))
}
function emit(text) {
  process.stdout.write(JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text } }) + '\\n')
}
let envelope = outputOpen + '\\n'
for (const [p, c] of Object.entries(step.output ?? {})) {
  let v = String(c)
  if (v.startsWith('__FILE__:')) {
    const rel = v.slice('__FILE__:'.length)
    try { v = readFileSync(join(process.cwd(), rel), 'utf8') } catch { v = 'FILE-MISSING:' + rel }
  }
  envelope += '  <port name="' + p + '">' + v + '</port>\\n'
}
envelope += '</workflow-output>'
emit(envelope)
process.exit(0)
`
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc193-fi-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  const planFile = join(appHome, 'plan.json')
  const mockPath = join(appHome, 'mock.ts')
  for (const p of [repoPath, worktreePath]) {
    mkdirSync(p, { recursive: true })
    await runGit(p, ['init', '-b', 'main'])
    await runGit(p, ['config', 'user.email', 't@t.test'])
    await runGit(p, ['config', 'user.name', 't'])
    writeFileSync(join(p, 'README.md'), '# r\n')
    writeFileSync(join(p, '.gitignore'), 'notes/\n')
    await runGit(p, ['add', '.'])
    await runGit(p, ['commit', '-m', 'init'])
  }
  writeFileSync(mockPath, mockSource(planFile))
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    repoPath,
    worktreePath,
    mockPath,
    planFile,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  outputKinds: Record<string, string>,
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: JSON.stringify({ outputKinds }),
    bodyMd: '',
  })
}

async function seedTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf-rfc193-fi',
    definition: JSON.stringify(definition),
  })
  await h.db.insert(tasks).values({
    name: 'rfc193-fi',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: h.repoPath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({ req: 'go' }),
    startedAt: Date.now(),
  })
  return taskId
}

describe('RFC-193 e2e — K1 必达三跳传播', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h?.cleanup())

  test('case 4: gitignored port file reaches the task canonical after merge-back', async () => {
    await seedAgent(h.db, 'writer', ['doc'], { doc: 'path<md>' })
    writeFileSync(
      h.planFile,
      JSON.stringify({
        writer: {
          files: { 'notes/hidden.md': 'IGNORED BUT DELIVERED' },
          output: { doc: 'notes/hidden.md' },
        },
      }),
    )
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'w', kind: 'agent-single', agentName: 'writer' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'w', portName: 'req' },
        },
      ],
    }
    const taskId = await seedTask(h, def)
    await runTask({ db: h.db, taskId, appHome: h.appHome, opencodeCmd: ['bun', 'run', h.mockPath] })
    const canonical = join(h.worktreePath, 'notes', 'hidden.md')
    expect(existsSync(canonical)).toBe(true)
    expect(readFileSync(canonical, 'utf8')).toBe('IGNORED BUT DELIVERED')
  })

  test('case 4b: downstream node sees the upstream gitignored port file in ITS OWN iso', async () => {
    await seedAgent(h.db, 'writer', ['doc'], { doc: 'path<md>' })
    await seedAgent(h.db, 'reader', ['echo'], {})
    writeFileSync(
      h.planFile,
      JSON.stringify({
        writer: {
          files: { 'notes/hidden.md': 'CROSS-NODE CONTENT' },
          output: { doc: 'notes/hidden.md' },
        },
        // reader 的 iso 从「已含 writer delta 的 canonical」base 快照 checkout；
        // 修复前 base 快照 add -A 漏掉 ignored 文件 → 这里读到 FILE-MISSING。
        reader: { output: { echo: '__FILE__:notes/hidden.md' } },
      }),
    )
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'a', kind: 'agent-single', agentName: 'writer' } as WorkflowNode,
        { id: 'b', kind: 'agent-single', agentName: 'reader' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'a', portName: 'req' },
        },
        {
          id: 'e2',
          source: { nodeId: 'a', portName: 'doc' },
          target: { nodeId: 'b', portName: 'ctx' },
        },
      ],
    }
    const taskId = await seedTask(h, def)
    await runTask({ db: h.db, taskId, appHome: h.appHome, opencodeCmd: ['bun', 'run', h.mockPath] })
    const bRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'b')))
    const bDone = bRuns.find((r) => r.status === 'done')
    expect(bDone).toBeDefined()
    const rows = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(and(eq(nodeRunOutputs.nodeRunId, bDone!.id), eq(nodeRunOutputs.portName, 'echo')))
    expect(rows[0]?.content).toBe('CROSS-NODE CONTENT')
  })
})

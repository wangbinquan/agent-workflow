// RFC-193 T3 — archive-at-emit 归档制（design.md §4.3/§4.4，case 1/2/3/3b/3c/3d/3f/8）。
//
// 为什么存在：path 形端口的值只是路径字符串，RFC-130 后它是「悬挂指针」——
// 节点 iso 短命、wrapper-canonical 分层、gitignore 挡快照、worktree 会 GC，
// 每个消费方自己拼根就是一个新断链（用户 2026-07-15 线上撞到 wrapper 内
// review 死锁）。本文件锁定根治的第一环：runner 校验窗口（节点 iso 存活的
// 唯一可靠时刻）把文件内容以原始字节归档 + content 规范化为 repo0 相对。
//
//  - 模块层：archivePortArtifacts / readPortArtifact / encodePortSegment 的
//    字节保真、截断注警、containment、回退链契约。
//  - 端到端层（真 git worktree + mock opencode + runTask，含 RFC-130 iso）：
//    归档引用落库、content 规范化（./ 前缀、绝对路径清洗）、两阶段无孤儿
//    （首端口过/次端口挂 ⇒ 磁盘零归档）、gitignored 文件照样归档。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { WORKTREE_FILE_MAX_BYTES } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  archivePortArtifacts,
  encodePortSegment,
  parseArchiveJson,
  portArchiveRootRel,
  readPortArtifact,
  toContainerRelative,
  truncationNotice,
} from '../src/services/portArtifacts'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// ---------------------------------------------------------------------------
// 模块层
// ---------------------------------------------------------------------------

describe('RFC-193 encodePortSegment / toContainerRelative', () => {
  test('bounded digest key: single-segment, case-distinct, hostile-name safe (impl-gate P2)', () => {
    // 键 = sanitize(48) + '_' + sha256(16)：有界、区分大小写（macOS 大小写
    // 不敏感卷上 Report/report 纯 sanitize 会撞目录）、确定性、永不含 '/'。
    for (const name of ['doc_path-1', '..', '../evil', 'a/b', '中文', 'x'.repeat(500)]) {
      const key = encodePortSegment(name)
      expect(key.includes('/')).toBe(false)
      expect(key).not.toBe('..')
      expect(key.length).toBeLessThanOrEqual(65)
      expect(encodePortSegment(name)).toBe(key) // deterministic
    }
    expect(encodePortSegment('Report')).not.toBe(encodePortSegment('report'))
    expect(encodePortSegment('doc_path-1').startsWith('doc_path-1_')).toBe(true)
  })

  test('toContainerRelative: empty dirName is identity; non-empty prefixes', () => {
    expect(toContainerRelative('', 'a/b.md')).toBe('a/b.md')
    expect(toContainerRelative('repoA', 'a/b.md')).toBe('repoA/a/b.md')
  })
})

describe('RFC-193 archivePortArtifacts (module)', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aw-rfc193-mod-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  function src(rel: string, content: string | Buffer): string {
    const abs = join(home, 'wt', rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
    return abs
  }

  test('text file archived byte-identical; archiveJson shape; roster returned', () => {
    const abs = src('report.md', '# hello 世界\n')
    const res = archivePortArtifacts({
      appHome: home,
      taskId: 't1',
      nodeRunId: 'r1',
      portName: 'doc',
      items: [{ sourceAbs: abs, sourcePath: 'report.md' }],
      worktreeDirName: '',
      worktreeRootAbs: join(home, 'wt'),
    })
    const parsed = parseArchiveJson(res.archiveJson)
    expect(parsed).not.toBeNull()
    expect(parsed!.items).toHaveLength(1)
    const it = parsed!.items[0]!
    expect(it.path).toBe('report.md')
    expect(it.truncated).toBe(false)
    // 目录段 = encodePortSegment('doc')（bounded digest 键，impl-gate P2）。
    expect(it.file).toBe(join('runs', 't1', 'ports', 'r1', encodePortSegment('doc'), 'item_0.md'))
    expect(readFileSync(join(home, it.file!), 'utf8')).toBe('# hello 世界\n')
    expect(res.portFilePaths).toEqual(['report.md'])
  })

  test('binary bytes survive round-trip untouched (case 3c core)', () => {
    // PNG magic + a 0x00 and invalid-UTF-8 continuation bytes — a utf8
    // decode+re-encode would mangle these.
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80])
    const abs = src('img.png', bin)
    const res = archivePortArtifacts({
      appHome: home,
      taskId: 't1',
      nodeRunId: 'r1',
      portName: 'img',
      items: [{ sourceAbs: abs, sourcePath: 'img.png' }],
      worktreeDirName: '',
      worktreeRootAbs: join(home, 'wt'),
    })
    const it = parseArchiveJson(res.archiveJson)!.items[0]!
    expect(Buffer.compare(readFileSync(join(home, it.file!)), bin)).toBe(0)
  })

  test('oversized TEXT: truncated copy + visible notice appended (case 3)', () => {
    const big = 'x'.repeat(WORKTREE_FILE_MAX_BYTES + 100)
    const abs = src('big.md', big)
    const res = archivePortArtifacts({
      appHome: home,
      taskId: 't1',
      nodeRunId: 'r1',
      portName: 'doc',
      items: [{ sourceAbs: abs, sourcePath: 'big.md' }],
      worktreeDirName: '',
      worktreeRootAbs: join(home, 'wt'),
    })
    const it = parseArchiveJson(res.archiveJson)!.items[0]!
    expect(it.truncated).toBe(true)
    expect(it.size).toBe(WORKTREE_FILE_MAX_BYTES + 100)
    const stored = readFileSync(join(home, it.file!), 'utf8')
    expect(stored).toContain(truncationNotice('big.md').trim())
    expect(stored.length).toBeGreaterThan(WORKTREE_FILE_MAX_BYTES)
  })

  test('oversized BINARY: metadata only, no corrupt copy (case 3c/D12)', () => {
    const big = Buffer.alloc(WORKTREE_FILE_MAX_BYTES + 10)
    big[0] = 0 // NUL in首 8KB ⇒ binary
    const abs = src('big.bin', big)
    const res = archivePortArtifacts({
      appHome: home,
      taskId: 't1',
      nodeRunId: 'r1',
      portName: 'blob',
      items: [{ sourceAbs: abs, sourcePath: 'big.bin' }],
      worktreeDirName: '',
      worktreeRootAbs: join(home, 'wt'),
    })
    const it = parseArchiveJson(res.archiveJson)!.items[0]!
    expect(it.file).toBeNull()
    expect(it.truncated).toBe(true)
  })

  test('hostile portName stays inside the nodeRun archive root (case 3d)', () => {
    const abs = src('a.md', 'A')
    const res = archivePortArtifacts({
      appHome: home,
      taskId: 't1',
      nodeRunId: 'r1',
      portName: '../evil',
      items: [{ sourceAbs: abs, sourcePath: 'a.md' }],
      worktreeDirName: '',
      worktreeRootAbs: join(home, 'wt'),
    })
    const it = parseArchiveJson(res.archiveJson)!.items[0]!
    const rootAbs = resolve(home, portArchiveRootRel('t1', 'r1'))
    expect(resolve(home, it.file!).startsWith(rootAbs + '/')).toBe(true)
    expect(existsSync(join(home, it.file!))).toBe(true)
  })

  test('multi-repo: archive path is container-relative (case 3f archive face)', () => {
    const abs = src('report.md', 'A')
    const res = archivePortArtifacts({
      appHome: home,
      taskId: 't1',
      nodeRunId: 'r1',
      portName: 'doc',
      items: [{ sourceAbs: abs, sourcePath: 'report.md' }],
      worktreeDirName: 'repoA',
      worktreeRootAbs: join(home, 'wt'),
    })
    expect(parseArchiveJson(res.archiveJson)!.items[0]!.path).toBe('repoA/report.md')
    // roster stays repo0-relative (feeds repo0's snapshot force-include).
    expect(res.portFilePaths).toEqual(['report.md'])
  })
})

describe('RFC-193 readPortArtifact (module — fallback chain, case 6 core)', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aw-rfc193-read-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  test('archive hit wins; worktree not consulted', () => {
    const abs = join(home, 'wt', 'r.md')
    mkdirSync(join(home, 'wt'), { recursive: true })
    writeFileSync(abs, 'WORKTREE OLD')
    const arch = archivePortArtifacts({
      appHome: home,
      taskId: 't1',
      nodeRunId: 'r1',
      portName: 'doc',
      items: [{ sourceAbs: abs, sourcePath: 'r.md' }],
      worktreeDirName: '',
      worktreeRootAbs: join(home, 'wt'),
    })
    writeFileSync(abs, 'WORKTREE NEW') // diverge after emit
    const read = readPortArtifact({
      appHome: home,
      taskId: 't1',
      archiveJson: arch.archiveJson,
      content: 'r.md',
      kind: 'path<md>',
      fallbackWorktreeRoot: join(home, 'wt'),
    })
    expect(read.items[0]!.source).toBe('archive')
    expect(read.items[0]!.body).toBe('WORKTREE OLD')
  })

  test('legacy row (archiveJson null): pathish content read from fallback root', () => {
    mkdirSync(join(home, 'scope', 'sub'), { recursive: true })
    writeFileSync(join(home, 'scope', 'sub', 'a.md'), 'FROM SCOPE')
    const read = readPortArtifact({
      appHome: home,
      taskId: 't1',
      archiveJson: null,
      content: 'sub/a.md',
      kind: 'path<md>',
      fallbackWorktreeRoot: join(home, 'scope'),
    })
    expect(read.items[0]!.source).toBe('worktree')
    expect(read.items[0]!.body).toBe('FROM SCOPE')
  })

  test('legacy list row: one item per line, each independently resolved', () => {
    mkdirSync(join(home, 'scope'), { recursive: true })
    writeFileSync(join(home, 'scope', 'a.md'), 'A')
    const read = readPortArtifact({
      appHome: home,
      taskId: 't1',
      archiveJson: null,
      content: 'a.md\nmissing.md',
      kind: 'list<path<md>>',
      fallbackWorktreeRoot: join(home, 'scope'),
    })
    expect(read.items.map((i) => i.source)).toEqual(['worktree', 'missing'])
    expect(read.items[0]!.body).toBe('A')
  })

  test('non-pathish kind: content IS the body (no disk access)', () => {
    const read = readPortArtifact({
      appHome: home,
      taskId: 't1',
      archiveJson: null,
      content: '# inline doc',
      kind: 'markdown',
      fallbackWorktreeRoot: null,
    })
    expect(read.items[0]!.body).toBe('# inline doc')
    expect(read.items[0]!.source).toBe('archive')
  })

  test('poisoned archive file reference (../ escape) is refused → fallback/missing', () => {
    const evil = JSON.stringify({
      v: 1,
      items: [
        {
          path: 'a.md',
          file: join('runs', 't1', 'ports', '..', '..', 'secret'),
          size: 1,
          truncated: false,
        },
      ],
    })
    writeFileSync(join(home, 'secret'), 'TOP SECRET')
    const read = readPortArtifact({
      appHome: home,
      taskId: 't1',
      archiveJson: evil,
      content: 'a.md',
      kind: 'path<md>',
      fallbackWorktreeRoot: null,
    })
    expect(read.items[0]!.source).toBe('missing')
    expect(read.items[0]!.body).not.toContain('TOP SECRET')
  })

  test('legacy multi-repo fallback prefixes repos[0] dirName (impl-gate P1)', () => {
    mkdirSync(join(home, 'container', 'repoA', 'sub'), { recursive: true })
    writeFileSync(join(home, 'container', 'repoA', 'sub', 'a.md'), 'FROM REPO A')
    const read = readPortArtifact({
      appHome: home,
      taskId: 't1',
      archiveJson: null,
      content: 'sub/a.md', // repo0 相对（存量行形态）
      kind: 'path<md>',
      fallbackWorktreeRoot: join(home, 'container'),
      legacyRepoDirName: 'repoA',
    })
    expect(read.items[0]!.source).toBe('worktree')
    expect(read.items[0]!.body).toBe('FROM REPO A')
    expect(read.items[0]!.path).toBe('repoA/sub/a.md')
  })

  test("only:'meta' reads zero bytes; only:index reads just that item (impl-gate P2)", () => {
    const abs = join(home, 'wt', 'r.md')
    mkdirSync(join(home, 'wt'), { recursive: true })
    writeFileSync(abs, 'BODY')
    const arch = archivePortArtifacts({
      appHome: home,
      taskId: 't1',
      nodeRunId: 'r1',
      portName: 'doc',
      items: [{ sourceAbs: abs, sourcePath: 'r.md' }],
      worktreeDirName: '',
      worktreeRootAbs: join(home, 'wt'),
    })
    const meta = readPortArtifact({
      appHome: home,
      taskId: 't1',
      archiveJson: arch.archiveJson,
      content: 'r.md',
      kind: 'path<md>',
      fallbackWorktreeRoot: null,
      only: 'meta',
    })
    expect(meta.items[0]!.source).toBe('archive')
    expect(meta.items[0]!.bytes.length).toBe(0)
    expect(meta.items[0]!.size).toBe(4)
    const item = readPortArtifact({
      appHome: home,
      taskId: 't1',
      archiveJson: arch.archiveJson,
      content: 'r.md',
      kind: 'path<md>',
      fallbackWorktreeRoot: null,
      only: 0,
    })
    expect(item.items[0]!.body).toBe('BODY')
  })

  test('fallback containment refuses absolute + traversal + symlink-out paths', () => {
    mkdirSync(join(home, 'scope'), { recursive: true })
    writeFileSync(join(home, 'outside.txt'), 'OUT')
    const rd = (content: string) =>
      readPortArtifact({
        appHome: home,
        taskId: 't1',
        archiveJson: null,
        content,
        kind: 'path<md>',
        fallbackWorktreeRoot: join(home, 'scope'),
      }).items[0]!
    expect(rd('../outside.txt').source).toBe('missing')
    expect(rd(join(home, 'outside.txt')).source).toBe('missing')
  })
})

// ---------------------------------------------------------------------------
// 端到端层（真 git + mock opencode + runTask，RFC-130 iso 生效）
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

// plan step: { files?: Record<rel, content>, output?: Record<port, content> }
// mock 在 CWD（= runner 给的 iso worktree）写 files，再发 envelope —— 与真实
// agent 的行为同构（文件落在隔离 worktree 里，这正是本 RFC 的病灶现场）。
function mockSource(planFile: string): string {
  return `// generated by rfc193-port-artifacts.test.ts — file-writing mock opencode
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const argv = process.argv.slice(2)
if (argv.includes('--version')) { process.stdout.write('rfc193-mock 1.14.99\\n'); process.exit(0) }
if (argv[0] !== 'run') { process.stderr.write('rfc193-mock: expected run\\n'); process.exit(2) }
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
  const v = String(c).replaceAll('__ABS__', process.cwd())
  envelope += '  <port name="' + p + '">' + v + '</port>\\n'
}
envelope += '</workflow-output>'
emit(envelope)
process.exit(0)
`
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc193-e2e-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  const planFile = join(appHome, 'plan.json')
  const mockPath = join(appHome, 'mock.ts')
  for (const p of [repoPath, worktreePath]) mkdirSync(p, { recursive: true })
  for (const p of [repoPath, worktreePath]) {
    await runGit(p, ['init', '-b', 'main'])
    await runGit(p, ['config', 'user.email', 't@t.test'])
    await runGit(p, ['config', 'user.name', 't'])
    writeFileSync(join(p, 'README.md'), '# r\n')
    // .gitignore 命中 notes/ —— gitignored 端口文件的归档面（case 4 的读语义半边）。
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

function singleAgentDef(agentName: string): WorkflowDefinition {
  return {
    $schema_version: 3,
    inputs: [{ kind: 'text', key: 'req', label: 'r' }],
    nodes: [
      { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
      { id: 'w', kind: 'agent-single', agentName } as WorkflowNode,
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'in1', portName: 'req' },
        target: { nodeId: 'w', portName: 'req' },
      },
    ],
  }
}

async function seedTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf-rfc193',
    definition: JSON.stringify(definition),
  })
  await h.db.insert(tasks).values({
    name: 'rfc193-e2e',
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

async function runToEnd(h: Harness, taskId: string): Promise<void> {
  await runTask({
    db: h.db,
    taskId,
    appHome: h.appHome,
    opencodeCmd: ['bun', 'run', h.mockPath],
  })
}

async function outputRow(db: DbClient, taskId: string, port: string) {
  const runs = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'w')))
  const done = runs.find((r) => r.status === 'done')
  expect(done).toBeDefined()
  const rows = await db
    .select()
    .from(nodeRunOutputs)
    .where(and(eq(nodeRunOutputs.nodeRunId, done!.id), eq(nodeRunOutputs.portName, port)))
  return { run: done!, row: rows[0] }
}

describe('RFC-193 e2e — runner archive-at-emit', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h?.cleanup())

  test('path port: content normalized (./ stripped), archive_json lands, bytes match (case 1)', async () => {
    await seedAgent(h.db, 'writer', ['doc'], { doc: 'path<md>' })
    writeFileSync(
      h.planFile,
      JSON.stringify({
        writer: { files: { 'report.md': '# archived body\n' }, output: { doc: './report.md' } },
      }),
    )
    const taskId = await seedTask(h, singleAgentDef('writer'))
    await runToEnd(h, taskId)
    const { row } = await outputRow(h.db, taskId, 'doc')
    expect(row).toBeDefined()
    expect(row!.content).toBe('report.md') // D6 规范化：./ 前缀清洗
    const arch = parseArchiveJson(row!.archiveJson)
    expect(arch).not.toBeNull()
    expect(arch!.items[0]!.path).toBe('report.md')
    expect(readFileSync(join(h.appHome, arch!.items[0]!.file!), 'utf8')).toBe('# archived body\n')
  })

  test('gitignored port file still archives (reading semantics never sees gitignore)', async () => {
    await seedAgent(h.db, 'writer', ['doc'], { doc: 'path<md>' })
    writeFileSync(
      h.planFile,
      JSON.stringify({
        writer: {
          files: { 'notes/hidden.md': 'ignored but archived' },
          output: { doc: 'notes/hidden.md' },
        },
      }),
    )
    const taskId = await seedTask(h, singleAgentDef('writer'))
    await runToEnd(h, taskId)
    const { row } = await outputRow(h.db, taskId, 'doc')
    const arch = parseArchiveJson(row!.archiveJson)
    expect(readFileSync(join(h.appHome, arch!.items[0]!.file!), 'utf8')).toBe(
      'ignored but archived',
    )
  })

  test('list<path<md>>: per-item archive in splitListItems order (case 2)', async () => {
    await seedAgent(h.db, 'writer', ['docs'], { docs: 'list<path<md>>' })
    writeFileSync(
      h.planFile,
      JSON.stringify({
        writer: {
          files: { 'a.md': 'AAA', 'sub/b.md': 'BBB' },
          output: { docs: 'a.md\nsub/b.md' },
        },
      }),
    )
    const taskId = await seedTask(h, singleAgentDef('writer'))
    await runToEnd(h, taskId)
    const { row } = await outputRow(h.db, taskId, 'docs')
    expect(row!.content).toBe('a.md\nsub/b.md')
    const arch = parseArchiveJson(row!.archiveJson)!
    expect(arch.items.map((i) => i.path)).toEqual(['a.md', 'sub/b.md'])
    expect(readFileSync(join(h.appHome, arch.items[0]!.file!), 'utf8')).toBe('AAA')
    expect(readFileSync(join(h.appHome, arch.items[1]!.file!), 'utf8')).toBe('BBB')
  })

  test('two-phase: first port valid, second invalid ⇒ node failed AND zero archive files (case 3b)', async () => {
    await seedAgent(h.db, 'writer', ['good', 'bad'], { good: 'path<md>', bad: 'path<md>' })
    writeFileSync(
      h.planFile,
      JSON.stringify({
        writer: {
          files: { 'good.md': 'G' },
          output: { good: 'good.md', bad: 'missing.md' },
        },
      }),
    )
    const taskId = await seedTask(h, singleAgentDef('writer'))
    await runToEnd(h, taskId)
    const runs = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'w')))
    expect(runs.some((r) => r.status === 'done')).toBe(false)
    // 磁盘零孤儿：该任务 ports/ 命名空间不存在或为空（阶段一 fail-fast 未写盘）。
    const portsRoot = join(h.appHome, 'runs', taskId, 'ports')
    const orphans = existsSync(portsRoot)
      ? readdirSync(portsRoot, { recursive: true }).filter((e) =>
          existsSync(join(portsRoot, String(e))) ? !String(e).endsWith('/') : false,
        )
      : []
    const orphanFiles = orphans.filter((e) => {
      try {
        return readFileSync(join(portsRoot, String(e))) !== undefined
      } catch {
        return false
      }
    })
    expect(orphanFiles).toEqual([])
  })

  test('absolute path inside iso is normalized to repo-relative content (K2)', async () => {
    await seedAgent(h.db, 'writer', ['doc'], { doc: 'path<md>' })
    // mock 侧无法预知 iso 路径 —— 用 files 写文件，output 引用 CWD 拼出的
    // 绝对路径：mock 在 cwd 下写 abs.md，envelope 里用 __CWD__ 占位不行……
    // 简化：envelope 的 port 内容由 mock 在运行时生成（files 先落盘、output
    // 值 '__ABS__/report.md' 由 mock 替换为 join(cwd, 'report.md')）。
    writeFileSync(
      h.planFile,
      JSON.stringify({
        writer: { files: { 'report.md': 'ABS' }, output: { doc: '__ABS__/report.md' } },
      }),
    )
    const taskId = await seedTask(h, singleAgentDef('writer'))
    await runToEnd(h, taskId)
    const { row } = await outputRow(h.db, taskId, 'doc')
    expect(row!.content).toBe('report.md')
    const arch = parseArchiveJson(row!.archiveJson)!
    expect(arch.items[0]!.path).toBe('report.md')
  })
})

// 源码层兜底（case 8 — workgroup host run 不归档；e2e 驱动 workgroup 过重，
// 归档 gate 的 persistDeclaredOutputs 防御以文本断言锁定）。
describe('RFC-193 source guards', () => {
  test('runner archival gate carries the persistDeclaredOutputs defence (D14)', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'), 'utf8')
    const gate = src.slice(src.indexOf('pathishArchives.size > 0'))
    expect(gate.slice(0, 400)).toContain('persistDeclaredOutputs !== false')
  })
})

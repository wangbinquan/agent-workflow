// RFC-310 PR-0 T4/T5 —— 检测/回退 probe（真实子进程，测试专用，不进生产）。
//
// 2026-08-18 用户裁决：数字员工首版不引入 OS 沙箱/只读 Git view/网络管控；
// no-Git 以「提示词禁止 + 前后快照事后校验 + 违规整树回退 + 零凭据/零 Git
// identity 注入」强制。本 probe 用真实子进程证明这套机制的三个前提
// （pr0-go-no-go.md §B）：
//   B1 业务路径正向写成功且不触发保护面 violation；
//   B2/B3/B6 Git metadata / evidence 的写入——`git commit`、file API 直写
//      refs、`GIT_DIR` 变体——全部被前后快照对拍检出；
//   B4 violation 后整树废弃，从 baseline 重新物化的业务树 byte-identical、
//      Git 逻辑状态（HEAD sha + clean porcelain）一致；
//   B5 数字员工形态的 spawn env 不含平台注入的 Git identity（daemon env 按
//      裁决保留继承——断言的是「平台没有新增」，不是「环境绝对纯净」）。
//
// 回退 byte-identical 的口径（PR-4 生产 profile 沿用）：业务文件树内容 digest
// 相等 + HEAD sha 相等 + `git status --porcelain` 为空。`.git` 物理字节不在
// 口径内——两次 clone 的 reflog 时间戳/index stat 字段天然不同；检测口径
// （同一 workspace 生命周期内的前后对拍）才使用 `.git` 物理快照。

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assembleClaudeEnv } from '../src/services/runtime/claudeCode/spawn'
import { buildOpencodeEnv } from '../src/services/runtime/opencode/spawn'
import { runTestCommand } from './helpers/testCommand'
import {
  diffProtectedRoots,
  snapshotProtectedRoots,
  type ProtectedRootSnapshot,
} from './helpers/rfc310MetaSnapshot'

setDefaultTimeout(60_000)

const CMD_TIMEOUT = 20_000
let ROOT = ''
let BASELINE_REPO = ''
let BASELINE_SHA = ''
let EMPTY_GIT_CONFIG = ''
let wsCounter = 0

function gitEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
    GIT_CONFIG_SYSTEM: EMPTY_GIT_CONFIG,
    GIT_OPTIONAL_LOCKS: '0',
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  return runTestCommand(['git', ...args], { cwd, env: gitEnv(), timeoutMs: CMD_TIMEOUT })
}

/** 平台物化一个 action workspace：clone baseline + 放置 evidence mounts。 */
async function materializeWorkspace(): Promise<string> {
  wsCounter += 1
  const ws = join(ROOT, `ws-${wsCounter}`)
  await git(['clone', '--quiet', BASELINE_REPO, ws], ROOT)
  // RFC-308：平台运行物 `.agent-workflow/` 由 per-worktree exclude profile 排除，
  // 物化把它写进 .git/info/exclude（属物化的一部分，先于任何快照）。
  writeFileSync(join(ws, '.git', 'info', 'exclude'), '.agent-workflow/\n')
  const evidence = join(ws, '.agent-workflow', 'pipeline', 'demo')
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'manifest.json'), '{"schemaVersion":1}\n')
  return ws
}

function protectedSnapshot(ws: string): ProtectedRootSnapshot {
  return snapshotProtectedRoots({
    'git-meta': join(ws, '.git'),
    evidence: join(ws, '.agent-workflow'),
  })
}

function businessSnapshot(ws: string): ProtectedRootSnapshot {
  return snapshotProtectedRoots({ business: ws }, { skipPrefixes: ['.git', '.agent-workflow'] })
}

/** 真实子进程里用 file API 写文件（跨平台，无 sh 依赖）。 */
async function subprocessWrite(cwd: string, relPath: string, content: string): Promise<void> {
  const script = `require('node:fs').writeFileSync(${JSON.stringify(relPath)}, ${JSON.stringify(content)})`
  await runTestCommand([process.execPath, '-e', script], {
    cwd,
    env: gitEnv(),
    timeoutMs: CMD_TIMEOUT,
  })
}

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), 'rfc310-probe-'))
  EMPTY_GIT_CONFIG = join(ROOT, 'empty-gitconfig')
  writeFileSync(EMPTY_GIT_CONFIG, '')
  BASELINE_REPO = join(ROOT, 'baseline')
  mkdirSync(BASELINE_REPO)
  await git(['init', '--quiet', '--initial-branch=main'], BASELINE_REPO)
  writeFileSync(join(BASELINE_REPO, 'app.txt'), 'v1\n')
  mkdirSync(join(BASELINE_REPO, 'src'))
  writeFileSync(join(BASELINE_REPO, 'src', 'main.java'), 'class Main {}\n')
  await git(['add', '-A'], BASELINE_REPO)
  await git(
    [
      '-c',
      'user.name=baseline',
      '-c',
      'user.email=baseline@test',
      'commit',
      '--quiet',
      '-m',
      'baseline',
    ],
    BASELINE_REPO,
  )
  BASELINE_SHA = (await git(['rev-parse', 'HEAD'], BASELINE_REPO)).trim()
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('rfc310 pr0 detect/rollback probe', () => {
  test('B1: read-only git + business writes leave protected roots untouched', async () => {
    const ws = await materializeWorkspace()
    const before = protectedSnapshot(ws)
    const businessBefore = businessSnapshot(ws)

    await git(['status', '--porcelain'], ws)
    await git(['diff'], ws)
    await git(['log', '--oneline', '-1'], ws)
    await subprocessWrite(ws, 'src/feature.java', 'class Feature {}\n')
    await subprocessWrite(ws, 'app.txt', 'v2\n')

    expect(diffProtectedRoots(before, protectedSnapshot(ws))).toEqual([])
    expect(businessSnapshot(ws).digest).not.toBe(businessBefore.digest)
  })

  test('B2/B6: real `git commit` in the workspace is detected as a violation', async () => {
    const ws = await materializeWorkspace()
    const before = protectedSnapshot(ws)
    await subprocessWrite(ws, 'src/feature.java', 'class Feature {}\n')
    await git(['-c', 'user.name=agent', '-c', 'user.email=agent@evil', 'add', '-A'], ws)
    await git(
      ['-c', 'user.name=agent', '-c', 'user.email=agent@evil', 'commit', '--quiet', '-m', 'sneaky'],
      ws,
    )
    const violations = diffProtectedRoots(before, protectedSnapshot(ws))
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.every((v) => v.root === 'git-meta')).toBe(true)
    const touched = violations.map((v) => v.path).join('\n')
    expect(touched).toContain('HEAD')
    expect(touched).toContain('objects')
  })

  test('B3/B6: file-API ref write and GIT_DIR variant are both detected', async () => {
    const ws = await materializeWorkspace()
    const before = protectedSnapshot(ws)

    await subprocessWrite(ws, join('.git', 'refs', 'heads', 'evil'), `${BASELINE_SHA}\n`)
    const afterRefWrite = diffProtectedRoots(before, protectedSnapshot(ws))
    expect(
      afterRefWrite.some((v) => v.root === 'git-meta' && v.path.includes('refs/heads/evil')),
    ).toBe(true)

    const outside = join(ROOT, `outside-${wsCounter}`)
    mkdirSync(outside, { recursive: true })
    await runTestCommand(['git', 'update-ref', 'refs/heads/evil2', BASELINE_SHA], {
      cwd: outside,
      env: { ...gitEnv(), GIT_DIR: join(ws, '.git') },
      timeoutMs: CMD_TIMEOUT,
    })
    const afterGitDir = diffProtectedRoots(before, protectedSnapshot(ws))
    expect(
      afterGitDir.some((v) => v.root === 'git-meta' && v.path.includes('refs/heads/evil2')),
    ).toBe(true)
  })

  test('B3: writing pipeline evidence is detected with the evidence root label', async () => {
    const ws = await materializeWorkspace()
    const before = protectedSnapshot(ws)
    await subprocessWrite(
      ws,
      join('.agent-workflow', 'pipeline', 'demo', 'tampered.log'),
      'fake evidence\n',
    )
    const violations = diffProtectedRoots(before, protectedSnapshot(ws))
    expect(violations.some((v) => v.root === 'evidence' && v.kind === 'added')).toBe(true)
  })

  test('B4: discard + rematerialize rebuilds a byte-identical business baseline', async () => {
    const clean = await materializeWorkspace()
    const cleanBusinessDigest = businessSnapshot(clean).digest

    const attacked = await materializeWorkspace()
    await subprocessWrite(attacked, 'src/feature.java', 'class Evil {}\n')
    await git(['-c', 'user.name=a', '-c', 'user.email=a@a', 'add', '-A'], attacked)
    await git(
      ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '--quiet', '-m', 'evil'],
      attacked,
    )

    rmSync(attacked, { recursive: true, force: true })
    const rebuilt = await materializeWorkspace()

    expect(businessSnapshot(rebuilt).digest).toBe(cleanBusinessDigest)
    expect((await git(['rev-parse', 'HEAD'], rebuilt)).trim()).toBe(BASELINE_SHA)
    expect((await git(['status', '--porcelain'], rebuilt)).trim()).toBe('')
  })

  test('B5: digital-employee env assembly injects no Git identity for either runtime', async () => {
    const runDir = join(ROOT, 'run-dir')
    mkdirSync(runDir, { recursive: true })

    const opencodeEnv = buildOpencodeEnv({
      worktreePath: ROOT,
      runDir,
      inlineConfigSerialized: '{}',
    })
    for (const key of [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
    ]) {
      expect(opencodeEnv[key]).toBe(process.env[key] as string | undefined as never)
    }
    const legacy = buildOpencodeEnv({
      worktreePath: ROOT,
      runDir,
      inlineConfigSerialized: '{}',
      gitUserName: 'legacy',
      gitUserEmail: 'legacy@task',
    })
    expect(legacy.GIT_AUTHOR_NAME).toBe('legacy')

    const claudeEnv = assembleClaudeEnv({ worktreePath: ROOT }, { PATH: process.env.PATH })
    expect(Object.keys(claudeEnv).filter((k) => k.startsWith('GIT_'))).toEqual([])
    expect(claudeEnv.IS_SANDBOX).toBeUndefined()

    const probeOut = await runTestCommand(
      [process.execPath, '-e', "console.log(process.env.GIT_AUTHOR_NAME ?? 'ABSENT')"],
      { cwd: ROOT, env: { ...claudeEnv }, timeoutMs: CMD_TIMEOUT },
    )
    expect(probeOut.trim()).toBe('ABSENT')
  })
})

// RFC-310 PR-4 T47 —— workspace validator 锁（§7.5 步骤 5-7 / §7.6.5-6）。
//
// 完成定义不是「git 命令返回失败」（首版无 OS 阻断），而是任何 Git/protected/
// evidence 写入攻击都被前后快照对拍检出为 boundary violation、changedPaths 由
// 平台独立计算、outcome 与现场不符走 semantic 反馈。违规现场全部用文件系统
// 直接构造（真子进程攻击链归 PR-0 probe 与主 session E2E）。
// 另锁生产 protectedSnapshot 与 PR-0 probe helper 的口径逐字一致（同树同 digest）。

import { beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EvidenceStore } from '../src/modules/development-automation/infrastructure/evidenceStore'
import { materializeActionWorkspace } from '../src/modules/development-automation/infrastructure/actionWorkspace'
import {
  snapshotProtectedRoots,
  type ProtectedRootSnapshot,
} from '../src/modules/development-automation/infrastructure/protectedSnapshot'
import { snapshotProtectedRoots as probeSnapshot } from './helpers/rfc310MetaSnapshot'
import {
  businessTreeSnapshot,
  validateWorkspaceOutcome,
  type WorkspaceValidationInput,
} from '../src/modules/development-automation/infrastructure/workspaceValidator'

let baselineRepo = ''
let baselineSha = ''
let evidence: EvidenceStore

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

beforeAll(() => {
  baselineRepo = mkdtempSync(join(tmpdir(), 'rfc310-pr4-baseline-'))
  mkdirSync(join(baselineRepo, 'src'), { recursive: true })
  mkdirSync(join(baselineRepo, 'docs'), { recursive: true })
  writeFileSync(join(baselineRepo, 'README.md'), '# readme\n')
  writeFileSync(join(baselineRepo, 'src', 'app.ts'), 'export const x = 1\n')
  writeFileSync(join(baselineRepo, 'docs', 'spec.md'), 'spec v1\n')
  writeFileSync(join(baselineRepo, 'docs', 'notes.md'), 'notes v1\n')
  git(baselineRepo, 'init', '-q')
  git(baselineRepo, 'add', '.')
  git(baselineRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'baseline')
  baselineSha = git(baselineRepo, 'rev-parse', 'HEAD')
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'rfc310-pr4-evidence-'))
  evidence = new EvidenceStore(evidenceRoot)
})

interface Scene {
  readonly ws: string
  readonly pre: ProtectedRootSnapshot
  readonly preTree: ReadonlyMap<string, string>
  readonly roots: Record<string, string>
  validate(
    overrides: Partial<
      Pick<
        WorkspaceValidationInput,
        | 'outcome'
        | 'workspaceMode'
        | 'writablePrefixes'
        | 'preservePaths'
        | 'editablePaths'
        | 'budget'
      >
    >,
  ): ReturnType<typeof validateWorkspaceOutcome>
}

async function freshScene(): Promise<Scene> {
  const materialized = await materializeActionWorkspace(
    { evidence, seedsRoot: join(tmpdir(), 'rfc310-pr4-no-seeds') },
    { baselineRepoPath: baselineRepo, baselineSha, seedRef: null, bundles: [] },
  )
  const ws = materialized.workspacePath
  const roots = { 'git-meta': join(ws, '.git'), evidence: join(ws, '.agent-workflow') }
  const pre = snapshotProtectedRoots(roots)
  const preTree = businessTreeSnapshot(ws)
  return {
    ws,
    pre,
    preTree,
    roots,
    validate(overrides) {
      return validateWorkspaceOutcome({
        workspacePath: ws,
        preProtected: pre,
        protectedRoots: roots,
        preBusinessTree: preTree,
        outcome: 'changed',
        workspaceMode: 'edit-business-files',
        writablePrefixes: [],
        preservePaths: [],
        editablePaths: [],
        budget: { maxChangedFiles: 100, maxTotalBytes: 10 * 1024 * 1024 },
        ...overrides,
      })
    },
  }
}

const codeOf = (r: ReturnType<typeof validateWorkspaceOutcome>): string =>
  r.ok ? r.kind : `${r.kind}:${'code' in r ? r.code : ''}`

describe('rfc310 pr4 — workspace validator', () => {
  test('clean workspace with clean outcome passes; platform computes changedPaths itself', async () => {
    const scene = await freshScene()
    expect(codeOf(scene.validate({ outcome: 'no-change' }))).toBe('clean')

    writeFileSync(join(scene.ws, 'src', 'app.ts'), 'export const x = 2\n')
    writeFileSync(join(scene.ws, 'src', 'new.ts'), 'export const y = 1\n')
    const out = scene.validate({ outcome: 'changed' })
    expect(out.ok).toBe(true)
    if (out.ok && out.kind === 'changed') {
      expect(out.changedPaths).toEqual(['src/app.ts', 'src/new.ts'])
    }
    rmSync(join(scene.ws, '..'), { recursive: true, force: true })
  })

  test('.git writes are detected as boundary violations (commit attack shape)', async () => {
    const scene = await freshScene()
    // Agent 在自己 workspace 里“git commit”的最小现场：改 refs/HEAD 附近文件。
    writeFileSync(join(scene.ws, '.git', 'COMMIT_EDITMSG'), 'sneaky commit\n')
    const out = scene.validate({ outcome: 'changed' })
    expect(codeOf(out)).toBe('boundary:protected-root-write')
    if (!out.ok && out.kind === 'boundary') {
      expect(out.paths.some((p) => p.startsWith('git-meta:'))).toBe(true)
    }
    rmSync(join(scene.ws, '..'), { recursive: true, force: true })
  })

  test('evidence root writes are boundary violations even when the root started empty', async () => {
    const scene = await freshScene()
    mkdirSync(join(scene.ws, '.agent-workflow'), { recursive: true })
    writeFileSync(join(scene.ws, '.agent-workflow', 'planted.txt'), 'x')
    expect(codeOf(scene.validate({ outcome: 'changed' }))).toBe('boundary:protected-root-write')
    rmSync(join(scene.ws, '..'), { recursive: true, force: true })
  })

  test('symlink and hardlink introduction are escape violations', async () => {
    const scene = await freshScene()
    symlinkSync('/etc/passwd', join(scene.ws, 'src', 'link.ts'))
    expect(codeOf(scene.validate({ outcome: 'changed' }))).toBe('boundary:symlink-created')
    unlinkSync(join(scene.ws, 'src', 'link.ts'))

    const outside = join(tmpdir(), `rfc310-pr4-outside-${Date.now()}.txt`)
    writeFileSync(outside, 'outside')
    linkSync(outside, join(scene.ws, 'src', 'hard.ts'))
    expect(codeOf(scene.validate({ outcome: 'changed' }))).toBe('boundary:hardlink-created')
    rmSync(join(scene.ws, '..'), { recursive: true, force: true })
    rmSync(outside, { force: true })
  })

  test('read-only capability: any business write is a boundary violation, not a retryable mismatch', async () => {
    const scene = await freshScene()
    writeFileSync(join(scene.ws, 'src', 'app.ts'), 'export const x = 3\n')
    expect(codeOf(scene.validate({ outcome: 'no-change', workspaceMode: 'read-only' }))).toBe(
      'boundary:read-only-workspace-write',
    )
    rmSync(join(scene.ws, '..'), { recursive: true, force: true })
  })

  test('upload contract: preserve untouchable; editable neither deletable nor mode-changeable', async () => {
    const scene = await freshScene()
    writeFileSync(join(scene.ws, 'docs', 'spec.md'), 'tampered\n')
    expect(codeOf(scene.validate({ outcome: 'changed', preservePaths: ['docs/spec.md'] }))).toBe(
      'boundary:preserve-upload-modified',
    )
    writeFileSync(join(scene.ws, 'docs', 'spec.md'), 'spec v1\n')

    unlinkSync(join(scene.ws, 'docs', 'notes.md'))
    expect(codeOf(scene.validate({ outcome: 'changed', editablePaths: ['docs/notes.md'] }))).toBe(
      'boundary:upload-target-removed',
    )
    writeFileSync(join(scene.ws, 'docs', 'notes.md'), 'notes v1\n')

    chmodSync(join(scene.ws, 'docs', 'notes.md'), 0o755)
    expect(codeOf(scene.validate({ outcome: 'changed', editablePaths: ['docs/notes.md'] }))).toBe(
      'boundary:upload-mode-changed',
    )
    rmSync(join(scene.ws, '..'), { recursive: true, force: true })
  })

  test('writable prefixes fence writes; budgets are enforced', async () => {
    const scene = await freshScene()
    writeFileSync(join(scene.ws, 'README.md'), 'outside allowlist\n')
    expect(codeOf(scene.validate({ outcome: 'changed', writablePrefixes: ['src'] }))).toBe(
      'boundary:write-outside-allowlist',
    )
    writeFileSync(join(scene.ws, 'src', 'a.ts'), 'a\n')
    expect(
      codeOf(
        scene.validate({
          outcome: 'changed',
          budget: { maxChangedFiles: 1, maxTotalBytes: 10 * 1024 * 1024 },
        }),
      ),
    ).toBe('boundary:budget-exceeded')
    rmSync(join(scene.ws, '..'), { recursive: true, force: true })
  })

  test('outcome/workspace mismatches are semantic (retryable with feedback)', async () => {
    const scene = await freshScene()
    expect(codeOf(scene.validate({ outcome: 'changed' }))).toBe(
      'semantic:outcome-workspace-mismatch',
    )
    writeFileSync(join(scene.ws, 'src', 'app.ts'), 'export const x = 4\n')
    expect(codeOf(scene.validate({ outcome: 'no-change' }))).toBe(
      'semantic:outcome-workspace-mismatch',
    )
    rmSync(join(scene.ws, '..'), { recursive: true, force: true })
  })

  test('production snapshot keeps the exact PR-0 probe semantics (same tree, same digest)', async () => {
    const scene = await freshScene()
    const production = snapshotProtectedRoots(scene.roots)
    const probe = probeSnapshot(scene.roots)
    expect(production.digest).toBe(probe.digest)
    rmSync(join(scene.ws, '..'), { recursive: true, force: true })
  })
})

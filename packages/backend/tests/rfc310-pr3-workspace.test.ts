// RFC-310 PR-3 T37 —— action workspace 物化与整树回退合同。
//
// 锁 design §5.4/§7.6：①workspace = exact baseline sha 的 clone（不是「当前
// HEAD」——历史 sha 也能重建）；②RFC-308 exclude（`.agent-workflow/` 进
// `.git/info/exclude`）先于一切写入；③seed overlay 与只读 bundle mount 落位；
// ④同 exact 输入 fresh 重建 businessTreeDigest byte-identical（PR-0 B4 回退
// 口径的生产化）；⑤businessTreeDigest 排除 .git/.agent-workflow——平台运行物
// 不进业务 digest；⑥discard 是整树删除。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runGit } from '../src/util/git'
import { EvidenceStore } from '../src/modules/development-automation/infrastructure/evidenceStore'
import {
  businessTreeDigestOf,
  discardWorkspace,
  materializeActionWorkspace,
} from '../src/modules/development-automation/infrastructure/actionWorkspace'

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args)
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

interface Baseline {
  repoPath: string
  firstSha: string
  headSha: string
}

async function mkBaselineRepo(): Promise<Baseline> {
  const repoPath = mkdtempSync(join(tmpdir(), 'aw-ws-repo-'))
  await git(repoPath, ['init', '--quiet', '--initial-branch=main'])
  await git(repoPath, ['config', 'user.email', 'test@example.com'])
  await git(repoPath, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoPath, 'README.md'), 'hello v1\n')
  mkdirSync(join(repoPath, 'src'))
  writeFileSync(join(repoPath, 'src/app.ts'), 'export const v = 1\n')
  await git(repoPath, ['add', '-A'])
  await git(repoPath, ['commit', '--quiet', '-m', 'v1'])
  const firstSha = await git(repoPath, ['rev-parse', 'HEAD'])
  writeFileSync(join(repoPath, 'README.md'), 'hello v2\n')
  await git(repoPath, ['add', '-A'])
  await git(repoPath, ['commit', '--quiet', '-m', 'v2'])
  const headSha = await git(repoPath, ['rev-parse', 'HEAD'])
  return { repoPath, firstSha, headSha }
}

function mkDeps() {
  const root = mkdtempSync(join(tmpdir(), 'aw-ws-deps-'))
  const evidence = new EvidenceStore(join(root, 'evidence'))
  const seedsRoot = join(root, 'seeds')
  mkdirSync(seedsRoot, { recursive: true })
  return { root, deps: { evidence, seedsRoot } }
}

describe('rfc310 pr3 action workspace', () => {
  test('materializes the exact baseline sha (not current HEAD) with the RFC-308 exclude in place', async () => {
    const baseline = await mkBaselineRepo()
    const { deps } = mkDeps()
    const ws = await materializeActionWorkspace(deps, {
      baselineRepoPath: baseline.repoPath,
      baselineSha: baseline.firstSha,
      seedRef: null,
      bundles: [],
    })
    // 冻结在历史 sha：内容是 v1，不是当前 HEAD 的 v2。
    expect(readFileSync(join(ws.workspacePath, 'README.md'), 'utf8')).toBe('hello v1\n')
    expect(await git(ws.workspacePath, ['rev-parse', 'HEAD'])).toBe(baseline.firstSha)
    expect(await git(ws.workspacePath, ['remote'])).toBe('')
    expect(readFileSync(join(ws.workspacePath, '.git/info/exclude'), 'utf8')).toContain(
      '.agent-workflow/',
    )
    // exclude 生效：平台运行物目录不会出现在 git status。
    mkdirSync(join(ws.workspacePath, '.agent-workflow'))
    writeFileSync(join(ws.workspacePath, '.agent-workflow/pipeline.json'), '{}')
    expect(await git(ws.workspacePath, ['status', '--porcelain'])).toBe('')
    discardWorkspace(ws.workspacePath)
  })

  test('seed overlay and read-only bundle mounts land in the tree', async () => {
    const baseline = await mkBaselineRepo()
    const { root, deps } = mkDeps()
    // seed：placement 产物形状（seedsRoot/<ref>/ 下的相对树）。
    const seedRef = 'plan-digest-1'
    mkdirSync(join(deps.seedsRoot, seedRef, 'docs'), { recursive: true })
    writeFileSync(join(deps.seedsRoot, seedRef, 'docs/spec.md'), 'uploaded spec\n')
    // bundle：staged tree 导入 evidence。
    const staged = join(root, 'staged')
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'requirement.md'), 'the requirement\n')
    const bundle = await deps.evidence.importStagedTree(staged, {
      maxFiles: 10,
      maxFileBytes: 1024,
      maxTotalBytes: 4096,
    })
    const ws = await materializeActionWorkspace(deps, {
      baselineRepoPath: baseline.repoPath,
      baselineSha: baseline.headSha,
      seedRef,
      bundles: [{ bundleId: bundle.bundleId, mountPath: '.agent-workflow/inputs/requirement' }],
    })
    expect(readFileSync(join(ws.workspacePath, 'docs/spec.md'), 'utf8')).toBe('uploaded spec\n')
    expect(
      readFileSync(
        join(ws.workspacePath, '.agent-workflow/inputs/requirement/requirement.md'),
        'utf8',
      ),
    ).toBe('the requirement\n')
    // seed 是业务树的一部分、bundle mount（.agent-workflow）不是。
    const digestNoSeed = await materializeActionWorkspace(deps, {
      baselineRepoPath: baseline.repoPath,
      baselineSha: baseline.headSha,
      seedRef: null,
      bundles: [],
    })
    expect(ws.businessTreeDigest).not.toBe(digestNoSeed.businessTreeDigest)
    discardWorkspace(ws.workspacePath)
    discardWorkspace(digestNoSeed.workspacePath)
  })

  test('fresh rebuild from exact inputs is byte-identical (rollback contract)', async () => {
    const baseline = await mkBaselineRepo()
    const { deps } = mkDeps()
    const seedRef = 'plan-digest-2'
    mkdirSync(join(deps.seedsRoot, seedRef), { recursive: true })
    writeFileSync(join(deps.seedsRoot, seedRef, 'seeded.txt'), 'seed\n')
    const input = {
      baselineRepoPath: baseline.repoPath,
      baselineSha: baseline.firstSha,
      seedRef,
      bundles: [],
    }
    const first = await materializeActionWorkspace(deps, input)
    const second = await materializeActionWorkspace(deps, input)
    expect(first.workspacePath).not.toBe(second.workspacePath)
    expect(first.businessTreeDigest).toBe(second.businessTreeDigest)
    discardWorkspace(first.workspacePath)
    discardWorkspace(second.workspacePath)
  })

  test('businessTreeDigest ignores .git and .agent-workflow but tracks business files', async () => {
    const baseline = await mkBaselineRepo()
    const { deps } = mkDeps()
    const ws = await materializeActionWorkspace(deps, {
      baselineRepoPath: baseline.repoPath,
      baselineSha: baseline.headSha,
      seedRef: null,
      bundles: [],
    })
    const before = businessTreeDigestOf(ws.workspacePath)
    expect(before).toBe(ws.businessTreeDigest)
    mkdirSync(join(ws.workspacePath, '.agent-workflow'), { recursive: true })
    writeFileSync(join(ws.workspacePath, '.agent-workflow/scratch.log'), 'noise')
    expect(businessTreeDigestOf(ws.workspacePath)).toBe(before)
    writeFileSync(join(ws.workspacePath, 'src/app.ts'), 'export const v = 999\n')
    expect(businessTreeDigestOf(ws.workspacePath)).not.toBe(before)
    discardWorkspace(ws.workspacePath)
  })

  test('discardWorkspace removes the whole tree — rollback is deletion, never git reset', async () => {
    const baseline = await mkBaselineRepo()
    const { deps } = mkDeps()
    const ws = await materializeActionWorkspace(deps, {
      baselineRepoPath: baseline.repoPath,
      baselineSha: baseline.headSha,
      seedRef: null,
      bundles: [],
    })
    expect(existsSync(ws.workspacePath)).toBe(true)
    discardWorkspace(ws.workspacePath)
    expect(existsSync(ws.workspacePath)).toBe(false)
  })
})

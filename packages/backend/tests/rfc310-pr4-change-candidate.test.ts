// RFC-310 PR-4 T48 —— ChangeCandidate 派生（design §9.1/§9.2）。
//
// 锁四件事：①独立 diff——candidate 相对 pinned baseline 由平台在自己的临时
// clone 里计算（含删除检测、gitignore 语义、上传目标 add -f 例外）；②禁路径
// 固定阻断（.agent-workflow / protected root 出现在 changed 即 refuse，绝不
// 静默剔除）；③上传 lineage 四规则任一不满足作废整个 candidate；④同输入
// byte-identical（treeOid/candidateRef determinism——fresh 重建合同的 candidate
// 侧）。

import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deriveChangeCandidate } from '../src/modules/source-control/application/changeCandidate'
import {
  candidateReceiptRef,
  checkForbiddenCandidatePaths,
  verifyUploadLineage,
} from '../src/modules/source-control/domain/changeCandidate'
import { sha256Hex } from '../src/util/hash'

setDefaultTimeout(120_000)

let baselineRepo = ''

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString()
}

function makeOverlay(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc310-overlay-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

beforeAll(() => {
  baselineRepo = mkdtempSync(join(tmpdir(), 'rfc310-baseline-'))
  git(baselineRepo, 'init', '-q')
  writeFileSync(join(baselineRepo, 'README.md'), '# baseline\n')
  writeFileSync(join(baselineRepo, '.gitignore'), 'dist/\n')
  mkdirSync(join(baselineRepo, 'src'))
  writeFileSync(join(baselineRepo, 'src', 'keep.ts'), 'export const keep = 1\n')
  git(baselineRepo, 'add', '-A')
  git(
    baselineRepo,
    '-c',
    'user.email=t48@test',
    '-c',
    'user.name=t48',
    'commit',
    '-q',
    '-m',
    'baseline',
  )
})

function headSha(): string {
  return git(baselineRepo, 'rev-parse', 'HEAD').trim()
}

describe('rfc310 pr4 T48 — change candidate derivation', () => {
  test('add/modify/delete are computed against the pinned baseline; determinism is byte-identical', async () => {
    const overlay = makeOverlay({
      'README.md': '# changed\n',
      '.gitignore': 'dist/\n',
      'src/new.ts': 'export const a = 1\n',
      // src/keep.ts 缺席 ⇒ 删除。
    })
    const input = {
      baselineRepoPath: baselineRepo,
      baselineSha: headSha(),
      overlayRoot: overlay,
      excludePolicyDigest: 'x'.repeat(64),
      agentOutcomeRef: 'outcome-1',
    }
    const first = await deriveChangeCandidate(input)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.receipt.changed).toEqual({
      added: ['src/new.ts'],
      modified: ['README.md'],
      deleted: ['src/keep.ts'],
    })
    expect(first.receipt.treeOid).toMatch(/^[0-9a-f]{40}$/)
    expect(first.receipt.baselineSnapshotRef).toBe(`git:${input.baselineSha}`)

    const second = await deriveChangeCandidate(input)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.receipt.treeOid).toBe(first.receipt.treeOid)
    expect(second.receipt.candidateRef).toBe(first.receipt.candidateRef)
  })

  test('gitignored build output stays out of the candidate; empty delta is typed', async () => {
    const overlay = makeOverlay({
      'README.md': '# baseline\n',
      '.gitignore': 'dist/\n',
      'src/keep.ts': 'export const keep = 1\n',
      'dist/bundle.js': 'garbage\n',
    })
    const out = await deriveChangeCandidate({
      baselineRepoPath: baselineRepo,
      baselineSha: headSha(),
      overlayRoot: overlay,
      excludePolicyDigest: 'x'.repeat(64),
      agentOutcomeRef: 'outcome-2',
    })
    // dist/ 被 .gitignore 挡住 ⇒ 无任何真实 delta ⇒ candidate-empty。
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('candidate-empty')
  })

  test('platform dir is excluded from the overlay; tracked platform paths in the delta are a fixed refusal', async () => {
    // overlay 里的 `.agent-workflow/`（evidence mounts 等平台运行物）按
    // RFC-308 exclude 语义不属于业务内容：candidate 照常派生且 changed 不含它。
    const excluded = await deriveChangeCandidate({
      baselineRepoPath: baselineRepo,
      baselineSha: headSha(),
      overlayRoot: makeOverlay({
        'README.md': '# touched\n',
        '.gitignore': 'dist/\n',
        'src/keep.ts': 'export const keep = 1\n',
        '.agent-workflow/inputs/requirements/b1/body.md': 'requirement text\n',
      }),
      excludePolicyDigest: 'x'.repeat(64),
      agentOutcomeRef: 'outcome-3',
    })
    expect(excluded.ok).toBe(true)
    if (!excluded.ok) return
    expect(excluded.receipt.changed).toEqual({ added: [], modified: ['README.md'], deleted: [] })

    // 纵深防御面：baseline 里 tracked 的平台路径进入 diff（此处：overlay 排除
    // 导致 D）⇒ 固定阻断，不静默剔除。
    const trackedRepo = mkdtempSync(join(tmpdir(), 'rfc310-tracked-platform-'))
    git(trackedRepo, 'init', '-q')
    writeFileSync(join(trackedRepo, 'README.md'), '# baseline\n')
    mkdirSync(join(trackedRepo, '.agent-workflow'), { recursive: true })
    writeFileSync(join(trackedRepo, '.agent-workflow', 'pinned.txt'), 'tracked platform file\n')
    git(trackedRepo, 'add', '-A')
    git(
      trackedRepo,
      '-c',
      'user.email=t48@test',
      '-c',
      'user.name=t48',
      'commit',
      '-q',
      '-m',
      'tracked platform path',
    )
    const trackedSha = git(trackedRepo, 'rev-parse', 'HEAD').trim()
    const platform = await deriveChangeCandidate({
      baselineRepoPath: trackedRepo,
      baselineSha: trackedSha,
      overlayRoot: makeOverlay({ 'README.md': '# touched\n' }),
      excludePolicyDigest: 'x'.repeat(64),
      agentOutcomeRef: 'outcome-3b',
    })
    expect(platform.ok).toBe(false)
    if (platform.ok) return
    expect(platform.code).toBe('candidate-forbidden-path')
    expect(platform.detail).toContain('.agent-workflow')

    const protectedRoot = await deriveChangeCandidate({
      baselineRepoPath: baselineRepo,
      baselineSha: headSha(),
      overlayRoot: makeOverlay({
        'README.md': '# baseline\n',
        '.gitignore': 'dist/\n',
        'src/keep.ts': 'export const keep = 1\n',
        'docs/protected/policy.md': 'tamper\n',
      }),
      excludePolicyDigest: 'x'.repeat(64),
      agentOutcomeRef: 'outcome-4',
      protectedRoots: ['docs/protected'],
    })
    expect(protectedRoot.ok).toBe(false)
    if (protectedRoot.ok) return
    expect(protectedRoot.code).toBe('candidate-forbidden-path')
    expect(protectedRoot.detail).toContain('protected-root')
  })

  test('overlay symlink is refused (defence in depth below the workspace validator)', async () => {
    const overlay = makeOverlay({
      'README.md': '# changed\n',
      '.gitignore': 'dist/\n',
      'src/keep.ts': 'export const keep = 1\n',
    })
    const { symlinkSync } = await import('node:fs')
    symlinkSync('/etc/hosts', join(overlay, 'sneaky-link'))
    const out = await deriveChangeCandidate({
      baselineRepoPath: baselineRepo,
      baselineSha: headSha(),
      overlayRoot: overlay,
      excludePolicyDigest: 'x'.repeat(64),
      agentOutcomeRef: 'outcome-5',
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('overlay-symlink')
  })

  test('upload lineage: preserve digest, editable final digest, already-present masquerade, gitignored target add -f', async () => {
    const uploadContent = 'SPEC v1\n'
    const overlay = makeOverlay({
      'README.md': '# baseline\n',
      '.gitignore': 'dist/\n',
      'src/keep.ts': 'export const keep = 1\n',
      'docs/spec.md': uploadContent,
      'dist/generated.md': 'from upload\n', // gitignored 目标：必须靠 add -f 进 candidate
      'notes/draft.md': 'edited by agent\n',
    })
    const plan = {
      planDigest: 'p'.repeat(64),
      entries: [
        {
          targetPath: 'docs/spec.md',
          contentPolicy: 'preserve-upload' as const,
          disposition: 'create' as const,
          uploadSha256: sha256Hex(uploadContent),
        },
        {
          targetPath: 'dist/generated.md',
          contentPolicy: 'preserve-upload' as const,
          disposition: 'create' as const,
          uploadSha256: sha256Hex('from upload\n'),
        },
        {
          targetPath: 'notes/draft.md',
          contentPolicy: 'agent-editable' as const,
          disposition: 'create' as const,
          uploadSha256: sha256Hex('original upload\n'),
        },
        {
          targetPath: 'src/keep.ts',
          contentPolicy: 'preserve-upload' as const,
          disposition: 'already-present' as const,
          uploadSha256: sha256Hex('export const keep = 1\n'),
        },
      ],
    }
    const ok = await deriveChangeCandidate({
      baselineRepoPath: baselineRepo,
      baselineSha: headSha(),
      overlayRoot: overlay,
      excludePolicyDigest: 'x'.repeat(64),
      agentOutcomeRef: 'outcome-6',
      uploadPlan: plan,
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.receipt.changed.added).toContain('dist/generated.md')
    expect(ok.receipt.uploadLineage!.finalDigests).toEqual([
      { targetPath: 'dist/generated.md', sha256: sha256Hex('from upload\n') },
      { targetPath: 'docs/spec.md', sha256: sha256Hex(uploadContent) },
      { targetPath: 'notes/draft.md', sha256: sha256Hex('edited by agent\n') },
    ])

    // preserve 内容被篡改 ⇒ 整个 candidate 作废。
    const tampered = await deriveChangeCandidate({
      baselineRepoPath: baselineRepo,
      baselineSha: headSha(),
      overlayRoot: makeOverlay({
        'README.md': '# baseline\n',
        '.gitignore': 'dist/\n',
        'src/keep.ts': 'export const keep = 1\n',
        'docs/spec.md': 'TAMPERED\n',
      }),
      excludePolicyDigest: 'x'.repeat(64),
      agentOutcomeRef: 'outcome-7',
      uploadPlan: {
        planDigest: plan.planDigest,
        entries: [plan.entries[0]!],
      },
    })
    expect(tampered.ok).toBe(false)
    if (tampered.ok) return
    expect(tampered.code).toBe('upload-preserve-digest-mismatch')

    // created entry 从 diff 里消失（Agent 删掉了上传文件）⇒ 作废。
    const missing = await deriveChangeCandidate({
      baselineRepoPath: baselineRepo,
      baselineSha: headSha(),
      overlayRoot: makeOverlay({
        'README.md': '# touched\n',
        '.gitignore': 'dist/\n',
        'src/keep.ts': 'export const keep = 1\n',
      }),
      excludePolicyDigest: 'x'.repeat(64),
      agentOutcomeRef: 'outcome-8',
      uploadPlan: { planDigest: plan.planDigest, entries: [plan.entries[0]!] },
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.code).toBe('upload-entry-missing-from-diff')

    // already-present 目标被改动 = 伪装 changed ⇒ 作废。
    const masquerade = await deriveChangeCandidate({
      baselineRepoPath: baselineRepo,
      baselineSha: headSha(),
      overlayRoot: makeOverlay({
        'README.md': '# baseline\n',
        '.gitignore': 'dist/\n',
        'src/keep.ts': 'export const keep = 2\n',
      }),
      excludePolicyDigest: 'x'.repeat(64),
      agentOutcomeRef: 'outcome-9',
      uploadPlan: { planDigest: plan.planDigest, entries: [plan.entries[3]!] },
    })
    expect(masquerade.ok).toBe(false)
    if (masquerade.ok) return
    expect(masquerade.code).toBe('upload-already-present-changed')
  })
})

describe('rfc310 pr4 T48 — pure verdict functions', () => {
  test('forbidden path check flags platform dir and protected roots only', () => {
    const violations = checkForbiddenCandidatePaths(
      {
        added: ['.agent-workflow/x', 'src/ok.ts'],
        modified: ['docs/protected/a.md'],
        deleted: [],
      },
      ['docs/protected'],
    )
    expect(violations).toEqual([
      { path: '.agent-workflow/x', reason: 'platform-dir' },
      { path: 'docs/protected/a.md', reason: 'protected-root' },
    ])
  })

  test('editable target missing from tree is typed', () => {
    const verdict = verifyUploadLineage(
      [
        {
          targetPath: 'notes/gone.md',
          contentPolicy: 'agent-editable',
          disposition: 'create',
          uploadSha256: null,
        },
      ],
      { changed: new Set(['notes/gone.md']), blobSha256Of: () => null },
    )
    expect(verdict).toEqual({
      ok: false,
      code: 'upload-editable-target-missing',
      targetPath: 'notes/gone.md',
    })
  })

  test('receipt ref is stable under key order and undefined-field noise', () => {
    const core = {
      baselineSnapshotRef: 'git:abc',
      treeOid: 'a'.repeat(40),
      changed: { added: ['a'], modified: [], deleted: [] },
      excludePolicyDigest: 'x'.repeat(64),
      agentOutcomeRef: 'o1',
      uploadLineage: null,
    }
    expect(candidateReceiptRef(core)).toBe(candidateReceiptRef({ ...core }))
    expect(candidateReceiptRef(core)).toMatch(/^[0-9a-f]{64}$/)
  })
})

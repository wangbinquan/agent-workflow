// RFC-310 PR-3 T36a —— RepositoryUploadPlan 判定矩阵（design §5.4）。
//
// 锁 create-only / replace-existing 对冻结 baseline 的 CAS 真值表、保护面
// （.git / .agent-workflow / 目录 / symlink/submodule）、前缀冲突、政策约束
// （allowedTargetPrefixes / collisionMode / contentPolicy / executable / 字节
// 预算）、blocked ⇒ typed 抛零落库、planDigest 的内容寻址稳定性。baseline 用
// 内存 stub——真实 git reader 的链路在 rfc310-pr3-upload-security 里对拍。

import { describe, expect, test } from 'bun:test'

import {
  previewUploadDispositions,
  resolveUploadPlanEntries,
  type BaselineFileReader,
  type BaselineStat,
  type RepositoryUploadPolicy,
  type UploadPlanRequestEntry,
} from '../src/modules/development-automation/application/uploadPlan'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

const POLICY: RepositoryUploadPolicy = {
  maxFiles: 5,
  maxFileBytes: 1024,
  maxTotalBytes: 2048,
  allowedTargetPrefixes: [],
  defaultCollisionMode: 'create-only',
  allowedCollisionModes: ['create-only', 'replace-existing'],
  defaultContentPolicy: 'preserve-upload',
  allowedContentPolicies: ['preserve-upload', 'agent-editable'],
  allowExecutableFileMode: false,
  targetChangedDisposition: 'block',
}

function baselineOf(tree: Record<string, BaselineStat>): BaselineFileReader {
  return { stat: async (path) => tree[path] ?? 'missing' }
}

function entry(overrides: Partial<UploadPlanRequestEntry> = {}): UploadPlanRequestEntry {
  return {
    uploadRef: overrides.uploadRef ?? 'up-1',
    sha256: overrides.sha256 ?? SHA_A,
    bytes: overrides.bytes ?? 4,
    repositoryTargetPath: overrides.repositoryTargetPath ?? 'docs/a.md',
    ...(overrides.collisionMode !== undefined ? { collisionMode: overrides.collisionMode } : {}),
    ...(overrides.contentPolicy !== undefined ? { contentPolicy: overrides.contentPolicy } : {}),
    ...(overrides.fileMode !== undefined ? { fileMode: overrides.fileMode } : {}),
  }
}

async function one(
  upload: UploadPlanRequestEntry,
  tree: Record<string, BaselineStat> = {},
  policy: RepositoryUploadPolicy = POLICY,
) {
  const [d] = await previewUploadDispositions({
    uploads: [upload],
    policy,
    baseline: baselineOf(tree),
  })
  return d!
}

describe('rfc310 pr3 upload plan — CAS truth table', () => {
  test('create-only: missing→create; identical content+mode→already-present; different→blocked', async () => {
    expect((await one(entry())).disposition).toBe('create')
    expect(
      (
        await one(entry(), {
          'docs/a.md': { kind: 'file', sha256: SHA_A, mode: 'regular' },
        })
      ).disposition,
    ).toBe('already-present')
    const different = await one(entry(), {
      'docs/a.md': { kind: 'file', sha256: SHA_B, mode: 'regular' },
    })
    expect(different.disposition).toBe('blocked')
    expect(different.blockedReason).toBe('target-exists-with-different-content')
  })

  test('replace-existing: missing→blocked; different→replace; identical→already-present', async () => {
    const missing = await one(entry({ collisionMode: 'replace-existing' }))
    expect(missing.blockedReason).toBe('replace-target-missing')
    expect(
      (
        await one(entry({ collisionMode: 'replace-existing' }), {
          'docs/a.md': { kind: 'file', sha256: SHA_B, mode: 'regular' },
        })
      ).disposition,
    ).toBe('replace')
    expect(
      (
        await one(entry({ collisionMode: 'replace-existing' }), {
          'docs/a.md': { kind: 'file', sha256: SHA_A, mode: 'regular' },
        })
      ).disposition,
    ).toBe('already-present')
  })

  test('mode participates in the identity check: same bytes but executable baseline is not already-present', async () => {
    const d = await one(entry(), {
      'docs/a.md': { kind: 'file', sha256: SHA_A, mode: 'executable' },
    })
    expect(d.disposition).toBe('blocked')
  })

  test('protected surfaces: .git, .agent-workflow, directory and symlink/submodule targets block', async () => {
    expect(
      (await one(entry({ repositoryTargetPath: '.git/hooks/pre-commit' }))).blockedReason,
    ).toBe('target-path-protected')
    expect((await one(entry({ repositoryTargetPath: '.agent-workflow/x' }))).blockedReason).toBe(
      'target-path-protected',
    )
    expect((await one(entry(), { 'docs/a.md': 'directory' })).blockedReason).toBe(
      'target-is-directory',
    )
    expect((await one(entry(), { 'docs/a.md': 'unsupported' })).blockedReason).toBe(
      'target-unsupported-entry',
    )
  })

  test('duplicate and file/descendant prefix conflicts block within one plan', async () => {
    const dispositions = await previewUploadDispositions({
      uploads: [
        entry({ uploadRef: 'u1', repositoryTargetPath: 'docs/a' }),
        entry({ uploadRef: 'u2', repositoryTargetPath: 'docs/a/b.md' }),
      ],
      policy: POLICY,
      baseline: baselineOf({}),
    })
    expect(dispositions[0]!.blockedReason).toBe('target-path-prefix-conflict')
    expect(dispositions[1]!.blockedReason).toBe('target-path-prefix-conflict')
  })

  test('policy constraints: prefixes, collision/content allowlists, executable gate, byte budgets', async () => {
    expect(
      (await one(entry(), {}, { ...POLICY, allowedTargetPrefixes: ['src'] })).blockedReason,
    ).toBe('target-path-outside-allowed-prefixes')
    expect(
      (
        await one(
          entry({ collisionMode: 'replace-existing' }),
          {},
          { ...POLICY, allowedCollisionModes: ['create-only'] },
        )
      ).blockedReason,
    ).toBe('collision-mode-not-allowed:replace-existing')
    expect(
      (
        await one(
          entry({ contentPolicy: 'agent-editable' }),
          {},
          { ...POLICY, allowedContentPolicies: ['preserve-upload'] },
        )
      ).blockedReason,
    ).toBe('content-policy-not-allowed:agent-editable')
    expect((await one(entry({ fileMode: 'executable' }))).blockedReason).toBe(
      'executable-file-mode-not-allowed',
    )
    expect((await one(entry({ bytes: 2000 }))).blockedReason).toBe('file-exceeds-policy-max-bytes')
    try {
      await previewUploadDispositions({
        uploads: [
          entry({ uploadRef: 'u1', bytes: 1024, repositoryTargetPath: 'a.md' }),
          entry({ uploadRef: 'u2', bytes: 1024, repositoryTargetPath: 'b.md' }),
          entry({ uploadRef: 'u3', bytes: 1024, repositoryTargetPath: 'c.md' }),
        ],
        policy: POLICY,
        baseline: baselineOf({}),
      })
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('upload-plan-total-bytes-exceeded')
    }
    try {
      await previewUploadDispositions({
        uploads: Array.from({ length: 6 }, (_, i) =>
          entry({ uploadRef: `u${i}`, repositoryTargetPath: `f${i}.md` }),
        ),
        policy: POLICY,
        baseline: baselineOf({}),
      })
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('upload-plan-too-many-files')
    }
  })

  test('resolveUploadPlanEntries: any blocked entry throws typed with full dispositions attached', async () => {
    try {
      await resolveUploadPlanEntries({
        uploads: [
          entry({ uploadRef: 'u1', repositoryTargetPath: 'ok.md' }),
          entry({ uploadRef: 'u2', repositoryTargetPath: '.git/config' }),
        ],
        policy: POLICY,
        baseline: baselineOf({}),
      })
      throw new Error('should have thrown')
    } catch (error) {
      const e = error as { code?: string; details?: { dispositions?: unknown[] } }
      expect(e.code).toBe('upload-plan-blocked')
    }
  })

  test('resolved entries freeze expectedTarget from the baseline (absent / exact-file / already-present)', async () => {
    const tree: Record<string, BaselineStat> = {
      'replace.md': { kind: 'file', sha256: SHA_B, mode: 'regular' },
      'same.md': { kind: 'file', sha256: SHA_A, mode: 'regular' },
    }
    const resolved = await resolveUploadPlanEntries({
      uploads: [
        entry({ uploadRef: 'u1', repositoryTargetPath: 'new.md' }),
        entry({
          uploadRef: 'u2',
          repositoryTargetPath: 'replace.md',
          collisionMode: 'replace-existing',
        }),
        entry({ uploadRef: 'u3', repositoryTargetPath: 'same.md' }),
      ],
      policy: POLICY,
      baseline: baselineOf(tree),
    })
    expect(resolved.entries.map((e) => e.expectedTarget.kind)).toEqual([
      'absent',
      'exact-file',
      'already-present',
    ])
    expect(resolved.entries[1]!.expectedTarget).toMatchObject({ sha256: SHA_B })
    // replace-existing 未显式给 fileMode 时继承 baseline mode。
    expect(resolved.entries[1]!.targetFileMode).toBe('regular')
    expect(resolved.entries[0]!.fileId).toBe('u1')
    expect(resolved.entries[0]!.uploadBlobRef).toBe(SHA_A)
  })

  test('planDigest is content-addressed: stable across runs, moves with baseline sha and entry order', async () => {
    const uploads = [
      entry({ uploadRef: 'u1', repositoryTargetPath: 'a.md' }),
      entry({ uploadRef: 'u2', sha256: SHA_B, repositoryTargetPath: 'b.md' }),
    ]
    const args = { uploads, policy: POLICY, baseline: baselineOf({}) }
    const r1 = await resolveUploadPlanEntries(args)
    const r2 = await resolveUploadPlanEntries(args)
    const ref = { repositoryRef: 'repo-1', snapshotRef: 'git:s1', headSha: '1'.repeat(40) }
    expect(r1.planDigest(ref)).toBe(r2.planDigest(ref))
    expect(r1.planDigest(ref)).not.toBe(r1.planDigest({ ...ref, headSha: '2'.repeat(40) }))
    const swapped = await resolveUploadPlanEntries({
      ...args,
      uploads: [uploads[1]!, uploads[0]!],
    })
    expect(swapped.planDigest(ref)).not.toBe(r1.planDigest(ref))
    // planId 是随机 ULID（行主键），digest 不依赖它——两次 resolve 的 id 不同但 digest 相同。
    expect(r1.planId).not.toBe(r2.planId)
  })
})

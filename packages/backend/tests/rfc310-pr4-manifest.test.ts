// RFC-310 PR-4 T45 —— AgentInputManifestV1 合同锁。
//
// 锁三件事：①strict + 无 host path（绝对路径/../\\ 在 mount/target 一律拒）；
// ②inputDigest 内容寻址——nonce 变不影响 digest（§7.7 fresh rerun 换 nonce
// 不换输入）、任何内容字段变则 digest 变、自报错 digest 被 schema 拒；
// ③上传约束 entries 严格按 ordinal 排序。

import { describe, expect, test } from 'bun:test'

import {
  agentInputManifestV1Schema,
  computeAgentInputDigest,
} from '../src/modules/development-automation/domain/agentInputManifest'
import { draftManifest, makeManifest, TEST_NONCE } from './helpers/rfc310Pr4Manifest'

describe('rfc310 pr4 — agent input manifest', () => {
  test('valid manifest round-trips with a content-addressed inputDigest', () => {
    const manifest = makeManifest()
    expect(manifest.inputDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(agentInputManifestV1Schema.parse(manifest)).toEqual(manifest)
  })

  test('nonce does not participate in the input digest; content does', () => {
    const base = draftManifest()
    const withOtherNonce = draftManifest({
      protocol: { ...base.protocol, nonce: 'another-nonce-9876543210' },
    })
    expect(computeAgentInputDigest(base)).toBe(computeAgentInputDigest(withOtherNonce))

    const withOtherHead = draftManifest({ baseHeadSha: 'c'.repeat(40) })
    expect(computeAgentInputDigest(base)).not.toBe(computeAgentInputDigest(withOtherHead))
  })

  test('a self-reported wrong inputDigest is rejected', () => {
    const manifest = makeManifest()
    const forged = { ...manifest, inputDigest: 'd'.repeat(64) }
    expect(agentInputManifestV1Schema.safeParse(forged).success).toBe(false)
  })

  test('host paths cannot enter mount or target paths', () => {
    for (const mountPath of ['/abs/path', '../escape', 'a/../b', 'C:/win', 'a\\b']) {
      const draft = draftManifest({
        requirementBundle: {
          bundleId: 'b',
          manifestDigest: 'b'.repeat(64),
          mountPath,
          fileCount: 1,
          totalBytes: 1,
        },
      })
      const parsed = agentInputManifestV1Schema.safeParse({
        ...draft,
        inputDigest: computeAgentInputDigest(draft),
      })
      expect(parsed.success).toBe(false)
    }
  })

  test('unknown keys are rejected (strict head)', () => {
    const manifest = makeManifest()
    const withExtra = { ...manifest, hostPath: '/etc' }
    expect(agentInputManifestV1Schema.safeParse(withExtra).success).toBe(false)
  })

  test('upload constraint entries must be strictly ordinal-sorted', () => {
    const entry = (ordinal: number, targetPath: string) => ({
      ordinal,
      targetPath,
      contentPolicy: 'preserve-upload' as const,
      fileMode: 'regular' as const,
      originalEvidenceFileId: `f-${ordinal}`,
    })
    const sortedDraft = draftManifest({
      repositoryUploads: {
        planDigest: 'e'.repeat(64),
        placementDigest: 'f'.repeat(64),
        entries: [entry(0, 'docs/a.md'), entry(1, 'docs/b.md')],
      },
    })
    expect(
      agentInputManifestV1Schema.safeParse({
        ...sortedDraft,
        inputDigest: computeAgentInputDigest(sortedDraft),
      }).success,
    ).toBe(true)

    const unsortedDraft = draftManifest({
      repositoryUploads: {
        planDigest: 'e'.repeat(64),
        placementDigest: 'f'.repeat(64),
        entries: [entry(1, 'docs/b.md'), entry(0, 'docs/a.md')],
      },
    })
    expect(
      agentInputManifestV1Schema.safeParse({
        ...unsortedDraft,
        inputDigest: computeAgentInputDigest(unsortedDraft),
      }).success,
    ).toBe(false)
  })

  test('nonce still lives in the manifest for the protocol block', () => {
    expect(makeManifest().protocol.nonce).toBe(TEST_NONCE)
  })
})

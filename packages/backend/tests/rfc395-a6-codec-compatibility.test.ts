// RFC-395 II-a A6 — 旧 binary 回滚仍可读新写入；codec 形状、错误与 II-b 显式开关独立于 provider。
import { expect, test } from 'bun:test'
import { ZodError } from 'zod'
import {
  createIntentApplyArtifactCodecs,
  intentApplyArtifactCodecs,
} from '@/modules/intent/infrastructure/intentApplyArtifactCodec'
import {
  createResourcePackageArtifactCodecs,
  resourcePackageArtifactCodecs,
  decodeResourcePackageRecoveryRow,
  decodeResourcePackageReceiptJson,
} from '@/modules/resource-catalog/infrastructure/resourcePackageArtifactCodec'
import { decideAtomicApplyConverge } from '@/platform/atomic-apply/convergence'

const oldStage = {
  kind: 'skill-stage',
  skillId: 's',
  opId: 'old-op',
  skillDir: '/skills/s',
} as const
const oldVersion = {
  kind: 'skill-version-stage' as const,
  staged: {
    skillId: 's',
    skillName: 'skill',
    opId: 'old-op',
    publishId: 'publish',
    newVersion: 2,
    newHash: 'hash',
    filesDir: '/skills/s/files',
    versionDir: '/skills/s/versions/2',
    stagingDir: '/skills/s/staged',
    noop: null,
  },
}
const plugin = {
  kind: 'plugin-install',
  pluginId: 'p',
  generationId: 'g',
  generationDir: '/g',
} as const
const packagePlugin = {
  kind: 'plugin-install',
  pluginId: 'p',
  operationId: 'op',
  generationId: 'g',
  generationDirectory: '/g',
} as const

for (const [scene, version, head, switched, artifacts] of [
  [
    'intent',
    2,
    intentApplyArtifactCodecs,
    createIntentApplyArtifactCodecs('versioned-envelope'),
    [plugin],
  ],
  [
    'resource-package',
    1,
    resourcePackageArtifactCodecs,
    createResourcePackageArtifactCodecs('versioned-envelope'),
    [packagePlugin],
  ],
] as const) {
  test(`${scene} writes HEAD bytes until its II-b switch and supports envelope encode/decode`, () => {
    // 二者的插件形状不同，用各自 registry 的输入类型保留类型约束。
    const encoded =
      scene === 'intent'
        ? intentApplyArtifactCodecs.encode([plugin])
        : resourcePackageArtifactCodecs.encode([packagePlugin])
    const envelope =
      scene === 'intent'
        ? createIntentApplyArtifactCodecs('versioned-envelope').encode([plugin])
        : createResourcePackageArtifactCodecs('versioned-envelope').encode([packagePlugin])
    expect(head.encode([])).toBe('[]')
    expect(encoded).toBe(JSON.stringify(artifacts))
    expect(envelope).toBe(JSON.stringify({ scene, version, artifacts }))
    expect(switched.encode([])).toBe(JSON.stringify({ scene, version, artifacts: [] }))
    expect(head.decode(encoded)).toEqual(artifacts)
    expect(head.decode(envelope)).toEqual(artifacts)
    expect(switched.decode(encoded)).toEqual(artifacts)
    expect(switched.decode(envelope)).toEqual(artifacts)
    expect(() => head.decode(JSON.stringify({ scene, version: 999, artifacts: [] }))).toThrow(
      `atomic-apply-artifact-version-unsupported:${scene}:999`,
    )
  })
}

test('Intent retains HEAD plugin field errors and rejects persisted derived kinds', () => {
  for (const artifact of [
    { kind: 'plugin-install', pluginId: 'p' },
    { kind: 'plugin-install', pluginId: 'p', generationDir: '/g' },
  ])
    expect(() => intentApplyArtifactCodecs.decode(JSON.stringify([artifact]))).toThrow(
      'intent-apply-artifact-generationId-invalid',
    )
  expect(() =>
    intentApplyArtifactCodecs.decode(
      JSON.stringify([{ kind: 'plugin-install', pluginId: 'p', generationId: 'g' }]),
    ),
  ).toThrow('intent-apply-artifact-generationDir-invalid')
  expect(() =>
    intentApplyArtifactCodecs.decode('[{"kind":"legacy-plugin-install-untracked","pluginId":"p"}]'),
  ).toThrow('legacy intent journal artifact is invalid:')
  expect(() => intentApplyArtifactCodecs.decode('{')).toThrow(
    'intent apply journal artifacts are not valid JSON',
  )
})

test('Intent accepts V1 staged versions only in the V1 envelope, preserving HEAD bare-array semantics', () => {
  expect(
    intentApplyArtifactCodecs.decode(JSON.stringify({ version: 1, artifacts: [oldVersion] })),
  ).toEqual([oldVersion])
  expect(intentApplyArtifactCodecs.decode(JSON.stringify([oldStage, plugin]))).toEqual([
    oldStage,
    plugin,
  ])
  for (const artifact of [oldVersion, { kind: 'skill-version-stage', skillId: 's', opId: 'old' }]) {
    expect(() => intentApplyArtifactCodecs.decode(JSON.stringify([artifact]))).toThrow(
      'legacy skill-version-stage artifact is incomplete and cannot be converged safely',
    )
  }
})

test('package selects one format for the entire array and retains receipt pairing', () => {
  const currentReceipt = {
    journalId: 'j',
    applied: [
      {
        operationId: 'op',
        resourceType: 'plugin',
        resourceId: 'p',
        name: 'plugin',
        action: 'create',
      },
    ],
  }
  const legacyReceipt = {
    journalId: 'j',
    applied: [
      { opId: 'op', resourceType: 'plugin', resourceId: 'p', name: 'plugin', action: 'create' },
    ],
  }
  const row = (artifacts: readonly unknown[], receipt = currentReceipt) => ({
    id: 'j',
    preparedArtifactsJson: JSON.stringify(artifacts),
    receiptJson: JSON.stringify(receipt),
  })
  expect(
    resourcePackageArtifactCodecs.decode(JSON.stringify([oldStage, oldVersion, plugin])),
  ).toEqual([oldStage, oldVersion, plugin])
  expect(() =>
    resourcePackageArtifactCodecs.decode(JSON.stringify([packagePlugin, oldStage])),
  ).toThrow(ZodError)
  expect(decodeResourcePackageRecoveryRow(row([packagePlugin]), 'rollForward').format).toBe(
    'current',
  )
  expect(
    decodeResourcePackageRecoveryRow(
      { ...row([oldStage]), receiptJson: JSON.stringify(legacyReceipt) },
      'rollForward',
    ).format,
  ).toBe('legacy')
  expect(() =>
    decodeResourcePackageRecoveryRow(
      { ...row([packagePlugin]), receiptJson: JSON.stringify(legacyReceipt) },
      'rollForward',
    ),
  ).toThrow(ZodError)
  expect(() => decodeResourcePackageReceiptJson(JSON.stringify(legacyReceipt))).toThrow(ZodError)
  expect(
    decodeResourcePackageRecoveryRow(
      { ...row([]), receiptJson: JSON.stringify(legacyReceipt) },
      'rollForward',
    ).format,
  ).toBe('legacy')
  expect(() =>
    decodeResourcePackageRecoveryRow({ ...row([oldStage]), receiptJson: null }, 'rollForward'),
  ).toThrow('resource-package-committed-receipt-missing:j')
})

test('pure convergence decisions preserve fresh/active claims and retry committed tails', () => {
  const row = { id: 'j', state: 'prepared' as const, updatedAt: 1 }
  expect(
    decideAtomicApplyConverge(row, { reapBefore: 2, activeJournalIds: new Set(['j']) }).kind,
  ).toBe('skip')
  expect(decideAtomicApplyConverge(row, { reapBefore: 0, activeJournalIds: new Set() }).kind).toBe(
    'skip',
  )
  expect(decideAtomicApplyConverge(row, { reapBefore: 1, activeJournalIds: new Set() }).kind).toBe(
    'compensate',
  )
  expect(
    decideAtomicApplyConverge(
      { ...row, state: 'failed' },
      { reapBefore: 2, activeJournalIds: new Set() },
    ).kind,
  ).toBe('skip')
  expect(
    decideAtomicApplyConverge(
      { ...row, state: 'committed' },
      { reapBefore: 0, activeJournalIds: new Set(['j']) },
    ).kind,
  ).toBe('roll-forward')
})

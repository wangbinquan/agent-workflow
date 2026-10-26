// RFC-395 II-b: source codecs belong to conversion; live recovery accepts target envelopes only.
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

import { reencodeIntentApplyArtifacts } from '@/modules/intent/infrastructure/migration/applyJournalRule'
import { decodeIntentJournalArtifacts } from '@/modules/intent/infrastructure/migration/intentApplyLegacyCodec'
import {
  reencodeBundleApplyArtifacts,
  reencodeBundleApplyReceipt,
} from '@/modules/resource-catalog/infrastructure/migration/bundleAppliesRule'

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
  operationId: 'op',
  pluginId: 'p',
  generationId: 'g',
  generationDirectory: '/g',
} as const

for (const [scene, version, registry, artifacts] of [
  ['intent', 3, intentApplyArtifactCodecs, [plugin]],
  ['resource-package', 2, resourcePackageArtifactCodecs, [packagePlugin]],
] as const) {
  test(`${scene} writes only its activated scene/version envelope`, () => {
    const encoded =
      scene === 'intent'
        ? intentApplyArtifactCodecs.encode([plugin])
        : resourcePackageArtifactCodecs.encode([packagePlugin])
    expect(registry.encode([])).toBe(JSON.stringify({ scene, version, artifacts: [] }))
    expect(encoded).toBe(JSON.stringify({ scene, version, artifacts }))
    expect(registry.decode(encoded)).toEqual(artifacts)
    expect(() => registry.decode(JSON.stringify(artifacts))).toThrow(
      'atomic-apply-artifact-envelope-invalid',
    )
    expect(() =>
      registry.decode(JSON.stringify({ scene, version: version - 1, artifacts: [] })),
    ).toThrow('version-unsupported')
    expect(() => registry.decode(JSON.stringify({ scene, version: 999, artifacts: [] }))).toThrow(
      `atomic-apply-artifact-version-unsupported:${scene}:999`,
    )
    expect(() =>
      scene === 'intent'
        ? Reflect.apply(createIntentApplyArtifactCodecs, undefined, ['head-array'])
        : Reflect.apply(createResourcePackageArtifactCodecs, undefined, ['head-array']),
    ).toThrow(`atomic-apply-write-format-unsupported:${scene}`)
  })
}

const intentEnvelope = (artifacts: readonly unknown[]) =>
  JSON.stringify({ scene: 'intent', version: 3, artifacts })

test('Intent target envelopes retain plugin field errors and reject derived source kinds', () => {
  for (const artifact of [
    { kind: 'plugin-install', pluginId: 'p' },
    { kind: 'plugin-install', pluginId: 'p', generationDir: '/g' },
  ])
    expect(() => intentApplyArtifactCodecs.decode(intentEnvelope([artifact]))).toThrow(
      'intent-apply-artifact-generationId-invalid',
    )
  expect(() =>
    intentApplyArtifactCodecs.decode(
      intentEnvelope([{ kind: 'plugin-install', pluginId: 'p', generationId: 'g' }]),
    ),
  ).toThrow('intent-apply-artifact-generationDir-invalid')
  expect(() =>
    intentApplyArtifactCodecs.decode(
      intentEnvelope([{ kind: 'legacy-plugin-install-untracked', pluginId: 'p' }]),
    ),
  ).toThrow('intent apply journal artifact is invalid')
  expect(() => intentApplyArtifactCodecs.decode('{')).toThrow(
    'intent apply journal artifacts are not valid JSON',
  )
})

test('Intent converts complete V1 versions and bare source creates, rejecting incomplete versions', () => {
  const source = JSON.stringify({ version: 1, artifacts: [oldVersion] })
  expect(decodeIntentJournalArtifacts(source)).toEqual([oldVersion])
  expect(intentApplyArtifactCodecs.decode(reencodeIntentApplyArtifacts(source))).toEqual([
    {
      kind: 'skill-version-stage',
      skillId: 's',
      operationId: 'publish',
      version: 2,
      stagingDirectory: '/skills/s/staged',
      versionDirectory: '/skills/s/versions/2',
      recovery: {
        kind: 'version',
        operationId: 'old-op',
        publishId: 'publish',
        skillName: 'skill',
        contentHash: 'hash',
        liveDirectory: '/skills/s/files',
      },
    },
  ])
  expect(
    intentApplyArtifactCodecs.decode(
      reencodeIntentApplyArtifacts(JSON.stringify([oldStage, plugin])),
    ),
  ).toEqual([
    {
      kind: 'skill-stage',
      skillId: 's',
      operationId: 'old-op',
      stagingDirectory: '/skills/s',
      recovery: { kind: 'create', operationId: 'old-op', rootDirectory: '/skills/s' },
    },
    plugin,
  ])
  for (const artifact of [oldVersion, { kind: 'skill-version-stage', skillId: 's', opId: 'old' }])
    expect(() => reencodeIntentApplyArtifacts(JSON.stringify([artifact]))).toThrow(
      'legacy skill-version-stage artifact is incomplete and cannot be converged safely',
    )
  expect(() => intentApplyArtifactCodecs.decode(source)).toThrow('envelope-invalid')
})

test('package converter selects one source format for the whole array and preserves receipt pairing', () => {
  const applied = {
    operationId: 'op',
    resourceType: 'plugin' as const,
    resourceId: 'p',
    name: 'plugin',
    action: 'create' as const,
  }
  const currentReceipt = { journalId: 'j', applied: [applied] }
  const legacyReceipt = {
    journalId: 'j',
    applied: [{ ...applied, operationId: undefined, opId: 'op' }],
  }
  const converted = resourcePackageArtifactCodecs.decode(
    reencodeBundleApplyArtifacts(JSON.stringify([oldStage, oldVersion, plugin]), null),
  )
  expect(converted).toEqual([
    {
      kind: 'skill-stage',
      skillId: 's',
      operationId: 'old-op',
      stagingDirectory: '/skills/s',
      targetDirectory: '/skills/s',
      recovery: { kind: 'create', operationId: 'old-op', rootDirectory: '/skills/s' },
    },
    {
      kind: 'skill-version-stage',
      skillId: 's',
      operationId: 'publish',
      publishId: 'publish',
      version: 2,
      stagingDirectory: '/skills/s/staged',
      versionDirectory: '/skills/s/versions/2',
      recovery: {
        kind: 'version',
        operationId: 'old-op',
        publishId: 'publish',
        skillName: 'skill',
        contentHash: 'hash',
        liveDirectory: '/skills/s/files',
      },
    },
    { ...packagePlugin, operationId: 'g' },
  ])
  expect(() =>
    reencodeBundleApplyArtifacts(JSON.stringify([packagePlugin, oldStage]), null),
  ).toThrow(ZodError)
  const receipt = reencodeBundleApplyReceipt(JSON.stringify(legacyReceipt))!
  expect(decodeResourcePackageReceiptJson(receipt)).toEqual(currentReceipt)
  const row = {
    id: 'j',
    preparedArtifactsJson: reencodeBundleApplyArtifacts(JSON.stringify([plugin]), receipt),
    receiptJson: receipt,
  }
  expect(decodeResourcePackageRecoveryRow(row, 'rollForward')).toEqual({
    format: 'current',
    artifacts: [packagePlugin],
  })
  expect(() =>
    decodeResourcePackageRecoveryRow(
      { ...row, receiptJson: JSON.stringify(legacyReceipt) },
      'rollForward',
    ),
  ).toThrow(ZodError)
  expect(() => decodeResourcePackageReceiptJson(JSON.stringify(legacyReceipt))).toThrow(ZodError)
  expect(
    decodeResourcePackageRecoveryRow(
      { ...row, preparedArtifactsJson: reencodeBundleApplyArtifacts('[]', receipt) },
      'rollForward',
    ),
  ).toEqual({ format: 'current', artifacts: [] })
  expect(() =>
    decodeResourcePackageRecoveryRow({ ...row, receiptJson: null }, 'rollForward'),
  ).toThrow('resource-package-committed-receipt-missing:j')
  expect(() =>
    decodeResourcePackageRecoveryRow(
      { ...row, preparedArtifactsJson: JSON.stringify([oldStage]) },
      'compensate',
    ),
  ).toThrow('envelope-invalid')
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

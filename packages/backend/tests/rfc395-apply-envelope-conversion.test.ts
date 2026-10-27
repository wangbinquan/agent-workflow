// RFC-395 P: every readable source journal becomes a target envelope; source bytes stay archived.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { convertFixtures, readFixtureRows } from './helpers/rfc395V2/collabFixtures'
import { decodeStagedValue } from '@/platform/persistence/migration/conversion/staging'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import {
  applyJournalRule,
  reencodeIntentApplyArtifacts,
} from '@/modules/intent/infrastructure/migration/applyJournalRule'
import {
  bundleAppliesRule,
  reencodeBundleApplyArtifacts,
  reencodeBundleApplyReceipt,
} from '@/modules/resource-catalog/infrastructure/migration/bundleAppliesRule'
import { intentApplyArtifactCodecs } from '@/modules/intent/infrastructure/intentApplyArtifactCodec'
import { resourcePackageArtifactCodecs } from '@/modules/resource-catalog/infrastructure/resourcePackageArtifactCodec'
import { readOnlyProbes as intentProbes } from '@/modules/intent/composition/conversion'
import { readOnlyProbes as resourceProbes } from '@/modules/resource-catalog/infrastructure/migration/probes'
import { collectReadOnlyProbes } from '@/platform/persistence/migration/run/probes'

// Slowest case took 3.37 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

const plugin = {
  kind: 'plugin-install',
  pluginId: 'plugin',
  generationId: 'persisted-generation',
  generationDir: '/source/plugin',
} as const
const stage = {
  kind: 'skill-version-stage',
  staged: {
    skillId: 'skill',
    skillName: 'skill',
    opId: 'persisted-operation',
    publishId: 'persisted-publish',
    newVersion: 2,
    newHash: 'persisted-hash',
    filesDir: '/source/skill/files',
    versionDir: '/source/skill/versions/v2/files',
    stagingDir: '/source/skill/files.op-persisted-publish.staged',
    noop: null,
  },
} as const
const contribution = { rules: [applyJournalRule, bundleAppliesRule], validators: [], lookups: [] }

describeV2Providers('RFC-395 P journal envelope conversion', (h) => {
  test('all four states preserve keys, timestamps, errors and every original artifact byte', async () => {
    await h.install()
    await h.write('intent_sessions', [
      { id: 'session', owner_user_id: 'owner', created_at: 1, updated_at: 1 },
    ])
    for (const [index, state] of ['prepared', 'applying', 'committed', 'failed'].entries()) {
      const intentSources = [
        JSON.stringify([plugin]),
        JSON.stringify({ version: 1, artifacts: [stage] }),
        JSON.stringify({ scene: 'intent', version: 2, artifacts: [plugin] }),
        intentApplyArtifactCodecs.encode([]),
      ]
      const packageSources = [
        JSON.stringify([plugin]),
        JSON.stringify([stage]),
        JSON.stringify({
          scene: 'resource-package',
          version: 1,
          artifacts: [
            {
              ...plugin,
              generationDir: undefined,
              generationDirectory: plugin.generationDir,
              operationId: 'persisted-package-op',
            },
          ],
        }),
        resourcePackageArtifactCodecs.encode([]),
      ]
      const common = {
        state,
        created_at: 10,
        updated_at: 20,
        error: state === 'failed' ? 'source failure' : null,
      }
      await h.write('intent_apply_journal', [
        {
          ...common,
          id: `intent-${index}`,
          session_id: 'session',
          client_mutation_id: `intent-key-${index}`,
          draft_id: 'draft',
          draft_hash: 'persisted-draft',
          prepared_artifacts_json: ` ${intentSources[index]}\n`,
          receipt_json:
            state === 'committed'
              ? '{ "journalId":"intent-2", "commitSeq":7, "applied":[] }\n'
              : null,
        },
      ])
      await h.write('resource_bundle_applies', [
        {
          ...common,
          id: `package-${index}`,
          scope: 'scope',
          key: `package-key-${index}`,
          actor_user_id: 'owner',
          prepared_artifacts_json: ` ${packageSources[index]}\n`,
          receipt_json:
            state === 'committed'
              ? '{ "journalId":"package-2", "applied":[{"opId":"persisted-package-op","resourceType":"plugin","resourceId":"plugin","action":"create","name":"plugin"}] }\n'
              : null,
        },
      ])
    }
    const source = [
      ...(await readFixtureRows(h, 'intent_apply_journal')),
      ...(await readFixtureRows(h, 'resource_bundle_applies')),
    ]
    const { summary, sink, units, dispositions } = await convertFixtures(h, [contribution])
    expect(summary.status).toBe('converted')
    const archived = units
      .flatMap((unit) => unit.archives)
      .map((archive) => decodeStagedValue<SourceRow>(new TextDecoder().decode(archive.bytes)))
    expect(archived).toHaveLength(8)
    expect(dispositions).toHaveLength(8)
    for (const row of source) {
      expect(
        archived.find((entry) => entry.table === row.table && entry.encodedKey === row.encodedKey)
          ?.values,
      ).toEqual(row.values)
      const target = sink.rows(row.table).find((entry) => entry.id === row.values.id)!
      for (const key of Object.keys(row.values).filter(
        (key) => !['prepared_artifacts_json', 'receipt_json'].includes(key),
      ))
        expect(target[key]).toEqual(row.values[key])
      const envelope = JSON.parse(String(target.prepared_artifacts_json))
      expect(envelope).toMatchObject({
        scene: row.table === 'intent_apply_journal' ? 'intent' : 'resource-package',
        version: row.table === 'intent_apply_journal' ? 3 : 2,
      })
      if (row.table === 'intent_apply_journal') {
        expect(target.receipt_json).toBe(row.values.receipt_json)
        expect(intentApplyArtifactCodecs.decode(String(target.prepared_artifacts_json))).toEqual(
          envelope.artifacts,
        )
      } else {
        expect(
          resourcePackageArtifactCodecs.decode(String(target.prepared_artifacts_json)),
        ).toEqual(envelope.artifacts)
      }
    }
    expect(
      JSON.parse(
        String(
          sink.rows('resource_bundle_applies').find((row) => row.id === 'package-2')!.receipt_json,
        ),
      ).applied[0].operationId,
    ).toBe('persisted-package-op')
    expect(applyJournalRule.ref.version).toBe(3)
    expect(bundleAppliesRule.ref.version).toBe(3)
  }, 180_000)

  test.each(['prepared', 'applying', 'committed'])(
    'undecodable %s rows still block with source evidence and no runnable target rows',
    async (state) => {
      await h.install()
      await h.write('intent_sessions', [
        { id: 'session', owner_user_id: 'owner', created_at: 1, updated_at: 1 },
      ])
      for (const [index, payload] of ['[]', '{ broken JSON'].entries()) {
        await h.write('intent_apply_journal', [
          {
            id: `intent-${index}`,
            session_id: 'session',
            client_mutation_id: `key-${index}`,
            draft_id: 'draft',
            draft_hash: 'hash',
            state,
            prepared_artifacts_json:
              index === 0 ? '{ "scene":"intent", "version":900, "artifacts":[] }\n' : payload,
            created_at: 1,
            updated_at: 2,
          },
        ])
        await h.write('resource_bundle_applies', [
          {
            id: `bundle-${index}`,
            scope: 'scope',
            key: `key-${index}`,
            actor_user_id: 'owner',
            state,
            prepared_artifacts_json: payload,
            receipt_json: index === 0 ? '{"unrecognized":true}' : null,
            created_at: 1,
            updated_at: 2,
          },
        ])
      }
      const { summary, sink, units } = await convertFixtures(h, [contribution])
      expect(summary.status).toBe('blocked')
      expect(sink.rows('intent_apply_journal')).toEqual([])
      expect(sink.rows('resource_bundle_applies')).toEqual([])
      expect(units.flatMap((unit) => unit.blocks).map((block) => block.code)).toContain(
        'v2-intent-artifact-undecodable',
      )
      expect(units.flatMap((unit) => unit.blocks).map((block) => block.code)).toContain(
        'v2-bundle-artifact-undecodable',
      )
      expect(units.flatMap((unit) => unit.archives)).toHaveLength(4)
    },
    180_000,
  )

  test('failed undecodable payloads and receipts become archived history with empty target envelopes', async () => {
    await h.install()
    await h.write('intent_sessions', [
      { id: 'session', owner_user_id: 'owner', created_at: 1, updated_at: 1 },
    ])
    const cases = [
      {
        artifacts: ' [{"kind":"skill-version-stage","skillId":"skill","opId":"old"}]\n',
        receipt: null,
      },
      { artifacts: ' { broken artifact JSON\n', receipt: null },
      { artifacts: '[]', receipt: ' { broken receipt JSON\n' },
    ]
    for (const [index, source] of cases.entries()) {
      const common = {
        state: 'failed',
        error: `original failure ${index}`,
        created_at: 17,
        updated_at: 29,
        prepared_artifacts_json: source.artifacts,
        receipt_json: source.receipt,
      }
      await h.write('intent_apply_journal', [
        {
          ...common,
          id: `intent-${index}`,
          session_id: 'session',
          client_mutation_id: `intent-key-${index}`,
          draft_id: 'draft',
          draft_hash: 'original-digest',
        },
      ])
      await h.write('resource_bundle_applies', [
        {
          ...common,
          id: `bundle-${index}`,
          scope: 'scope',
          key: `bundle-key-${index}`,
          actor_user_id: 'owner',
        },
      ])
    }
    await h.write('resource_bundle_applies', [
      {
        id: 'bundle-receipt',
        scope: 'scope',
        key: 'receipt-key',
        actor_user_id: 'owner',
        state: 'failed',
        error: 'original receipt failure',
        created_at: 17,
        updated_at: 29,
        prepared_artifacts_json: '[]',
        receipt_json: ' {"unknownReceipt":true}\n',
      },
    ])
    const { summary, sink, units, dispositions } = await convertFixtures(h, [contribution])
    expect(summary.status).toBe('converted')
    expect(units.flatMap((unit) => unit.blocks)).toEqual([])
    const archives = units.flatMap((unit) => unit.archives)
    expect(archives).toHaveLength(7)
    const histories = dispositions.filter((entry) => entry.class === 'archived')
    expect(histories).toHaveLength(7)
    for (const disposition of histories) {
      expect(disposition.kind).toBe('archived')
      expect(disposition.decision?.code).toMatch(/^v2-(intent|bundle)-artifact-history-only$/)
      expect(disposition.targets).toHaveLength(1)
      const archive = archives.find((entry) => entry.ref === disposition.archive)!
      const source = decodeStagedValue<SourceRow>(new TextDecoder().decode(archive.bytes))
      const target = sink.rows(source.table).find((entry) => entry.id === source.values.id)!
      const registry =
        source.table === 'intent_apply_journal'
          ? intentApplyArtifactCodecs
          : resourcePackageArtifactCodecs
      expect(target).toEqual({
        ...source.values,
        prepared_artifacts_json: registry.encode([]),
        receipt_json: source.codecTakeovers?.some((entry) => entry.column === 'receipt_json')
          ? null
          : source.values.receipt_json!,
      })
      expect(registry.decode(String(target.prepared_artifacts_json))).toEqual([])
      if (source.values.id === 'bundle-receipt') {
        expect(source.values.receipt_json).toBe(' {"unknownReceipt":true}\n')
      } else {
        const original = cases[Number(String(source.values.id).split('-')[1])]!
        expect(source.values.prepared_artifacts_json).toBe(original.artifacts)
        expect(source.values.receipt_json).toBe(original.receipt)
      }
      for (const takeover of source.codecTakeovers ?? [])
        expect(
          dispositions.some(
            (entry) =>
              entry.sourceTable === source.table &&
              entry.sourceKey === source.encodedKey &&
              entry.codecColumns?.includes(takeover.column),
          ),
        ).toBe(true)
    }
  }, 180_000)
})

test('source operation and publication identities survive, and noop SQL rows never enter target envelopes', () => {
  expect(
    intentApplyArtifactCodecs.decode(
      reencodeIntentApplyArtifacts('[{"kind":"plugin-install","pluginId":"old-untracked"}]'),
    ),
  ).toEqual([])
  const encoded = reencodeIntentApplyArtifacts(JSON.stringify({ version: 1, artifacts: [stage] }))
  expect(intentApplyArtifactCodecs.decode(encoded)).toEqual([
    {
      kind: 'skill-version-stage',
      skillId: 'skill',
      operationId: 'persisted-publish',
      version: 2,
      stagingDirectory: stage.staged.stagingDir,
      versionDirectory: stage.staged.versionDir,
      recovery: {
        kind: 'version',
        operationId: 'persisted-operation',
        publishId: 'persisted-publish',
        skillName: 'skill',
        contentHash: 'persisted-hash',
        liveDirectory: stage.staged.filesDir,
      },
    },
  ])
  const noop = {
    ...stage,
    staged: {
      ...stage.staged,
      noop: { filesPath: '/retired/sql/path', legacyColumn: 'archived only' },
    },
  }
  expect(
    intentApplyArtifactCodecs.decode(
      reencodeIntentApplyArtifacts(JSON.stringify({ version: 1, artifacts: [noop] })),
    ),
  ).toEqual([])
  expect(
    resourcePackageArtifactCodecs.decode(
      reencodeBundleApplyArtifacts(JSON.stringify([noop]), null),
    ),
  ).toEqual([])
  expect(encoded).not.toContain('"staged"')
  expect(encoded).not.toContain('"noop"')
  const receipt = reencodeBundleApplyReceipt(
    JSON.stringify({
      journalId: 'journal',
      applied: [
        {
          opId: 'receipt-operation',
          resourceType: 'skill',
          resourceId: 'skill',
          action: 'update',
          name: 'skill',
        },
      ],
    }),
  )
  const artifacts = resourcePackageArtifactCodecs.decode(
    reencodeBundleApplyArtifacts(JSON.stringify([stage]), receipt),
  )
  expect(artifacts[0]).toMatchObject({
    operationId: 'receipt-operation',
    publishId: 'persisted-publish',
    recovery: { operationId: 'persisted-operation' },
  })
  expect(reencodeBundleApplyReceipt(receipt)).toBe(receipt)
})

test('runtime registries reject bare arrays, source envelopes, unknown versions and foreign scenes', () => {
  for (const registry of [intentApplyArtifactCodecs, resourcePackageArtifactCodecs]) {
    expect(() => registry.decode('[]')).toThrow('atomic-apply-artifact-envelope-invalid')
    expect(() => registry.decode('{"version":1,"artifacts":[]}')).toThrow(
      'atomic-apply-artifact-envelope-invalid',
    )
    expect(registry.decode(registry.encode([]))).toEqual([])
  }
  expect(() =>
    intentApplyArtifactCodecs.decode('{"scene":"intent","version":2,"artifacts":[]}'),
  ).toThrow('version-unsupported')
  expect(() =>
    resourcePackageArtifactCodecs.decode('{"scene":"resource-package","version":1,"artifacts":[]}'),
  ).toThrow('version-unsupported')
  expect(() => intentApplyArtifactCodecs.decode(resourcePackageArtifactCodecs.encode([]))).toThrow(
    'envelope-invalid',
  )
  expect(() =>
    reencodeBundleApplyReceipt('{"journalId":"j","applied":[{"opId":"a","operationId":"b"}]}'),
  ).toThrow('identity-conflict')
})

test('probes retain F contributions, validate envelopes and identify exact corrupt journal ids', async () => {
  const all = collectReadOnlyProbes([
    { owner: 'intent', probes: intentProbes },
    { owner: 'resource-catalog', probes: resourceProbes },
  ])
  expect(all.map((probe) => probe.id)).toContain('resource-catalog:agent-reference-order')
  expect(all.map((probe) => probe.id)).toContain('resource-catalog:workflow-index-parity')
  for (const [probes, valid] of [
    [intentProbes, intentApplyArtifactCodecs.encode([])],
    [resourceProbes, resourcePackageArtifactCodecs.encode([])],
  ] as const) {
    const probe = probes.find((entry) => entry.id.endsWith(':apply-artifact-envelopes'))!
    const result = await probe.run({
      provider: 'sqlite',
      query: async () => [
        { id: 'valid', state: 'failed', prepared_artifacts_json: valid, receipt_json: null },
        { id: 'corrupt', state: 'failed', prepared_artifacts_json: '[]', receipt_json: null },
      ],
    })
    expect(result).toMatchObject({ passed: false, detail: { rows: 2, failures: ['corrupt'] } })
  }
})

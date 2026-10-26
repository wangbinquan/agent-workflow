// RFC-395 P-1: run the old provenance repair once; settled rows and missing skills stay admissible.
import { expect, test } from 'bun:test'
import {
  decideFusionProvenance,
  conversion as fusion,
} from '@/modules/knowledge-evolution/infrastructure/migration/fusionProvenanceRule'
import { conversion as memory } from '@/modules/memory/infrastructure/migration/legacyBootMemoryRule'
import {
  encodeFusionSkillToken,
  QUARANTINED_FUSION_SKILL_ID as sentinel,
} from '@/modules/knowledge-evolution/infrastructure/fusionRepositorySupport'
import {
  bootUpgradeEffectsFromRecords,
  fusionProvenanceFacts,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { memoryIds } from '@/platform/persistence/migration/conversion/generic/references'
import { buildLookups } from '@/platform/persistence/migration/conversion/lookups'
import { createStagingStore } from '@/platform/persistence/migration/conversion/staging'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { overrideSourceValues } from './helpers/rfc395V2/sourceOverride'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const token = encodeFusionSkillToken({ skillId: 'skill', contentVersion: 2, metaRevision: 0 })
const row = {
  id: 'fusion',
  precondition_token: token,
  base_skill_version: 2,
  applied_skill_version: null,
  status: 'running',
  skill_id: 'legacy-name',
}
test.each([
  [token, [], 'token'],
  [token, [{ skillId: 'skill', version: 3 }], 'token-and-ledger'],
  ['bad', [{ skillId: 'skill', version: 3 }], 'ledger'],
  [null, [{ skillId: 'skill', version: 3 }], 'ledger'],
] as const)('token and sole-ledger resolution: %s', (value, ledger, proof) => {
  expect(decideFusionProvenance({ ...row, precondition_token: value }, ledger)).toMatchObject({
    skillId: 'skill',
    proof,
    reason: null,
    wouldPreviouslyQuarantine: false,
    wouldPreviouslyTerminalize: false,
  })
})
test('known conflicts and absent provenance reproduce quarantine and terminalization', () => {
  const sole = [{ skillId: 'skill', version: 3 }]
  for (const candidate of [
    decideFusionProvenance(row, [...sole, ...sole]),
    decideFusionProvenance(row, [{ skillId: 'other', version: 3 }]),
    decideFusionProvenance({ ...row, applied_skill_version: 4 }, sole),
    decideFusionProvenance({ ...row, base_skill_version: 1 }, sole),
    decideFusionProvenance({ ...row, precondition_token: null }, []),
    decideFusionProvenance(
      {
        ...row,
        precondition_token: encodeFusionSkillToken({
          skillId: sentinel,
          contentVersion: 2,
          metaRevision: 0,
        }),
      },
      sole,
    ),
  ])
    expect(candidate).toMatchObject({
      skillId: sentinel,
      reason: null,
      wouldPreviouslyQuarantine: true,
      wouldPreviouslyTerminalize: true,
    })
  expect(decideFusionProvenance({ ...row, skill_id: sentinel }, [])).toMatchObject({
    skillId: sentinel,
    wouldPreviouslyQuarantine: false,
    wouldPreviouslyTerminalize: false,
  })
  expect(
    decideFusionProvenance({ ...row, precondition_token: null, status: 'rejected' }, []),
  ).toMatchObject({
    skillId: sentinel,
    wouldPreviouslyQuarantine: true,
    wouldPreviouslyTerminalize: false,
  })
})

describeV2Providers('RFC-395 fusion and exact fused-memory provenance', (h) => {
  test('converts settled, deleted-skill, terminal-unproven and sentinel-token rows without extra identity proof', async () => {
    await h.install()
    await h.write('skills', [frozenValues('skills', { id: 'skill', name: 'skill' })])
    const cases = [
      {
        id: 'proven',
        skill_id: 'old',
        status: 'running',
        precondition_token: token,
        applied_skill_version: null,
      },
      {
        id: 'settled',
        skill_id: sentinel,
        status: 'failed',
        precondition_token: null,
        applied_skill_version: null,
      },
      {
        id: 'deleted-rejected',
        skill_id: 'gone',
        status: 'rejected',
        precondition_token: encodeFusionSkillToken({
          skillId: 'gone',
          contentVersion: 2,
          metaRevision: 0,
        }),
        applied_skill_version: null,
      },
      {
        id: 'deleted-applied',
        skill_id: 'gone',
        status: 'done',
        precondition_token: encodeFusionSkillToken({
          skillId: 'gone',
          contentVersion: 2,
          metaRevision: 0,
        }),
        applied_skill_version: 3,
      },
      {
        id: 'terminal-unproven',
        skill_id: 'old',
        status: 'rejected',
        precondition_token: null,
        applied_skill_version: null,
      },
      {
        id: 'running-unproven',
        skill_id: 'old',
        status: 'running',
        precondition_token: null,
        applied_skill_version: null,
      },
      {
        id: 'sentinel-token',
        skill_id: 'old',
        status: 'awaiting_approval',
        precondition_token: encodeFusionSkillToken({
          skillId: sentinel,
          contentVersion: 2,
          metaRevision: 0,
        }),
        applied_skill_version: null,
      },
    ]
    await h.write(
      'fusions',
      cases.map((entry) =>
        frozenValues('fusions', { ...row, ...entry, decided_at: null, error: null }),
      ),
    )
    await h.write('skill_versions', [
      frozenValues('skill_versions', {
        id: 'v3',
        skill_id: 'skill',
        version_index: 3,
        fusion_id: 'proven',
        source: 'fusion',
      }),
    ])
    await h.write('memories', [
      ...cases.map((entry) =>
        frozenValues('memories', {
          id: entry.id,
          status: 'fused',
          fused_into_skill: 'legacy-skill',
          fused_fusion_id: entry.id,
          fused_into_skill_id: entry.skill_id,
          fused_into_skill_version: 3,
          supersedes_id: null,
          superseded_by_id: null,
        }),
      ),
      frozenValues('memories', {
        id: 'wrong-version',
        status: 'fused',
        fused_into_skill: 'legacy-skill',
        fused_fusion_id: 'proven',
        fused_into_skill_id: 'old',
        fused_into_skill_version: 4,
      }),
      frozenValues('memories', {
        id: 'plain',
        status: 'approved',
        fused_into_skill_id: null,
        supersedes_id: null,
        superseded_by_id: null,
      }),
    ])
    const source = overrideSourceValues(await h.sourceHarness.source(), 'memories', (row) =>
      row.id === 'plain' ? { ...row, supersedes_id: 'missing-memory' } : row,
    )
    const input = await h.input(
      [fusion, memory, { rules: [], validators: [], lookups: [memoryIds] }],
      { source },
    )
    try {
      const sink = new V2MemorySink(),
        summary = await runConversion(input, sink)
      expect(summary.blocks).toEqual([])
      const effects = bootUpgradeEffectsFromRecords(summary.records)
      for (const original of cases) {
        const next = sink.rows('fusions').find((entry) => entry.id === original.id)!
        const expectedSkill =
          original.id === 'proven'
            ? 'skill'
            : original.id === 'deleted-rejected'
              ? 'gone'
              : sentinel
        const terminalize = ['running-unproven', 'sentinel-token'].includes(original.id)
        expect(next).toMatchObject({
          skill_id: expectedSkill,
          status: terminalize ? 'failed' : original.status,
          decided_at: terminalize ? input.planTime : null,
          error: terminalize
            ? 'fusion provenance could not be proven during upgrade; re-initiate the fusion'
            : null,
        })
        expect(sink.rows('memories').find((entry) => entry.id === original.id)).toMatchObject({
          fused_into_skill_id: original.id === 'proven' ? 'skill' : sentinel,
        })
        const effect = effects.find(
          (entry) =>
            entry.sourceTable === 'fusions' && (entry.before as { id: string }).id === original.id,
        )!
        expect(effect.disposition).toBe(
          ['settled', 'deleted-rejected'].includes(original.id) ? 'copied' : 'transformed',
        )
        expect(effect.after).toMatchObject({
          wouldPreviouslyTerminalize: terminalize,
          wouldPreviouslyQuarantine: expectedSkill === sentinel && original.skill_id !== sentinel,
        })
      }
      expect(
        sink.rows('memories').find((entry) => entry.id === 'wrong-version')!.fused_into_skill_id,
      ).toBe(sentinel)
      expect(sink.rows('memories').find((entry) => entry.id === 'plain')).toMatchObject({
        status: 'approved',
        fused_into_skill_id: null,
        supersedes_id: null,
      })
      expect(
        [...sink.units.values()]
          .flatMap((unit) => unit.dispositions)
          .some((entry) => entry.decision?.code === 'v2-memory-supersession-detached'),
      ).toBe(true)
      const sourceRows = (await input.source.readChunk('fusions', null, 100)).decodedRows
      expect(sourceRows.find((entry) => entry.id === 'running-unproven')).toMatchObject({
        status: 'running',
        skill_id: 'old',
        decided_at: null,
      })
    } finally {
      await input.source.close()
    }
  }, 180_000)
})

test('an undecodable algorithm input blocks with unknown quarantine and terminalize flags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boot-fusion-codec-')),
    staged = createStagingStore(root)
  try {
    const key = [canonicalValue('fusion')]
    staged.put({
      table: 'fusions',
      phase: 'current',
      key,
      encodedKey: encodeMigrationKey('fusions', key),
      values: row,
      canonical: { key, values: Object.values(row).map(canonicalValue) },
      codecFailure: { columns: ['base_skill_version'], message: 'unreadable integer' },
    })
    const facts = await buildLookups(fusion.lookups, staged)
    expect(facts(fusionProvenanceFacts).require('fusion')).toMatchObject({
      skillId: null,
      reason: 'v2-boot-fusion-source-unproven',
      wouldPreviouslyQuarantine: null,
      wouldPreviouslyTerminalize: null,
    })
  } finally {
    staged.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// RFC-626 design §3.4 row 7. Locks the two rules that must change together: when the ledger
// versions a fusion rests on cannot be read (v2-boot-fusion-source-unproven), the automatic
// upgrade keeps the fusion against the quarantine marker — failed when it was unfinished, as the
// old boot left such a fusion — and keeps the memory fused into it pointing at the same marker
// (v2-boot-fused-memory-unproven), each with a recorded decision. The fact carries no verdict of
// its own in this state, so whether the fusion fails is decided again from its status. With
// operator resolution both rows still block.
import { describe, expect, test } from 'bun:test'
import {
  decideFusionProvenance,
  fusionProvenanceLookup,
  fusionProvenanceRule,
  fusionWouldTerminalize,
  FUSION_SOURCE_KEPT_QUARANTINED,
} from '@/modules/knowledge-evolution/infrastructure/migration/fusionProvenanceRule'
import { QUARANTINED_FUSION_SKILL_ID } from '@/modules/knowledge-evolution/infrastructure/fusionRepositorySupport'
import {
  legacyBootMemoryRule,
  FUSED_MEMORY_KEPT_QUARANTINED,
} from '@/modules/memory/infrastructure/migration/legacyBootMemoryRule'
import { memoryIds } from '@/platform/persistence/migration/conversion/generic/references'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { runRuleUnit, sourceRow } from './helpers/rfc626CatalogRuleUnit'

const UNFINISHED = ['running', 'awaiting_approval', 'applying'] as const
const FINISHED = ['done', 'rejected', 'canceled', 'failed'] as const

function fusion(id: string, status: string): SourceRow {
  return sourceRow(
    'fusions',
    frozenValues('fusions', {
      id,
      skill_id: 'skill-x',
      skill_name: 'x',
      base_skill_version: 1,
      precondition_token: null,
      applied_skill_version: null,
      status,
      decided_at: null,
      error: null,
    }),
  )
}
/** A ledger version of the fusion that the frozen codec could not decode. */
function undecodableLedger(fusionId: string): SourceRow {
  return sourceRow(
    'skill_versions',
    frozenValues('skill_versions', {
      id: `ledger-${fusionId}`,
      skill_id: 'skill-x',
      version_index: 2,
      source: 'fusion',
      fusion_id: fusionId,
    }),
    ['id'],
    { codecFailure: { message: 'fixture: summary is not text', columns: ['summary'] } },
  )
}
const statuses = [...UNFINISHED, ...FINISHED]
const fusions = statuses.map((status) => fusion(`fusion-${status}`, status))
const ledgers = statuses.map((status) => undecodableLedger(`fusion-${status}`))
const memory = sourceRow(
  'memories',
  frozenValues('memories', {
    id: 'memory-1',
    status: 'fused',
    fused_fusion_id: 'fusion-running',
    fused_into_skill: 'x',
    fused_into_skill_id: 'skill-x',
    fused_into_skill_version: 2,
    supersedes_id: null,
    superseded_by_id: null,
  }),
)
const rows = [...fusions, ...ledgers, memory]

async function convertFusions(resolution?: 'automatic') {
  return runRuleUnit({
    rule: fusionProvenanceRule,
    lookups: [fusionProvenanceLookup],
    rows,
    ...(resolution ? { resolution } : {}),
  })
}
async function convertMemories(resolution?: 'automatic') {
  return runRuleUnit({
    rule: legacyBootMemoryRule,
    lookups: [fusionProvenanceLookup, memoryIds],
    rows,
    ...(resolution ? { resolution } : {}),
  })
}

describe('RFC-626 3.4 row 7: fusions and fused memories whose ledger cannot be read', () => {
  test('automatic: every fusion points at the quarantine marker; only unfinished ones fail', async () => {
    const result = await convertFusions('automatic')
    expect(result.output.blocks).toEqual([])
    const converted = result.rows('fusions')
    expect(converted).toHaveLength(statuses.length)
    for (const status of statuses) {
      const row = converted.find((entry) => entry.id === `fusion-${status}`)!
      expect(row.skill_id).toBe(QUARANTINED_FUSION_SKILL_ID)
      if ((UNFINISHED as readonly string[]).includes(status))
        expect(row).toMatchObject({
          status: 'failed',
          decided_at: 123,
          error: 'fusion provenance could not be proven during upgrade; re-initiate the fusion',
        })
      else expect(row).toMatchObject({ status, decided_at: null, error: null })
    }
    const decisions = result.decisions(FUSION_SOURCE_KEPT_QUARANTINED)
    expect(decisions).toHaveLength(statuses.length)
    for (const status of statuses)
      expect(decisions).toContainEqual(
        expect.objectContaining({
          automatic: 'kept',
          sourceTable: 'fusions',
          cause: 'v2-boot-fusion-source-unproven',
          fusionId: `fusion-${status}`,
          skillId: 'skill-x',
          status,
          terminalized: (UNFINISHED as readonly string[]).includes(status),
        }),
      )
    expect(
      result.output.dispositions.filter(
        (row) => row.decision?.code === 'v2-boot-fusion-quarantined',
      ),
    ).toHaveLength(statuses.length)
  })

  test('automatic: the fused memory points at the quarantine marker with its decision', async () => {
    const result = await convertMemories('automatic')
    expect(result.output.blocks).toEqual([])
    expect(result.rows('memories')).toEqual([
      expect.objectContaining({
        id: 'memory-1',
        status: 'fused',
        fused_into_skill_id: QUARANTINED_FUSION_SKILL_ID,
      }),
    ])
    expect(result.decisions(FUSED_MEMORY_KEPT_QUARANTINED)).toEqual([
      expect.objectContaining({
        automatic: 'kept',
        sourceTable: 'memories',
        cause: 'v2-boot-fusion-source-unproven',
        memoryId: 'memory-1',
        fusionId: 'fusion-running',
        skillId: 'skill-x',
        version: 2,
      }),
    ])
  })

  test('operator: both rules still block every such row', async () => {
    const fusionResult = await convertFusions()
    expect(fusionResult.rows('fusions')).toEqual([])
    expect(fusionResult.output.blocks.map((block) => block.code)).toEqual(
      statuses.map(() => 'v2-boot-fusion-source-unproven'),
    )
    expect(fusionResult.decisions(FUSION_SOURCE_KEPT_QUARANTINED)).toEqual([])
    const memoryResult = await convertMemories()
    expect(memoryResult.rows('memories')).toEqual([])
    expect(memoryResult.output.blocks.map((block) => block.code)).toEqual([
      'v2-boot-fused-memory-unproven',
    ])
    expect(memoryResult.decisions(FUSED_MEMORY_KEPT_QUARANTINED)).toEqual([])
  })

  test('the re-taken decision is the one the proven path takes for the same row', () => {
    for (const status of statuses)
      for (const skillId of ['skill-x', QUARANTINED_FUSION_SKILL_ID]) {
        const row = { ...fusion('fusion', status).values, skill_id: skillId }
        expect<boolean | null>(fusionWouldTerminalize(row, QUARANTINED_FUSION_SKILL_ID)).toBe(
          decideFusionProvenance(row, []).wouldPreviouslyTerminalize,
        )
      }
  })
})

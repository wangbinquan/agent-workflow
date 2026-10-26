// RFC-395 U-4: the former boot repair is now a frozen conversion. Unproved
// token/ledger and exact-memory evidence reproduces quarantine; source rows never change.
import { expect, test } from 'bun:test'
import { conversion as fusion } from '@/modules/knowledge-evolution/infrastructure/migration/fusionProvenanceRule'
import { conversion as memory } from '@/modules/memory/infrastructure/migration/legacyBootMemoryRule'
import { encodeSkillToken } from '@/modules/resource-catalog/application/skills/skillToken'
import { skillBootIdentityFacts } from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { memoryIds } from '@/platform/persistence/migration/conversion/generic/references'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { describeV2Providers, fixtureLookup } from './helpers/rfc395V2Harness'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { QUARANTINED_FUSION_SKILL_ID } from '@/services/systemResources'

describeV2Providers('fusion provenance converter preserves the old proof matrix', (h) => {
  test('token/ledger oracles, exact fused versions, terminal status and idempotent retry', async () => {
    await h.install()
    const token = (skillId: string, contentVersion = 1) =>
      encodeSkillToken({ skillId, contentVersion, metaRevision: 0 })
    const cases = [
      {
        id: 'token-only',
        token: token('deleted-skill-id'),
        ledger: [],
        applied: null,
        expected: 'deleted-skill-id',
      },
      {
        id: 'malformed-ledger',
        token: 'not-a-token',
        ledger: ['skill-ledger'],
        applied: 2,
        expected: 'skill-ledger',
      },
      {
        id: 'token-ledger-agree',
        token: token('skill-agree'),
        ledger: ['skill-agree'],
        applied: 2,
        expected: 'skill-agree',
      },
      {
        id: 'token-ledger-disagree',
        token: token('deleted-skill-id'),
        ledger: ['skill-other'],
        applied: null,
        expected: null,
      },
      {
        id: 'duplicate-ledger',
        token: null,
        ledger: ['skill-duplicate', 'skill-duplicate'],
        applied: null,
        expected: null,
      },
      {
        id: 'token-base-mismatch',
        token: token('deleted-skill-id', 2),
        ledger: [],
        applied: null,
        expected: null,
      },
      {
        id: 'applied-version-mismatch',
        token: null,
        ledger: ['skill-applied'],
        applied: 3,
        expected: null,
      },
      {
        id: 'sentinel-token',
        token: token(QUARANTINED_FUSION_SKILL_ID),
        ledger: [],
        applied: null,
        expected: null,
      },
      {
        id: 'terminal-conflict',
        token: token('deleted-skill-id', 9),
        ledger: [],
        applied: null,
        expected: null,
      },
    ]
    // The released schema enforces skill-version parent identity. Historical
    // evidence can disagree, but the source rows must still be constructible.
    await h.write(
      'skills',
      [...new Set(cases.flatMap((item) => item.ledger))].map((id) =>
        frozenValues('skills', { id, name: id }),
      ),
    )
    for (const item of cases) {
      await h.write('fusions', [
        frozenValues('fusions', {
          id: item.id,
          skill_id: 'legacy-name',
          skill_name: `historical-${item.id}`,
          base_skill_version: 1,
          precondition_token: item.token,
          applied_skill_version: item.applied,
          status:
            item.id === 'duplicate-ledger'
              ? 'applying'
              : item.id === 'terminal-conflict'
                ? 'done'
                : 'failed',
        }),
      ])
      for (const [index, id] of item.ledger.entries())
        await h.write('skill_versions', [
          frozenValues('skill_versions', {
            id: `${item.id}-${index}`,
            skill_id: id,
            version_index: 2 + index,
            fusion_id: item.id,
            source: 'fusion',
          }),
        ])
    }
    for (const [id, version, parent] of [
      ['memory-exact', 2, 'malformed-ledger'],
      ['memory-wrong-version', 3, 'malformed-ledger'],
      ['memory-quarantined-parent', 2, 'token-ledger-disagree'],
    ] as const)
      await h.write('memories', [
        frozenValues('memories', {
          id,
          title: id,
          body_md: 'body',
          status: 'fused',
          fused_into_skill: 'legacy-name',
          fused_into_skill_id: 'legacy-name',
          fused_into_skill_version: version,
          fused_fusion_id: parent,
          supersedes_id: null,
          superseded_by_id: null,
        }),
      ])
    await h.write('memories', [
      frozenValues('memories', {
        id: 'memory-approved',
        status: 'approved',
        fused_into_skill_id: null,
        supersedes_id: null,
        superseded_by_id: null,
      }),
    ])
    const identities = [
      'deleted-skill-id',
      'skill-ledger',
      'skill-other',
      'skill-agree',
      'skill-duplicate',
      'skill-applied',
    ]
    const input = await h.input([
      fusion,
      memory,
      {
        rules: [],
        validators: [],
        lookups: [
          memoryIds,
          fixtureLookup(
            skillBootIdentityFacts,
            identities.map((skillId) => [
              skillId,
              { skillId, state: 'proven' as const, reason: null, factIds: [] },
            ]),
          ),
        ],
      },
    ])
    try {
      const original = (await input.source.readChunk('fusions', null, 100)).decodedRows
      const sink = new V2MemorySink()
      const result = await runConversion(input, sink)
      expect(result.status).toBe('converted')
      for (const item of cases) {
        const actual = sink.rows('fusions').find((row) => row.id === item.id)
        if (item.expected) expect(actual?.skill_id).toBe(item.expected)
        else expect(actual?.skill_id).toBe(QUARANTINED_FUSION_SKILL_ID)
      }
      expect(
        sink.rows('memories').find((row) => row.id === 'memory-exact')?.fused_into_skill_id,
      ).toBe('skill-ledger')
      expect(
        sink.rows('memories').find((row) => row.id === 'memory-wrong-version')?.fused_into_skill_id,
      ).toBe(QUARANTINED_FUSION_SKILL_ID)
      expect(
        sink.rows('memories').find((row) => row.id === 'memory-quarantined-parent')
          ?.fused_into_skill_id,
      ).toBe(QUARANTINED_FUSION_SKILL_ID)
      expect(sink.rows('memories').find((row) => row.id === 'memory-approved')).toMatchObject({
        status: 'approved',
        fused_into_skill_id: null,
      })
      expect(result.blocks).toEqual([])
      expect(sink.rows('fusions').find((row) => row.id === 'duplicate-ledger')).toMatchObject({
        status: 'failed',
        skill_id: QUARANTINED_FUSION_SKILL_ID,
        decided_at: input.planTime,
      })
      expect(sink.rows('fusions').find((row) => row.id === 'terminal-conflict')?.status).toBe(
        'done',
      )
      expect((await input.source.readChunk('fusions', null, 100)).decodedRows).toEqual(original)
      expect(original.find((row) => row.id === 'duplicate-ledger')?.status).toBe('applying')
      const rows = structuredClone(sink.rows('fusions'))
      await runConversion(input, sink)
      expect(sink.rows('fusions')).toEqual(rows)
    } finally {
      await input.source.close()
    }
  }, 180_000)
})

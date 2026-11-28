// RFC-626 implementation gate G2-1 (design §3.4 row 3c, §9.9 `preservedClaims`): since
// skill_operations and skill_operation_locks became members of the skill rule's groups, one
// operation row the engine stopped before the rule ran (here: a row the frozen codec cannot
// decode) took the whole group along — with automatic resolution the skill and all of its
// versions were set aside, with operator resolution they gained v2-group-member-blocked. The
// operation records are attached to their group: such a row now takes only itself out, as it did
// while the generic copy carried it. This goes through the real engine and the real skill rule.
import { describe, expect, test } from 'bun:test'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { createSkillBootConversion } from '@/modules/resource-catalog/infrastructure/migration/skillBootRules'
import { convertFrozenSkillContent } from '@/platform/content/migration/skillContent'
import { createBootUpgradeFacts } from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { readSourceTable } from '@/platform/persistence/migration/conversion/readSource'
import type { ConversionResolution } from '@/platform/persistence/migration/conversion/types'
import {
  RecordingSink,
  engineInput,
  memorySource,
  scratchRoots,
  sourceKey,
} from './rfc626-engine-fixtures.test'
import {
  HOME,
  SKILL,
  frozenTree,
  operationSource,
  skillFact,
  skillSource,
  versionSource,
} from './helpers/rfc626SkillFixtures'

const scratch = scratchRoots()

/** A proven skill with one version, an old operation of its history and an undecodable one. */
async function convert(resolution?: ConversionResolution) {
  const live = frozenTree(`${HOME}/skills/${SKILL}/files`)
  const snapshot = frozenTree(`${HOME}/skills/${SKILL}/versions/v1/files`)
  const memory = memorySource({
    skills: [skillSource().values],
    skill_versions: [versionSource({ content_hash: snapshot.contentHash }).values],
    skill_operations: [
      operationSource({ op_id: 'op-old', kind: 'version-write', phase: 'done', active: 0 }).values,
      // `precondition_json` is JSON text in the frozen contract.
      operationSource({
        op_id: 'op-bad',
        kind: 'delete',
        phase: 'done',
        active: 0,
        precondition_json: '{ not json',
      }).values,
    ],
    skill_operation_locks: [],
  })
  // The facts the capture records, from the rows as the conversion reads them.
  const read = async (table: string) =>
    readSourceTable({ source: memory.source, preflight: memory.preflight, table })
  const [skill] = await read('skills')
  const [version] = await read('skill_versions')
  const fact = skillFact(skill!, {
    state: 'proven',
    live,
    versions: [
      {
        id: String(version!.values.id),
        version: 1,
        sourceDigest: valueDigest(version!.values),
        tree: snapshot,
      },
    ],
  })
  const contribution = createSkillBootConversion(convertFrozenSkillContent).withBootUpgrade!(
    createBootUpgradeFacts([fact]),
  )
  const sink = new RecordingSink()
  const summary = await runConversion(
    engineInput(memory, [contribution], {
      scratchRoot: scratch(),
      target: persistenceSchema,
      ...(resolution ? { resolution } : {}),
    }),
    sink,
  )
  return { sink, summary }
}
const badKey = sourceKey('skill_operations', 'op-bad')

describe('RFC-626 an operation row of a skill stopped on its own', () => {
  test('automatic: only that row is set aside; the skill, its version and its other operation convert', async () => {
    const { sink, summary } = await convert('automatic')
    expect(summary.blocks).toEqual([])
    expect(summary.status).toBe('converted')
    expect(sink.rows('skills')).toEqual([
      expect.objectContaining({ id: SKILL, version_state: 'snapshot-authoritative' }),
    ])
    expect(sink.rows('skill_versions')).toHaveLength(1)
    expect(sink.rows('skill_operations').map((row) => row.op_id)).toEqual(['op-old'])
    // The skill and its version keep their own (converted) dispositions; nothing else is archived.
    expect(
      sink
        .dispositions()
        .filter((entry) => entry.class !== 'converted')
        .map((entry) => [entry.sourceKey, entry.class, entry.decision?.code]),
    ).toEqual([[badKey, 'archived', 'v2-source-codec']])
    expect(
      sink.dispositions().filter((entry) => entry.decision?.code === 'v2-group-member-blocked'),
    ).toEqual([])
    expect(summary.resolutions!.setAside).toEqual({
      total: 1,
      rows: [
        {
          sourcePhase: 'current',
          sourceTable: 'skill_operations',
          sourceKey: badKey,
          code: 'v2-source-codec',
        },
      ],
    })
  })

  test('operator: that row is the only block, without v2-group-member-blocked', async () => {
    const { sink, summary } = await convert()
    expect(summary.status).toBe('blocked')
    expect(summary.blocks.map((block) => [block.code, block.sourceTable, block.sourceKey])).toEqual(
      [['v2-source-codec', 'skill_operations', badKey]],
    )
    expect(sink.rows('skills')).toEqual([
      expect.objectContaining({ id: SKILL, version_state: 'snapshot-authoritative' }),
    ])
    expect(sink.rows('skill_versions')).toHaveLength(1)
    expect(sink.rows('skill_operations').map((row) => row.op_id)).toEqual(['op-old'])
  })
})

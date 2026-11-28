// RFC-626 design §3.4 rows 3a, 3b and 3d, §3.3 "validation must pass after automatic
// dispositions", §3.6. Locks what the skill rule does with a skill the boot facts could not prove:
// with automatic resolution a skill whose directory or snapshot is missing, changed or
// inconsistent is kept quarantined (as v0.19.2's boot did) with references every reader accepts
// and no content object; a never-published skill is set aside; a contradiction of the captured
// facts ends the upgrade with an error. With operator resolution every block stays as it was.
import { describe, expect, test } from 'bun:test'
import {
  automaticSkillDisposition,
  SKILL_KEPT_UNAVAILABLE,
  type SkillBootContentConverter,
} from '@/modules/resource-catalog/infrastructure/migration/skillBootRules'
import { ConversionContractError } from '@/platform/persistence/migration/conversion/blockCodes'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { RESOLUTION_CODES, type SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { BootUpgradeFact } from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { DATABASE_SKILL_ROOT } from '@/platform/content/locations/skill'
import { contentRefColumns } from '@/platform/content/contentStore'
import {
  canonicalSkillTreePath,
  convertFrozenSkillContent,
  unavailableSkillTreeColumns,
} from '@/platform/content/migration/skillContent'
import { readOnlyProbes as contentProbes } from '@/platform/content/migration/probes'
import { skillReferencePath } from '@/modules/resource-catalog/infrastructure/databaseSkillTrees'
import { probeConnection } from './helpers/rfc626CatalogRuleUnit'
import {
  HOME,
  SKILL,
  convertSkills,
  frozenTree,
  recordingConverter,
  skillFact,
  skillSource,
  treePath,
  versionSource,
} from './helpers/rfc626SkillFixtures'
import type { RuleUnitResult } from './helpers/rfc626CatalogRuleUnit'

const referenceProbe = contentProbes.find(
  (probe) => probe.id === 'platform/content:skill-reference-columns',
)!

async function expectReferencesValid(result: RuleUnitResult): Promise<void> {
  const report = await referenceProbe.run(
    probeConnection({
      skills: result.rows('skills'),
      skill_versions: result.rows('skill_versions'),
      skill_content_entries: result.rows('skill_content_entries'),
    }),
  )
  expect(report).toMatchObject({ passed: true, detail: { issues: [] } })
}

function expectNoContent(result: RuleUnitResult): void {
  for (const table of ['content_objects', 'content_bytes', 'skill_content_entries'])
    expect(result.rows(table)).toEqual([])
  expect(result.output.artifacts).toEqual([])
}

describe('RFC-626 3a: a skill the boot facts could not prove is kept quarantined', () => {
  const liveFound = `${HOME}/skills/alpha/files`
  const versionFound = `${HOME}/skills/alpha/versions/v1/files`
  const cases = [
    { code: 'v2-boot-skill-main-missing', found: 'none' },
    { code: 'v2-boot-skill-snapshot-missing', found: 'live' },
    { code: 'v2-boot-skill-snapshot-hash-conflict', found: 'live' },
    { code: 'v2-boot-skill-authority-conflict', found: 'both' },
    { code: 'v2-boot-skill-path-identity', found: 'none' },
    { code: 'v2-boot-skill-root-conflict', found: 'none' },
    { code: 'v2-boot-skill-ownership-conflict', found: 'both' },
    { code: 'v2-boot-skill-tree-invalid', found: 'none' },
    { code: 'v2-boot-skill-file-path-invalid', found: 'both' },
    { code: 'v2-boot-skill-content-unavailable', found: 'none' },
    { code: 'v2-boot-skill-live-reference-missing', found: 'none' },
    { code: 'v2-boot-skill-snapshot-reference-missing', found: 'live' },
    { code: 'v2-skill-text-not-lossless', found: 'database' },
    { code: 'v2-skill-base64-invalid', found: 'database' },
    { code: 'v2-skill-encoding-unknown', found: 'database' },
  ] as const
  function fixture(code: string, found: (typeof cases)[number]['found']) {
    const database = found === 'database'
    const skill = skillSource({
      managed_path: database
        ? DATABASE_SKILL_ROOT
        : code === 'v2-boot-skill-live-reference-missing'
          ? null
          : `skills/${SKILL}/files`,
    })
    const version = versionSource({
      files_path: database ? DATABASE_SKILL_ROOT : `skills/${SKILL}/versions/v1/files`,
    })
    const fact = skillFact(skill, {
      reason: code,
      live: found === 'live' || found === 'both' ? frozenTree(liveFound) : null,
      versions:
        found === 'both'
          ? [
              {
                id: String(version.values.id),
                version: 1,
                sourceDigest: valueDigest(version.values),
                tree: frozenTree(versionFound),
              },
            ]
          : [],
      roots: found === 'none' || database ? [] : [`${HOME}/skills/alpha`],
    })
    const expected = {
      live: found === 'live' || found === 'both' ? liveFound : `skills/${SKILL}/files`,
      version: found === 'both' ? versionFound : `skills/${SKILL}/versions/v1/files`,
    }
    return { skill, version, fact, expected }
  }

  for (const item of cases)
    test(`${item.code}: rows kept quarantined, references valid, no content`, async () => {
      const { skill, version, fact, expected } = fixture(item.code, item.found)
      const converter = recordingConverter()
      const result = await convertSkills({
        rows: [skill, version],
        facts: [fact],
        resolution: 'automatic',
        convert: converter.convert,
      })
      expect(result.output.blocks).toEqual([])
      expect(converter.calls).toEqual([])
      const skills = result.rows('skills')
      const versions = result.rows('skill_versions')
      expect(skills).toHaveLength(1)
      expect(versions).toHaveLength(1)
      expect(skills[0]).toMatchObject({ id: SKILL, version_state: 'quarantined' })
      expect(Object.hasOwn(skills[0]!, 'managed_path')).toBe(false)
      expect(Object.hasOwn(versions[0]!, 'files_path')).toBe(false)
      // Every other column of both rows is carried over unchanged.
      expect(skills[0]!.reservation_state).toBe(skill.values.reservation_state!)
      expect(skills[0]!.content_version).toBe(skill.values.content_version!)
      expect(versions[0]).toMatchObject({
        id: version.values.id,
        skill_id: SKILL,
        version_index: 1,
      })
      // Agent saves resolve every skill row's live path; a reference they cannot read fails them all.
      expect(treePath(skills[0]!, SKILL, 'live')).toBe(expected.live)
      expect(treePath(versions[0]!, SKILL, 'version:1')).toBe(expected.version)
      await expectReferencesValid(result)
      expectNoContent(result)
      const decisions = result.decisions(SKILL_KEPT_UNAVAILABLE)
      expect(decisions.map((decision) => String(decision.sourceTable)).sort()).toEqual([
        'skill_versions',
        'skills',
      ])
      for (const decision of decisions)
        expect(decision).toMatchObject({ automatic: 'kept', skillId: SKILL, cause: item.code })
      expect(result.output.dispositions.some((row) => row.class === 'archived')).toBe(false)
      expect(
        result.output.dispositions.filter((row) => row.decision?.code === SKILL_KEPT_UNAVAILABLE),
      ).toHaveLength(2)
    })

  for (const item of cases)
    test(`${item.code}: operator resolution keeps both row blocks unchanged`, async () => {
      const { skill, version, fact } = fixture(item.code, item.found)
      const result = await convertSkills({ rows: [skill, version], facts: [fact] })
      expect(result.output.blocks.map((block) => [block.code, block.scope, block.detail])).toEqual([
        [item.code, 'row', { skillId: SKILL }],
        [item.code, 'row', { skillId: SKILL }],
      ])
      expect(result.rows('skills')).toEqual([])
      expect(result.rows('skill_versions')).toEqual([])
      expect(result.decisions(SKILL_KEPT_UNAVAILABLE)).toEqual([])
    })

  test('a tree that fails late keeps nothing of the attempt: no receipt, no content object', async () => {
    const live = frozenTree(`${HOME}/skills/${SKILL}/files`)
    const snapshot = frozenTree(`${HOME}/skills/${SKILL}/versions/v1/files`)
    const skill = skillSource()
    const version = versionSource({ content_hash: snapshot.contentHash })
    const fact = skillFact(skill, {
      state: 'proven',
      live,
      versions: [
        {
          id: String(version.values.id),
          version: 1,
          sourceDigest: valueDigest(version.values),
          tree: snapshot,
        },
      ],
    })
    // The live tree converts (and records a receipt); the snapshot then fails its path check.
    const lateFailure: SkillBootContentConverter = async (input, ctx) => {
      if (input.tree !== 'live') throw new Error('v2-boot-skill-file-path-invalid')
      return convertFrozenSkillContent(input, ctx)
    }
    const automatic = await convertSkills({
      rows: [skill, version],
      facts: [fact],
      resolution: 'automatic',
      convert: lateFailure,
    })
    expect(automatic.output.blocks).toEqual([])
    expectNoContent(automatic)
    expect(automatic.rows('skills')[0]).toMatchObject({ version_state: 'quarantined' })
    expect(treePath(automatic.rows('skills')[0]!, SKILL, 'live')).toBe(live.reference)
    expect(treePath(automatic.rows('skill_versions')[0]!, SKILL, 'version:1')).toBe(
      snapshot.reference,
    )
    expect(
      automatic.output.dispositions.some(
        (row) => row.decision?.code === 'v2-boot-skill-content-proven',
      ),
    ).toBe(false)
    expect(automatic.decisions(SKILL_KEPT_UNAVAILABLE).map((decision) => decision.cause)).toEqual([
      'v2-boot-skill-file-path-invalid',
      'v2-boot-skill-file-path-invalid',
    ])
    await expectReferencesValid(automatic)

    const operator = await convertSkills({
      rows: [skill, version],
      facts: [fact],
      convert: lateFailure,
    })
    expect(operator.output.blocks.map((block) => block.code)).toEqual([
      'v2-boot-skill-file-path-invalid',
      'v2-boot-skill-file-path-invalid',
    ])
    // Unchanged from before RFC-626: a blocked row keeps the receipt its conversion recorded.
    expect(operator.output.artifacts).toHaveLength(1)
  })

  test('an exception no code names keeps the skill quarantined with the exception text', async () => {
    const skill = skillSource()
    const version = versionSource()
    const fact = skillFact(skill, {
      state: 'proven',
      live: frozenTree(`${HOME}/skills/${SKILL}/files`),
      versions: [
        {
          id: String(version.values.id),
          version: 1,
          sourceDigest: valueDigest(version.values),
          tree: frozenTree(`${HOME}/skills/${SKILL}/versions/v1/files`),
        },
      ],
    })
    const result = await convertSkills({
      rows: [skill, version],
      facts: [fact],
      resolution: 'automatic',
      convert: async () => {
        throw new TypeError('EIO: read failed')
      },
    })
    expect(result.output.blocks).toEqual([])
    expect(result.rows('skills')[0]).toMatchObject({ version_state: 'quarantined' })
    for (const decision of result.decisions(SKILL_KEPT_UNAVAILABLE))
      expect(decision).toMatchObject({
        cause: 'v2-boot-skill-conversion-unproven',
        message: 'EIO: read failed',
      })
    expectNoContent(result)
  })

  test('an engine contract error inside the conversion is rethrown, never kept', async () => {
    const skill = skillSource()
    const fact = skillFact(skill, { state: 'proven', live: frozenTree(`${HOME}/live`) })
    const contract = new ConversionContractError('v2-undeclared-target', 'fixture')
    const error = await convertSkills({
      rows: [skill],
      facts: [fact],
      resolution: 'automatic',
      convert: async () => {
        throw contract
      },
    }).catch((caught: unknown) => caught)
    expect(error).toBe(contract)
  })
})

describe('RFC-626 3b: a skill that was never published is set aside', () => {
  const live = `${HOME}/skills/${SKILL}/files`
  const cases: readonly {
    readonly code: string
    readonly rows: () => SourceRow[]
    readonly fact: (rows: readonly SourceRow[]) => BootUpgradeFact | null
  }[] = [
    {
      code: 'v2-boot-skill-husk-references',
      rows: () => [skillSource({ version_state: 'legacy-unbackfilled', content_version: 0 })],
      fact: (rows) =>
        skillFact(rows[0]!, {
          reason: 'v2-boot-skill-husk-references',
          references: ['memories:sha256:fixture'],
        }),
    },
    {
      code: 'v2-boot-skill-reservation-unsettled',
      rows: () => [skillSource({ reservation_state: 'reserving', content_version: 0 })],
      fact: (rows) =>
        skillFact(rows[0]!, {
          reason: 'v2-boot-skill-reservation-unsettled',
          live: frozenTree(live),
          roots: [`${HOME}/skills/${SKILL}`],
        }),
    },
    {
      code: 'v2-boot-skill-orphan-version',
      rows: () => [versionSource()],
      fact: () => null,
    },
  ]

  for (const item of cases)
    test(`${item.code}: archived with its decision, nothing converted`, async () => {
      const rows = item.rows()
      const fact = item.fact(rows)
      const result = await convertSkills({
        rows,
        facts: fact ? [fact] : [],
        resolution: 'automatic',
      })
      expect(result.output.blocks).toEqual([])
      expect(result.rows('skills')).toEqual([])
      expect(result.rows('skill_versions')).toEqual([])
      const archived = result.output.dispositions.filter((row) => row.class === 'archived')
      expect(archived).toHaveLength(rows.length)
      for (const disposition of archived) {
        expect(disposition.kind).toBe('archived')
        expect(disposition.archive).not.toBeNull()
        expect(disposition.decision?.code).toBe(item.code)
      }
      expect(result.decisions(RESOLUTION_CODES.rowSetAside)).toHaveLength(rows.length)
      if (item.code === 'v2-boot-skill-reservation-unsettled')
        // The directory stays on disk without a skill row; the report names it.
        expect(archived[0]!.decision?.detail).toMatchObject({
          skillId: SKILL,
          liveDirectory: live,
          roots: [`${HOME}/skills/${SKILL}`],
        })
    })

  for (const item of cases)
    test(`${item.code}: operator resolution keeps the row blocks unchanged`, async () => {
      const rows = item.rows()
      const fact = item.fact(rows)
      const result = await convertSkills({ rows, facts: fact ? [fact] : [] })
      expect(result.output.blocks.map((block) => [block.code, block.detail])).toEqual(
        rows.map(() => [item.code, { skillId: SKILL }]),
      )
      expect(result.output.dispositions.some((row) => row.class === 'archived')).toBe(false)
    })
})

describe('RFC-626 3d: facts contradicting the frozen rows end the upgrade with an error', () => {
  const proven = (skill: ReturnType<typeof skillSource>) =>
    skillFact(skill, { state: 'proven', live: frozenTree(`${HOME}/skills/${SKILL}/files`) })
  const cases: readonly {
    readonly code: string
    readonly build: () => {
      rows: ReturnType<typeof skillSource>[]
      facts: ReturnType<typeof skillFact>[]
      convert?: SkillBootContentConverter
      groupKeys?: readonly string[]
    }
  }[] = [
    {
      code: 'v2-boot-skill-fact-missing',
      build: () => ({ rows: [skillSource()], facts: [] }),
    },
    {
      code: 'v2-boot-skill-source-changed',
      build: () => {
        const skill = skillSource()
        return { rows: [skill], facts: [skillFact(skill, { sourceDigest: 'sha256:changed' })] }
      },
    },
    {
      code: 'v2-boot-skill-duplicate-path',
      build: () => {
        const skill = skillSource()
        return {
          rows: [skill],
          facts: [skillFact(skill, { reason: 'v2-boot-skill-duplicate-path' })],
        }
      },
    },
    {
      code: 'v2-boot-skill-version-source-changed',
      build: () => {
        const skill = skillSource()
        return { rows: [skill, versionSource()], facts: [proven(skill)] }
      },
    },
    {
      code: 'v2-boot-skill-husk-unproven',
      build: () => {
        const skill = skillSource()
        return {
          rows: [skill],
          facts: [skillFact(skill, { state: 'husk', rootEmpty: false })],
        }
      },
    },
    {
      code: 'v2-boot-skill-live-unproven',
      build: () => {
        const skill = skillSource()
        return { rows: [skill], facts: [skillFact(skill, { state: 'proven', live: null })] }
      },
    },
    ...(
      [
        'v2-boot-skill-frozen-bytes-mismatch',
        'v2-boot-skill-frozen-hash-mismatch',
        'v2-boot-skill-tree-missing',
      ] as const
    ).map((code) => ({
      code,
      build: () => {
        const skill = skillSource()
        return {
          rows: [skill],
          facts: [proven(skill)],
          convert: async () => {
            throw new Error(code)
          },
        }
      },
    })),
    {
      code: 'v2-boot-skill-group-unproven',
      build: () => {
        const skill = skillSource()
        return { rows: [skill], facts: [proven(skill)], groupKeys: [] }
      },
    },
  ]

  for (const item of cases)
    test(`${item.code}: automatic resolution throws ConversionContractError`, async () => {
      const setup = item.build()
      const error = await convertSkills({ ...setup, resolution: 'automatic' }).catch(
        (caught: unknown) => caught,
      )
      expect(error).toBeInstanceOf(ConversionContractError)
      expect((error as ConversionContractError).code).toBe(item.code)
    })

  for (const item of cases)
    test(`${item.code}: operator resolution still blocks the rows`, async () => {
      const setup = item.build()
      const result = await convertSkills(setup)
      expect(result.output.blocks.length).toBeGreaterThan(0)
      expect(result.output.blocks.every((block) => block.code === item.code)).toBe(true)
    })
})

describe('RFC-626 3a–3d classification and kept references', () => {
  test('codes map onto quarantine, set-aside and contradiction', () => {
    for (const code of [
      'v2-boot-skill-main-missing',
      'v2-boot-skill-file-path-invalid',
      'v2-skill-encoding-unknown',
      'v2-boot-skill-operation-residue',
      'v2-boot-skill-conversion-unproven',
      'v2-some-future-code',
    ])
      expect(automaticSkillDisposition(code, [])).toBe('quarantine')
    for (const code of [
      'v2-boot-skill-husk-references',
      'v2-boot-skill-reservation-unsettled',
      'v2-boot-skill-orphan-version',
      'v2-boot-skill-source-codec',
    ])
      expect(automaticSkillDisposition(code, [])).toBe('set-aside')
    for (const code of [
      'v2-boot-skill-fact-missing',
      'v2-boot-skill-source-changed',
      'v2-boot-skill-version-source-changed',
      'v2-boot-skill-frozen-bytes-mismatch',
      'v2-boot-skill-frozen-hash-mismatch',
      'v2-boot-skill-duplicate-path',
      'v2-boot-skill-tree-missing',
      'v2-boot-skill-husk-unproven',
      'v2-boot-skill-live-unproven',
      'v2-boot-skill-group-unproven',
    ])
      expect(automaticSkillDisposition(code, [])).toBe('contradiction')
    // An interrupted creation that never reached its database commit was never published.
    expect(
      automaticSkillDisposition('v2-boot-skill-operation-unsettled', [
        { kind: 'reserve', phase: 'fs-published' },
      ]),
    ).toBe('set-aside')
    for (const operation of [
      { kind: 'reserve', phase: 'db-committed' },
      { kind: 'version-write', phase: 'intent' },
      { kind: 'delete', phase: 'fs-staged' },
      { kind: 'migrate', phase: 'fs-staged' },
      { kind: 'reserve', phase: 'unknown-phase' },
    ])
      expect(automaticSkillDisposition('v2-boot-skill-operation-unsettled', [operation])).toBe(
        'quarantine',
      )
  })

  test('kept references name the found or canonical directory, or the database tree', () => {
    for (const [tree, expected] of [
      ['live', `skills/${SKILL}/files`],
      ['version:3', `skills/${SKILL}/versions/v3/files`],
    ] as const) {
      expect(canonicalSkillTreePath(SKILL, tree)).toBe(expected)
      const canonical = unavailableSkillTreeColumns({
        skillId: SKILL,
        tree,
        source: 'local-file',
        reference: null,
      })
      expect(canonical.location).toBe(expected)
      expect(canonical.inline).toBeNull()
      const ref = contentRefColumns.decode(canonical.refJson, canonical.inline)
      expect(skillReferencePath(ref, SKILL, tree)).toBe(expected)
      const found = unavailableSkillTreeColumns({
        skillId: SKILL,
        tree,
        source: 'local-file',
        reference: `${HOME}/found/${tree}`,
      })
      expect(
        skillReferencePath(contentRefColumns.decode(found.refJson, found.inline), SKILL, tree),
      ).toBe(`${HOME}/found/${tree}`)
      const database = unavailableSkillTreeColumns({
        skillId: SKILL,
        tree,
        source: 'database-bytes',
        reference: null,
      })
      expect(
        skillReferencePath(
          contentRefColumns.decode(database.refJson, database.inline),
          SKILL,
          tree,
        ),
      ).toBe(expected)
    }
  })
})

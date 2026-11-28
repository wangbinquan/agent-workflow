// RFC-626: source rows, frozen trees and boot facts for the skill rule tests
// (rfc626-skill-boot-quarantine, rfc626-skill-operation-settlement). Facts are written by hand so
// that each case names exactly the state the capture would have recorded.
import {
  createSkillBootConversion,
  type SkillBootContentConverter,
} from '@/modules/resource-catalog/infrastructure/migration/skillBootRules'
import {
  skillBootFactId,
  type FrozenSkillTree,
  type SkillBootFact,
} from '@/modules/resource-catalog/infrastructure/migration/skillBootFacts'
import { digestSortedTree } from '@/modules/resource-catalog/infrastructure/legacy/skillHash'
import { skillRowPath } from '@/modules/resource-catalog/infrastructure/databaseSkillTrees'
import {
  createBootUpgradeFacts,
  type BootUpgradeFact,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { bytesDigest, valueDigest } from '@/platform/persistence/migration/conversion/digest'
import type {
  ConversionResolution,
  SourceRow,
  TargetRow,
} from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import { frozenValues } from './rfc395V2/contentFixtures'
import { runRuleUnit, sourceRow as sourceRowOf, type RuleUnitResult } from './rfc626CatalogRuleUnit'

export const SKILL = 'skill-alpha'
/** An old home outside any test directory: references to it are only ever compared as text. */
export const HOME = '/rfc626-old-home'

export function skillSource(overrides: DecodedSourceRow = {}): SourceRow {
  return sourceRowOf(
    'skills',
    frozenValues('skills', {
      id: SKILL,
      name: 'alpha',
      managed_path: `skills/${SKILL}/files`,
      owner_user_id: null,
      reservation_state: 'ready',
      version_state: 'snapshot-authoritative',
      content_version: 1,
      ...overrides,
    }),
    ['id'],
  )
}
export function versionSource(overrides: DecodedSourceRow = {}): SourceRow {
  return sourceRowOf(
    'skill_versions',
    frozenValues('skill_versions', {
      id: `${SKILL}-v1`,
      skill_id: SKILL,
      version_index: 1,
      files_path: `skills/${SKILL}/versions/v1/files`,
      source: 'initial',
      summary: null,
      fusion_id: null,
      restored_from_version: null,
      author_user_id: null,
      content_hash: null,
      ...overrides,
    }),
    ['id'],
  )
}
export function operationSource(overrides: DecodedSourceRow = {}): SourceRow {
  return sourceRowOf(
    'skill_operations',
    frozenValues('skill_operations', {
      op_id: 'op-1',
      skill_id: SKILL,
      kind: 'reserve',
      phase: 'intent',
      active: 1,
      ...overrides,
    }),
    ['op_id'],
  )
}
export function lockSource(overrides: DecodedSourceRow = {}): SourceRow {
  return sourceRowOf(
    'skill_operation_locks',
    frozenValues('skill_operation_locks', { locked_skill_id: SKILL, op_id: 'op-1', ...overrides }),
    ['locked_skill_id'],
  )
}

/** A frozen tree exactly as the capture freezes one (`freezeFiles`). */
export function frozenTree(
  reference: string,
  files: Readonly<Record<string, string>> = { 'SKILL.md': '# alpha\n' },
  source: FrozenSkillTree['source'] = 'local-file',
): FrozenSkillTree {
  const entries = Object.entries(files)
    .map(([path, text]) => ({ path, bytes: Buffer.from(text) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    source,
    reference,
    present: true,
    files: entries.map(({ path, bytes }) => ({
      path,
      size: bytes.length,
      sha256: bytesDigest(bytes).slice(7),
      base64: bytes.toString('base64'),
    })),
    contentHash: digestSortedTree(
      entries.map((entry) => entry.path),
      (path) => entries.find((entry) => entry.path === path)!.bytes,
    ),
  }
}

/** The boot fact of one skill row; blocked with `reason` unless `input` says otherwise. */
export function skillFact(skill: SourceRow, input: Partial<SkillBootFact> = {}): BootUpgradeFact {
  const evidence: SkillBootFact = {
    skillId: String(skill.values.id),
    name: String(skill.values.name),
    sourceDigest: valueDigest(skill.values),
    state: 'blocked',
    reason: null,
    live: null,
    versions: [],
    initialVersion: false,
    rootEmpty: false,
    roots: [],
    operationsDigest: valueDigest({ operations: [], locks: [] }),
    references: [],
    ...input,
  }
  return { id: skillBootFactId(evidence.skillId), kind: 'skill-content', material: null, evidence }
}

export function recordingConverter(convert?: SkillBootContentConverter): {
  readonly calls: string[]
  readonly convert: SkillBootContentConverter
} {
  const calls: string[] = []
  return {
    calls,
    convert: async (input, ctx) => {
      calls.push(input.tree)
      if (!convert) throw new Error('rfc626 fixture: this case reads no skill bytes')
      return convert(input, ctx)
    },
  }
}

export async function convertSkills(input: {
  readonly rows: readonly SourceRow[]
  readonly facts: readonly BootUpgradeFact[]
  readonly resolution?: ConversionResolution
  readonly convert?: SkillBootContentConverter
  readonly groupKeys?: readonly string[]
}): Promise<RuleUnitResult> {
  const contribution = createSkillBootConversion(input.convert ?? recordingConverter().convert)
    .withBootUpgrade!(createBootUpgradeFacts(input.facts))
  return runRuleUnit({
    rule: contribution.rules[0]!,
    lookups: contribution.lookups,
    rows: input.rows,
    groupKeys: input.groupKeys ?? [SKILL],
    ...(input.resolution ? { resolution: input.resolution } : {}),
  })
}

/** The path every reader of a skill row resolves from its reference (null for none). */
export function treePath(row: TargetRow, skillId: string, tree: string): string | null {
  return skillRowPath(
    {
      contentRefJson: row.content_ref_json as string | null,
      contentInlineBytes: (row.content_inline_bytes ?? null) as Uint8Array | null,
    },
    skillId,
    tree,
  )
}

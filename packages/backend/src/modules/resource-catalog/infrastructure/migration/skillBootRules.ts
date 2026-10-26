import {
  skillBootIdentityFacts,
  createBootUpgradeFacts,
  bootRowArchive,
  recordBootUpgradeEffect,
  blockBootRow,
  type BootUpgradeFacts,
  type SkillBootIdentityFact,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import type { LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import type {
  ConversionContribution,
  ConversionRule,
  RuleContext,
} from '@/platform/persistence/migration/conversion/rule'
import type {
  SourceRow,
  TargetRef,
  TargetRow,
} from '@/platform/persistence/migration/conversion/types'
import {
  SkillBootFactSchema,
  skillBootFactId,
  verifyFrozenSkillTree,
  type FrozenSkillTree,
} from './skillBootFacts'

/** X supplies its byte conversion/publication helper. It receives frozen bytes only,
 * and must return a durable tree reference for the exact requested identity. */
export interface SkillBootContentConverter {
  (
    input: {
      readonly skillId: string
      readonly tree: 'live' | `version:${number}`
      readonly source: SourceRow
      readonly target: TargetRef
      readonly synthesized?: boolean
      readonly snapshot: FrozenSkillTree
    },
    ctx: RuleContext,
  ): Promise<{ readonly refJson: string; readonly inline: Uint8Array | null }>
}
const ref = { id: 'resource-catalog/boot-skills', version: 1 } as const
export function createSkillBootConversion(
  convertContent: SkillBootContentConverter,
): ConversionContribution {
  const bind = (facts: BootUpgradeFacts): ConversionContribution => {
    const bound = new Map(
      facts.facts
        .filter((fact) => fact.kind === 'skill-content')
        .map((fact) => [fact.id, SkillBootFactSchema.parse(fact.evidence)]),
    )
    const identities: LookupBuilder<SkillBootIdentityFact> = {
      key: skillBootIdentityFacts,
      sources: ['skills', 'skill_versions'],
      build(staged, put) {
        for (const row of staged.rows('skills')) {
          const id = String(row.values.id),
            factId = skillBootFactId(id),
            fact = bound.get(factId)
          const reason = !fact
            ? 'v2-boot-skill-fact-missing'
            : valueDigest(row.values) !== fact.sourceDigest
              ? 'v2-boot-skill-source-changed'
              : row.codecFailure
                ? 'v2-boot-skill-source-codec'
                : fact.reason
          put(id, {
            skillId: id,
            state: reason ? 'blocked' : fact!.state,
            reason,
            factIds: [factId],
          })
        }
        // Orphans still receive a group and a per-row block rather than disappearing from coverage.
        const ids = new Set([...staged.rows('skills')].map((row) => row.values.id))
        for (const row of staged.rows('skill_versions'))
          if (typeof row.values.skill_id === 'string' && !ids.has(row.values.skill_id)) {
            ids.add(row.values.skill_id)
            put(row.values.skill_id, {
              skillId: row.values.skill_id,
              state: 'blocked',
              reason: 'v2-boot-skill-orphan-version',
              factIds: [],
            })
          }
      },
    }
    const rule: ConversionRule = {
      ref,
      owner: 'resource-catalog',
      claims: ['skills', 'skill_versions'],
      produces: [
        { table: 'skills' },
        { table: 'skill_versions' },
        { table: 'content_objects' },
        { table: 'content_bytes' },
        { table: 'skill_content_entries' },
      ],
      lookups: [skillBootIdentityFacts],
      unit: {
        kind: 'group',
        driver: skillBootIdentityFacts,
        groupColumn: 'id',
        members: [
          { table: 'skills', column: 'id' },
          { table: 'skill_versions', column: 'skill_id' },
        ],
        groupsPerUnit: 1,
      },
      async convert(unit, ctx) {
        const allRows = [...unit.rows.values()].flat()
        for (const id of unit.groupKeys ?? []) {
          const identity = ctx.lookup(skillBootIdentityFacts).require(id),
            fact = bound.get(skillBootFactId(id))
          const skill = unit.rows.get('skills')?.find((row) => row.values.id === id)
          const versions =
            unit.rows.get('skill_versions')?.filter((row) => row.values.skill_id === id) ?? []
          const rows = skill ? [skill, ...versions] : versions
          if (identity.state === 'blocked' || !skill || !fact) {
            for (const row of rows)
              blockBootRow(
                ctx,
                ref,
                row,
                identity.reason ?? 'v2-boot-skill-fact-missing',
                { skillId: id },
                identity.factIds,
              )
            continue
          }
          try {
            if (
              fact.versions.length !== versions.length ||
              versions.some(
                (row) =>
                  !fact.versions.some(
                    (version) =>
                      version.id === row.values.id &&
                      version.sourceDigest === valueDigest(row.values),
                  ),
              )
            )
              throw new Error('v2-boot-skill-version-source-changed')
            if (fact.live) verifyFrozenSkillTree(fact.live)
            for (const version of fact.versions) verifyFrozenSkillTree(version.tree)
            if (identity.state === 'husk') {
              if (
                !fact.rootEmpty ||
                fact.versions.length ||
                fact.references.length ||
                fact.live?.files.length
              )
                throw new Error('v2-boot-skill-husk-unproven')
              ctx.out.exception({
                sourceTable: skill.table,
                sourceKey: skill.encodedKey,
                sourcePhase: skill.phase,
                class: 'archived',
                kind: 'archived',
                targets: [],
                archive: bootRowArchive(ctx, skill),
                decision: {
                  code: 'v2-boot-skill-empty-husk',
                  detail: {
                    skillId: id,
                    roots: fact.roots,
                  },
                },
              })
              recordBootUpgradeEffect(
                { ...ctx, out: { ...ctx.out, record: (record) => ctx.out.record(record) } },
                ref,
                skill,
                {
                  disposition: 'history-only',
                  targets: [],
                  before: { skillId: id, emptyRoot: true },
                  after: { removedHusk: id, rootEmpty: true },
                  reason: 'v2-boot-skill-empty-husk',
                  factIds: identity.factIds,
                },
              )
              continue
            }
            if (!fact.live) throw new Error('v2-boot-skill-live-unproven')
            const nextSkill: Record<string, TargetRow[string]> = Object.fromEntries(
              Object.entries(skill.values).filter(([name]) => name !== 'managed_path'),
            )
            if (fact.initialVersion)
              Object.assign(nextSkill, {
                content_version: 1,
                version_state: 'snapshot-authoritative',
                updated_at: ctx.planTime,
              })
            const skillTarget = { table: 'skills', key: ctx.target.key('skills', nextSkill) }
            const content = await convertContent(
              {
                skillId: id,
                tree: 'live',
                source: skill,
                target: skillTarget,
                snapshot: fact.live,
              },
              ctx,
            )
            Object.assign(nextSkill, {
              content_ref_json: content.refJson,
              content_inline_bytes: content.inline,
            })
            const targets = [skillTarget]
            const outputs: { table: string; values: TargetRow; origin: SourceRow }[] = [
              { table: 'skills', values: nextSkill, origin: skill },
            ]
            for (const row of versions) {
              const version = fact.versions.find((version) => version.id === row.values.id)!
              const values: Record<string, TargetRow[string]> = Object.fromEntries(
                Object.entries(row.values).filter(([name]) => name !== 'files_path'),
              )
              const target = {
                table: 'skill_versions',
                key: ctx.target.key('skill_versions', values),
              }
              const content = await convertContent(
                {
                  skillId: id,
                  tree: `version:${version.version}`,
                  source: row,
                  target,
                  snapshot: version.tree,
                },
                ctx,
              )
              Object.assign(values, {
                content_ref_json: content.refJson,
                content_inline_bytes: content.inline,
              })
              outputs.push({ table: 'skill_versions', values, origin: row })
            }
            let initial: { id: string; version: number; hash: string } | null = null
            if (fact.initialVersion) {
              const versionId = ctx.ids.child('boot-skill-initial-version@1', skill.encodedKey, 1)
              const values: Record<string, TargetRow[string]> = {
                id: versionId,
                skill_id: id,
                version_index: 1,
                source: 'initial',
                summary: null,
                fusion_id: null,
                restored_from_version: null,
                author_user_id: '__system__',
                content_hash: fact.live.contentHash,
                created_at: ctx.planTime,
              }
              const target = {
                table: 'skill_versions',
                key: ctx.target.key('skill_versions', values),
              }
              const content = await convertContent(
                {
                  skillId: id,
                  tree: 'version:1',
                  source: skill,
                  target,
                  snapshot: fact.live,
                  synthesized: true,
                },
                ctx,
              )
              Object.assign(values, {
                content_ref_json: content.refJson,
                content_inline_bytes: content.inline,
              })
              outputs.push({ table: 'skill_versions', values, origin: skill })
              targets.push(target)
              initial = { id: versionId, version: 1, hash: fact.live.contentHash }
            }
            for (const output of outputs) ctx.out.row(output.table, output.values, output.origin)
            for (const row of rows) {
              const rowTargets =
                row === skill
                  ? targets
                  : outputs
                      .filter((output) => output.origin === row)
                      .map((output) => ({
                        table: output.table,
                        key: ctx.target.key(output.table, output.values),
                      }))
              ctx.out.exception({
                sourceTable: row.table,
                sourceKey: row.encodedKey,
                sourcePhase: row.phase,
                class: 'converted',
                kind: row === skill && initial ? 'derived-id' : 'conflict-resolved',
                targets: rowTargets,
                archive: bootRowArchive(ctx, row),
                decision: {
                  code: 'v2-boot-skill-content-proven',
                  detail: { skillId: id, initial },
                },
              })
              recordBootUpgradeEffect(ctx, ref, row, {
                disposition: 'transformed',
                targets: rowTargets,
                before: {
                  skillId: id,
                  reference:
                    row === skill
                      ? fact.live.reference
                      : fact.versions.find((version) => version.id === row.values.id)!.tree
                          .reference,
                  ...(row === skill
                    ? {
                        contentVersion: Number(row.values.content_version),
                        versionState: String(row.values.version_state),
                      }
                    : {}),
                },
                after: {
                  skillId: id,
                  liveHash: fact.live.contentHash,
                  snapshots: fact.versions.map((version) => ({
                    id: version.id,
                    version: version.version,
                    hash: version.tree.contentHash,
                  })),
                  initial,
                  sourceDirectoriesMoved: false,
                },
                reason: 'v2-boot-skill-content-proven',
                factIds: identity.factIds,
              })
            }
          } catch (error) {
            for (const row of rows)
              blockBootRow(
                ctx,
                ref,
                row,
                error instanceof Error ? error.message : 'v2-boot-skill-conversion-unproven',
                { skillId: id },
                identity.factIds,
              )
          }
        }
        if (!unit.groupKeys?.length)
          for (const row of allRows)
            blockBootRow(ctx, ref, row, 'v2-boot-skill-group-unproven', null)
      },
    }
    return { rules: [rule], lookups: [identities], validators: [] }
  }
  return { ...bind(createBootUpgradeFacts([])), withBootUpgrade: bind }
}

import { memoriesRule } from '@/platform/persistence/migration/conversion/alignment/memories'
import { QUARANTINED_FUSION_SKILL_ID as quarantinedSkillId } from '@agent-workflow/shared'
import {
  fusionProvenanceFacts,
  recordBootUpgradeEffect,
  blockBootRow,
  bootRowArchive,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import type {
  ConversionContribution,
  ConversionRule,
} from '@/platform/persistence/migration/conversion/rule'

const ref = { id: 'memory/boot-fused-provenance', version: 2 } as const
export const legacyBootMemoryRule: ConversionRule = {
  ...memoriesRule,
  ref,
  owner: 'memory',
  disposition: 'converted',
  lookups: [...memoriesRule.lookups, fusionProvenanceFacts],
  async convert(unit, ctx) {
    for (const row of unit.rows.get('memories') ?? []) {
      const fact =
        typeof row.values.fused_fusion_id === 'string'
          ? ctx.lookup(fusionProvenanceFacts).get(row.values.fused_fusion_id)
          : undefined
      const fused = row.values.status === 'fused'
      const exact =
        fact?.versions.filter(
          (version) => version.version === row.values.fused_into_skill_version,
        ) ?? []
      const before = {
        id: String(row.values.id),
        status: String(row.values.status),
        skillId:
          typeof row.values.fused_into_skill_id === 'string'
            ? row.values.fused_into_skill_id
            : null,
        version:
          typeof row.values.fused_into_skill_version === 'number'
            ? row.values.fused_into_skill_version
            : null,
        supersedesId:
          typeof row.values.supersedes_id === 'string' ? row.values.supersedes_id : null,
        supersededById:
          typeof row.values.superseded_by_id === 'string' ? row.values.superseded_by_id : null,
      }
      if (fused && row.values.fused_into_skill_id !== quarantinedSkillId && fact?.reason) {
        blockBootRow(ctx, ref, row, 'v2-boot-fused-memory-unproven', before, fact?.factIds)
        continue
      }
      const skillId =
        row.values.fused_into_skill_id === quarantinedSkillId
          ? quarantinedSkillId
          : fact?.skillId &&
              fact.skillId !== quarantinedSkillId &&
              exact.length === 1 &&
              exact[0]!.skillId === fact.skillId
            ? fact.skillId
            : quarantinedSkillId
      const changed = fused && row.values.fused_into_skill_id !== skillId
      // Reuse the alignment converter in full, including its supersession exception evidence.
      await memoriesRule.convert(
        { rows: new Map([['memories', [row]]]) },
        {
          ...ctx,
          out: {
            ...ctx.out,
            row(table, values, origin) {
              const next = changed ? { ...values, fused_into_skill_id: skillId } : values
              ctx.out.row(table, next, origin)
              const targets = [{ table, key: ctx.target.key(table, next) }]
              if (changed)
                ctx.out.exception({
                  sourceTable: row.table,
                  sourceKey: row.encodedKey,
                  sourcePhase: row.phase,
                  class: 'converted',
                  kind: 'conflict-resolved',
                  targets,
                  archive: bootRowArchive(ctx, row),
                  decision: {
                    code: 'v2-boot-fused-memory-proven',
                    detail: { skillId },
                  },
                })
              recordBootUpgradeEffect(ctx, ref, row, {
                disposition:
                  changed ||
                  next.supersedes_id !== row.values.supersedes_id ||
                  next.superseded_by_id !== row.values.superseded_by_id
                    ? 'transformed'
                    : 'copied',
                targets,
                before,
                after: {
                  ...before,
                  skillId: changed ? skillId : before.skillId,
                  supersedesId: typeof next.supersedes_id === 'string' ? next.supersedes_id : null,
                  supersededById:
                    typeof next.superseded_by_id === 'string' ? next.superseded_by_id : null,
                },
                reason: fused
                  ? skillId === quarantinedSkillId
                    ? 'v2-boot-fused-memory-quarantined'
                    : 'v2-boot-fused-memory-proven'
                  : 'v2-boot-memory-not-fused',
                factIds: fused ? (fact?.factIds ?? []) : [],
              })
            },
          },
        },
      )
    }
  },
}
export const conversion: ConversionContribution = {
  rules: [legacyBootMemoryRule],
  lookups: [],
  validators: [],
}

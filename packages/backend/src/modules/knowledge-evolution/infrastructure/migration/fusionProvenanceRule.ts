import { decodeFusionSkillToken, QUARANTINED_FUSION_SKILL_ID } from '../fusionRepositorySupport'
import {
  fusionProvenanceFacts,
  emitBootRow,
  blockBootRow,
  type FusionProvenanceFact,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import type { LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import type {
  ConversionContribution,
  ConversionRule,
} from '@/platform/persistence/migration/conversion/rule'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'

const ref = { id: 'knowledge-evolution/boot-fusion-provenance', version: 2 } as const
export function decideFusionProvenance(
  row: DecodedSourceRow,
  versions: readonly { readonly skillId: string; readonly version: number }[],
): FusionProvenanceFact {
  const token =
    typeof row.precondition_token === 'string'
      ? decodeFusionSkillToken(row.precondition_token)
      : null
  const tokenValid =
    token !== null &&
    token.skillId !== QUARANTINED_FUSION_SKILL_ID &&
    token.contentVersion === row.base_skill_version
  const sole = versions.length === 1 ? versions[0] : undefined
  const ledgerValid =
    sole !== undefined &&
    sole.skillId !== QUARANTINED_FUSION_SKILL_ID &&
    (row.applied_skill_version === null || row.applied_skill_version === sole.version)
  let skillId: string | null = null
  let proof: FusionProvenanceFact['proof'] = null
  if (token === null && ledgerValid) {
    skillId = sole!.skillId
    proof = 'ledger'
  } else if (tokenValid) {
    if (versions.length === 0 && row.applied_skill_version === null) {
      skillId = token.skillId
      proof = 'token'
    } else if (ledgerValid && sole!.skillId === token.skillId) {
      skillId = token.skillId
      proof = 'token-and-ledger'
    }
  }
  const quarantined = row.skill_id === QUARANTINED_FUSION_SKILL_ID
  const resolved = quarantined
    ? QUARANTINED_FUSION_SKILL_ID
    : (skillId ?? QUARANTINED_FUSION_SKILL_ID)
  return {
    skillId: resolved,
    proof: quarantined ? null : proof,
    versions,
    reason: null,
    factIds: [],
    inputDigest: valueDigest({
      token,
      baseVersion: row.base_skill_version,
      appliedVersion: row.applied_skill_version,
      versions,
    }),
    wouldPreviouslyQuarantine:
      resolved === QUARANTINED_FUSION_SKILL_ID && row.skill_id !== resolved,
    wouldPreviouslyTerminalize:
      !quarantined &&
      resolved === QUARANTINED_FUSION_SKILL_ID &&
      ['running', 'awaiting_approval', 'applying'].includes(String(row.status)),
  }
}
export const fusionProvenanceLookup: LookupBuilder<FusionProvenanceFact> = {
  key: fusionProvenanceFacts,
  sources: ['fusions', 'skill_versions'],
  build(staged, put) {
    const versions = [...staged.rows('skill_versions')]
    for (const row of staged.rows('fusions')) {
      const ledger = versions.filter(
        (version) =>
          version.values.fusion_id === row.values.id && version.values.source === 'fusion',
      )
      let result = decideFusionProvenance(
        row.values,
        ledger.map((version) => ({
          skillId: String(version.values.skill_id),
          version: Number(version.values.version_index),
        })),
      )
      if (
        row.codecFailure ||
        (row.values.skill_id !== QUARANTINED_FUSION_SKILL_ID &&
          ledger.some((version) => version.codecFailure))
      )
        result = {
          ...result,
          skillId: null,
          proof: null,
          reason: 'v2-boot-fusion-source-unproven',
          wouldPreviouslyQuarantine: null,
          wouldPreviouslyTerminalize: null,
        }
      put(String(row.values.id), result)
    }
  },
}
export const fusionProvenanceRule: ConversionRule = {
  ref,
  owner: 'knowledge-evolution',
  claims: ['fusions'],
  produces: [{ table: 'fusions' }],
  lookups: [fusionProvenanceFacts],
  unit: { kind: 'source-chunk', table: 'fusions' },
  convert(unit, ctx) {
    for (const row of unit.rows.get('fusions') ?? []) {
      const fact = ctx.lookup(fusionProvenanceFacts).require(String(row.values.id))
      const before = {
        id: String(row.values.id),
        skillId: String(row.values.skill_id),
        status: String(row.values.status),
        error: typeof row.values.error === 'string' ? row.values.error : null,
      }
      if (!fact.skillId) {
        blockBootRow(
          ctx,
          ref,
          row,
          fact.reason!,
          {
            ...before,
            wouldPreviouslyQuarantine: fact.wouldPreviouslyQuarantine,
            wouldPreviouslyTerminalize: fact.wouldPreviouslyTerminalize,
          },
          fact.factIds,
        )
        continue
      }
      const terminalize = fact.wouldPreviouslyTerminalize === true
      const values = {
        ...row.values,
        skill_id: fact.skillId,
        ...(terminalize
          ? {
              status: 'failed',
              error: 'fusion provenance could not be proven during upgrade; re-initiate the fusion',
              decided_at: ctx.planTime,
            }
          : {}),
      }
      emitBootRow(ctx, ref, row, values, {
        changed: row.values.skill_id !== fact.skillId || terminalize,
        before,
        after: {
          ...before,
          skillId: fact.skillId,
          status: String(values.status),
          error: typeof values.error === 'string' ? values.error : null,
          proof: fact.proof,
          versions: fact.versions,
          wouldPreviouslyQuarantine: fact.wouldPreviouslyQuarantine,
          wouldPreviouslyTerminalize: fact.wouldPreviouslyTerminalize,
        },
        reason:
          fact.skillId === QUARANTINED_FUSION_SKILL_ID
            ? 'v2-boot-fusion-quarantined'
            : 'v2-boot-fusion-provenance-proven',
        factIds: fact.factIds,
      })
    }
  },
}
export const conversion: ConversionContribution = {
  rules: [fusionProvenanceRule],
  lookups: [fusionProvenanceLookup],
  validators: [],
}

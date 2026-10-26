import { z } from 'zod'
import { bytesDigest, valueDigest } from './digest'
import { lookupKey, type LookupReader } from './lookups'
import { operatorDecisionRowDigest } from './types'
import type { EncodedKey, JsonValue, MigrationRecord, RuleRef, SourceRow, TargetRef } from './types'
import type { RuleContext } from './rule'
import { rowBlock } from './blockCodes'
import { canonicalSchemaJson } from '../../schema/canonical'
import type { TargetRow } from './types'

/** B-1 contract: keys use the original URL bytes, before any display projection. */
export interface RepositoryUrlFact {
  readonly state: 'proven' | 'blocked'
  readonly cachedRepoId: string | null
  readonly repoUrl: string | null
  readonly rawUrlDigest: string | null
  readonly factIds: readonly string[]
  readonly reason: string | null
}
export const repositoryUrlFacts = lookupKey<RepositoryUrlFact>('boot/repository-urls', 2)
export interface SkillBootIdentityFact {
  readonly skillId: string
  readonly state: 'proven' | 'husk' | 'blocked'
  readonly reason: string | null
  readonly factIds: readonly string[]
}
export const skillBootIdentityFacts = lookupKey<SkillBootIdentityFact>('boot/skill-identities', 1)
export interface FusionProvenanceFact {
  readonly skillId: string | null
  readonly reason: string | null
  readonly proof: 'token' | 'ledger' | 'token-and-ledger' | null
  readonly versions: readonly { readonly skillId: string; readonly version: number }[]
  readonly factIds: readonly string[]
  readonly inputDigest: string
  readonly wouldPreviouslyQuarantine: boolean | null
  readonly wouldPreviouslyTerminalize: boolean | null
}
export const fusionProvenanceFacts = lookupKey<FusionProvenanceFact>('boot/fusion-provenance', 2)
export function repositoryUrlFactKey(url: string): string {
  return `url:${bytesDigest(url)}`
}
export function repositoryCacheFactKey(id: string): string {
  return `cache:${id}`
}
export function resolveRepositoryUrlFact(
  facts: LookupReader<RepositoryUrlFact>,
  rawUrl: string | null,
  cachedRepoId: string | null,
): RepositoryUrlFact {
  const byUrl = rawUrl ? facts.get(repositoryUrlFactKey(rawUrl)) : undefined
  const blocked = (reason: string): RepositoryUrlFact => ({
    state: 'blocked',
    cachedRepoId,
    repoUrl: null,
    rawUrlDigest: rawUrl ? bytesDigest(rawUrl) : null,
    factIds: byUrl?.factIds ?? [],
    reason,
  })
  // The old boot only linked missing IDs. Deleted caches and URL disagreement do not
  // invalidate an already persisted reference.
  if (cachedRepoId === null && byUrl?.state === 'blocked')
    return blocked(byUrl.reason ?? 'v2-boot-url-unproven')
  return {
    state: 'proven',
    cachedRepoId: cachedRepoId ?? byUrl?.cachedRepoId ?? null,
    repoUrl: byUrl?.repoUrl ?? rawUrl,
    rawUrlDigest: rawUrl ? bytesDigest(rawUrl) : null,
    factIds: cachedRepoId === null ? (byUrl?.factIds ?? []) : [],
    reason: null,
  }
}

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const key = z
  .string()
  .startsWith('mk1:')
  .transform((value): EncodedKey => value as EncodedKey)
export const BootUpgradeEffectSchema = z.strictObject({
  version: z.literal(1),
  rule: z.strictObject({ id: z.string().min(1), version: z.number().int().positive() }),
  sourceTable: z.string().min(1),
  sourceKey: key,
  sourcePhase: z.enum(['current', 'pre-upgrade']),
  sourceRowDigest: digest,
  disposition: z.enum(['copied', 'transformed', 'history-only', 'blocked']),
  targets: z.array(z.strictObject({ table: z.string().min(1), key })).readonly(),
  before: z.json(),
  after: z.json(),
  reason: z.string().min(1),
  factIds: z.array(z.string().min(1)).readonly(),
})
export type BootUpgradeEffect = z.infer<typeof BootUpgradeEffectSchema>
export interface BootUpgradeFact {
  readonly id: string
  readonly kind: 'repository-url-key' | 'local-git' | 'skill-content' | 'runtime-config'
  /** Deciding semantics only; null marks evidence-only facts. No row digests, mtimes or unused OIDs. */
  readonly material: JsonValue
  readonly evidence: JsonValue
}
export interface BootUpgradeFacts {
  readonly version: 1
  readonly facts: readonly BootUpgradeFact[]
  readonly environmentDigest: string
}
export function createBootUpgradeFacts(facts: readonly BootUpgradeFact[]): BootUpgradeFacts {
  const sorted = [...facts].sort((a, b) => a.id.localeCompare(b.id))
  if (new Set(sorted.map((fact) => fact.id)).size !== sorted.length)
    throw new Error('v2-boot-duplicate-fact')
  return {
    version: 1,
    facts: sorted,
    environmentDigest: valueDigest(
      sorted
        .filter((fact) => fact.material !== null)
        .map(({ id, kind, material }) => ({ id, kind, material })),
    ),
  }
}
export const BOOT_EFFECT_RECORD = 'v2-boot-upgrade-effect@1'
/** Full row digests remain in the document; approval binds only semantic effects. */
export function materialBootUpgradeEffects(effects: readonly BootUpgradeEffect[]): JsonValue[] {
  return canonicalBootUpgradeEffects(effects)
    .filter((effect) => effect.disposition !== 'copied')
    .map(({ sourceRowDigest: _sourceRowDigest, ...effect }) => effect)
    .sort((a, b) => valueDigest(a).localeCompare(valueDigest(b)))
}
export function canonicalBootUpgradeEffects(
  effects: readonly BootUpgradeEffect[],
): BootUpgradeEffect[] {
  return effects
    .map((effect) =>
      BootUpgradeEffectSchema.parse({
        ...effect,
        factIds: [...new Set(effect.factIds)].sort(),
        targets: [...effect.targets].sort((a, b) => valueDigest(a).localeCompare(valueDigest(b))),
      }),
    )
    .sort((a, b) => valueDigest(a).localeCompare(valueDigest(b)))
}
export function bootUpgradeEffectsFromRecords(
  records: readonly MigrationRecord[],
): BootUpgradeEffect[] {
  return canonicalBootUpgradeEffects(
    records.flatMap((record) =>
      record.kind === 'decision' && record.code === BOOT_EFFECT_RECORD
        ? [BootUpgradeEffectSchema.parse(record.payload)]
        : [],
    ),
  )
}
export function recordBootUpgradeEffect(
  ctx: RuleContext,
  rule: RuleRef,
  row: SourceRow,
  input: {
    disposition: BootUpgradeEffect['disposition']
    targets: readonly TargetRef[]
    before: JsonValue
    after: JsonValue
    reason: string
    factIds?: readonly string[]
  },
): void {
  const effect = BootUpgradeEffectSchema.parse({
    ...input,
    version: 1,
    rule,
    sourceTable: row.table,
    sourceKey: row.encodedKey,
    sourcePhase: row.phase,
    sourceRowDigest: operatorDecisionRowDigest(row),
    factIds: input.factIds ?? [],
  })
  ctx.out.record({ kind: 'decision', code: BOOT_EFFECT_RECORD, payload: effect }, row)
}

export function bootRowArchive(ctx: RuleContext, row: SourceRow) {
  return ctx.out.archive({
    kind: 'source-journal',
    sourceTable: row.table,
    format: 'logical-row@1',
    bytes: new TextEncoder().encode(
      canonicalSchemaJson({ canonical: row.canonical, raw: row.raw ?? null }),
    ),
    rows: 1,
  })
}
export function blockBootRow(
  ctx: RuleContext,
  rule: RuleRef,
  row: SourceRow,
  reason: string,
  detail: JsonValue,
  factIds: readonly string[] = [],
): void {
  ctx.out.block(rowBlock(reason, row, detail))
  recordBootUpgradeEffect(ctx, rule, row, {
    disposition: 'blocked',
    targets: [],
    before: detail,
    after: null,
    reason,
    factIds,
  })
}
export function emitBootRow(
  ctx: RuleContext,
  rule: RuleRef,
  row: SourceRow,
  values: TargetRow,
  input: {
    changed: boolean
    before: JsonValue
    after: JsonValue
    reason: string
    factIds?: readonly string[]
  },
): void {
  const targets = [{ table: row.table, key: ctx.target.key(row.table, values) }]
  ctx.out.row(row.table, values, row)
  if (input.changed)
    ctx.out.exception({
      sourceTable: row.table,
      sourceKey: row.encodedKey,
      sourcePhase: row.phase,
      class: 'converted',
      kind: 'conflict-resolved',
      targets,
      archive: bootRowArchive(ctx, row),
      decision: { code: input.reason, detail: input.after },
    })
  recordBootUpgradeEffect(ctx, rule, row, {
    disposition: input.changed ? 'transformed' : 'copied',
    targets,
    before: input.before,
    after: input.after,
    reason: input.reason,
    factIds: input.factIds,
  })
}

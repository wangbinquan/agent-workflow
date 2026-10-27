import type { MigrationProgressCallback } from '@/platform/persistence/migration/run/progress'
import type { VersionedSourceReader, SourcePreflight } from '../sourceTypes'
import type { SchemaRegistry } from '../../schema/registry'
import { compileContract } from '../../schema/contract'
import type {
  ConversionContribution,
  ConversionRule,
  RowValidator,
  ConversionSourceCatalog,
} from './rule'
import type { ContentInventory } from './content'
import { lookupIdentity, orderLookupBuilders, type LookupBuilder, type LookupKey } from './lookups'
import { valueDigest } from './digest'
import { createBootUpgradeFacts, type BootUpgradeFacts } from './bootUpgradeFacts'
import { BLOCK_CODES, ConversionContractError } from './blockCodes'
import { targetTopology, type TargetTopology } from './topology'
import { isTypedExpression } from './expressionEvaluator'
import { decodeMigrationKey } from './migrationKey'
import {
  OperatorDecisionSchema,
  type OperatorDecision,
  type ConversionBlock,
  type SourcePhase,
} from './types'

export const CONVERTER_VERSION = 'rfc395-v2@2'
export interface TargetRosterEntry {
  readonly table: string
  readonly sources: readonly string[]
}
export interface ConversionInput {
  readonly progress?: MigrationProgressCallback
  readonly onStagingPeak?: (bytes: number) => void
  readonly source: VersionedSourceReader
  readonly preflight: SourcePreflight
  readonly preUpgradeSource?: VersionedSourceReader
  readonly preUpgradePreflight?: SourcePreflight
  readonly target: SchemaRegistry
  readonly targetRoster?: readonly TargetRosterEntry[]
  readonly contributions: readonly ConversionContribution[]
  readonly content: ContentInventory
  readonly scratchRoot: string
  readonly planTime: number
  readonly chunkLimit?: number
  readonly targetGeneration: string
  readonly candidateBuild: string
  readonly sourceBackupId: string | null
  readonly contentManifestDigest: string
  readonly bootUpgradeFacts?: BootUpgradeFacts
  readonly operatorDecisions?: readonly OperatorDecision[]
  /** Explicit partial conversion for domain fixtures. Such a plan is never whole-database acceptance. */
  readonly sourceScope?: readonly string[]
}
export type ConversionPlanInput = Omit<ConversionInput, 'content' | 'scratchRoot'>
export interface ConversionPlanSection {
  readonly version: 1
  readonly digest: string
  readonly converterVersion: string
  readonly ruleSetDigest: string
  readonly sourceFingerprint: string
  readonly sourceVersion: string
  readonly sourceGenerationId: string
  readonly sourceWatermark: string
  readonly targetContractDigest: string
  readonly targetGeneration: string
  readonly candidateBuild: string
  readonly sourceBackupId: string | null
  readonly contentManifestDigest: string
  readonly bootUpgradeEnvironmentDigest?: string
  readonly planTime: number
  readonly coverage: 'complete' | 'partial'
  readonly chunkLimit: number
  readonly preUpgradeWatermark: string | null
  readonly operatorDecisions: readonly OperatorDecision[]
  readonly tables: readonly {
    readonly table: string
    readonly phase: SourcePhase
    readonly rows: number
    readonly rule: string | null
    readonly targets: readonly string[]
  }[]
  readonly topology: TargetTopology
  readonly deferredChecks: readonly { readonly table: string; readonly name: string }[]
  readonly blocks: readonly ConversionBlock[]
}
export interface ResolvedConversion {
  readonly rules: readonly ConversionRule[]
  readonly lookups: readonly LookupBuilder<unknown>[]
  readonly validators: readonly RowValidator[]
}
export function resolveContributions(
  input: ConversionSourceCatalog & { readonly contributions: readonly ConversionContribution[] },
): ResolvedConversion {
  const facts = input.bootUpgradeFacts ?? createBootUpgradeFacts([])
  if (createBootUpgradeFacts(facts.facts).environmentDigest !== facts.environmentDigest)
    throw new ConversionContractError('v2-boot-facts-digest', 'environment facts changed')
  const contributions = input.contributions.map((entry) => entry.withBootUpgrade?.(facts) ?? entry)
  const rules = contributions
    .flatMap((contribution) => [...contribution.rules, ...(contribution.forSource?.(input) ?? [])])
    .sort((a, b) => a.ref.id.localeCompare(b.ref.id))
  return {
    rules,
    lookups: orderLookupBuilders(contributions.flatMap((contribution) => contribution.lookups)),
    validators: contributions
      .flatMap((contribution) => contribution.validators)
      .sort((a, b) => a.ref.id.localeCompare(b.ref.id)),
  }
}
export function sourceIdentity(table: string, phase: SourcePhase = 'current'): string {
  return JSON.stringify([phase, table])
}
export function planConversion(input: ConversionPlanInput): ConversionPlanSection {
  return buildConversionPlan(input, resolveContributions(input))
}
export function buildConversionPlan(
  input: ConversionPlanInput,
  resolved: ResolvedConversion,
): ConversionPlanSection {
  const { rules, lookups, validators } = resolved
  const operatorDecisions = (input.operatorDecisions ?? [])
    .map((decision) => OperatorDecisionSchema.parse(decision))
    .sort((a, b) => valueDigest(a).localeCompare(valueDigest(b)))
  const decisionKeys = new Set<string>()
  for (const decision of operatorDecisions) {
    if (decodeMigrationKey(decision.sourceKey).table !== decision.sourceTable)
      throw new ConversionContractError('v2-operator-decision-key', decision.sourceTable)
    const key = JSON.stringify([
      decision.kind,
      decision.sourceTable,
      decision.sourcePhase,
      decision.sourceKey,
      decision.blockCode,
    ])
    if (decisionKeys.has(key))
      throw new ConversionContractError('v2-operator-decision-duplicate', key)
    decisionKeys.add(key)
  }
  const chunkLimit = input.chunkLimit ?? 1000
  if (
    !Number.isSafeInteger(chunkLimit) ||
    chunkLimit < 1 ||
    chunkLimit > 10000 ||
    !Number.isSafeInteger(input.planTime)
  )
    throw new ConversionContractError('v2-plan-options', 'invalid chunkLimit/planTime')
  if (!input.targetGeneration || !input.candidateBuild || !input.contentManifestDigest)
    throw new ConversionContractError(
      'v2-plan-binding',
      'generation, build and content manifest are required',
    )
  if (input.preflight.requiresOfflineUpgrade || !input.preflight.contract)
    throw new ConversionContractError('v2-source-upgrade-required', input.preflight.sourceVersion)
  if (!!input.preUpgradeSource !== !!input.preUpgradePreflight)
    throw new ConversionContractError(
      'v2-pre-upgrade-binding',
      'reader and preflight must be supplied together',
    )
  const takeovers = new Set<string>()
  for (const rule of rules)
    for (const declaration of rule.codecTakeovers ?? []) {
      const contract = (
        rule.sourcePhase === 'pre-upgrade' ? input.preUpgradePreflight : input.preflight
      )?.contract?.tables.find((table) => table.id === declaration.table)
      if (
        !rule.claims.includes(declaration.table) ||
        !contract ||
        rule.unit.kind === 'raw-chunk' ||
        !declaration.columns.length
      )
        throw new ConversionContractError('v2-codec-takeover-source', rule.ref.id)
      for (const column of declaration.columns) {
        if (
          !contract.columns.some((entry) => entry.name === column) ||
          contract.migrationKey.includes(column)
        )
          throw new ConversionContractError(
            'v2-codec-takeover-column',
            `${declaration.table}.${column}`,
          )
        const key = JSON.stringify([rule.sourcePhase ?? 'current', declaration.table, column])
        if (takeovers.has(key))
          throw new ConversionContractError('v2-duplicate-codec-takeover', key)
        takeovers.add(key)
      }
    }
  const claims = new Map<string, ConversionRule>()
  const ids = new Set<string>()
  const lookupIds = new Set(lookups.map((builder) => lookupIdentity(builder.key)))
  const targetNames = new Set(input.target.tables.map((table) => table.id))
  const sourceTables = new Set([
    ...input.preflight.tables.map((table) => sourceIdentity(table.table)),
    ...(input.preUpgradePreflight?.tables ?? []).map((table) =>
      sourceIdentity(table.table, 'pre-upgrade'),
    ),
  ])
  const requireLookup = (id: string): void => {
    if (!lookupIds.has(id)) throw new ConversionContractError(BLOCK_CODES.missingLookup, id)
  }
  const checkRef = (id: string, version: number): void => {
    if (!id || ids.has(id) || !Number.isSafeInteger(version) || version < 1)
      throw new ConversionContractError('v2-rule-ref', id)
    ids.add(id)
  }
  for (const rule of rules) {
    checkRef(rule.ref.id, rule.ref.version)
    if (!rule.owner || !rule.claims.length)
      throw new ConversionContractError('v2-rule-claims', rule.ref.id)
    for (const table of rule.claims) {
      const id = sourceIdentity(table, rule.sourcePhase)
      if (claims.has(id)) throw new ConversionContractError('v2-duplicate-claim', id)
      if (!sourceTables.has(id)) throw new ConversionContractError('v2-missing-source', id)
      claims.set(id, rule)
    }
    const unit = rule.unit
    if (unit.kind !== 'group') {
      if (rule.claims.length !== 1 || rule.claims[0] !== unit.table)
        throw new ConversionContractError('v2-unit-claims', rule.ref.id)
    } else {
      if (
        unit.groupsPerUnit !== undefined &&
        (!Number.isSafeInteger(unit.groupsPerUnit) || unit.groupsPerUnit < 1)
      )
        throw new ConversionContractError('v2-group-limit', rule.ref.id)
      const covered = unit.members.map((member) => member.table)
      if (typeof unit.driver === 'string') covered.push(unit.driver)
      else {
        requireLookup(lookupIdentity(unit.driver))
        if (
          !rule.lookups.some(
            (key) => lookupIdentity(key) === lookupIdentity(unit.driver as LookupKey<unknown>),
          )
        )
          throw new ConversionContractError('v2-undeclared-driver', rule.ref.id)
      }
      if (
        new Set(covered).size !== covered.length ||
        covered.length !== rule.claims.length ||
        rule.claims.some((table) => !covered.includes(table))
      )
        throw new ConversionContractError('v2-unit-claims', rule.ref.id)
    }
    for (const key of rule.lookups) requireLookup(lookupIdentity(key))
    if (new Set(rule.produces.map((output) => output.table)).size !== rule.produces.length)
      throw new ConversionContractError('v2-duplicate-target', rule.ref.id)
    for (const output of rule.produces) {
      if (!targetNames.has(output.table))
        throw new ConversionContractError('v2-unknown-target', output.table)
      if (
        input.targetRoster &&
        !input.targetRoster.some(
          (entry) =>
            entry.table === output.table &&
            entry.sources.some((table) => rule.claims.includes(table)),
        )
      )
        throw new ConversionContractError('v2-roster-target', `${rule.ref.id}/${output.table}`)
    }
  }
  for (const validator of validators) {
    checkRef(validator.ref.id, validator.ref.version)
    if (!sourceTables.has(sourceIdentity(validator.table, validator.sourcePhase)))
      throw new ConversionContractError('v2-missing-source', validator.table)
    for (const key of validator.lookups ?? []) requireLookup(lookupIdentity(key))
  }
  for (const lookup of lookups)
    for (const table of lookup.sources)
      if (!sourceTables.has(sourceIdentity(table, lookup.sourcePhase)))
        throw new ConversionContractError('v2-missing-source', table)
  const tables = [
    ...input.preflight.tables
      .filter((table) => !input.sourceScope || input.sourceScope.includes(table.table))
      .map((table) => ({ ...table, phase: 'current' as const })),
    ...(input.preUpgradePreflight?.tables ?? [])
      .filter(
        (table) =>
          !input.preflight.tables.some((current) => current.table === table.table) ||
          rules.some(
            (rule) => rule.sourcePhase === 'pre-upgrade' && rule.claims.includes(table.table),
          ),
      )
      .map((table) => ({ ...table, phase: 'pre-upgrade' as const })),
  ].sort((a, b) => sourceIdentity(a.table, a.phase).localeCompare(sourceIdentity(b.table, b.phase)))
  const blocks: ConversionBlock[] = tables
    .filter(
      (table) =>
        !claims.has(sourceIdentity(table.table, table.phase)) || table.disposition === 'blocked',
    )
    .map((table) => ({
      code:
        table.disposition === 'blocked'
          ? BLOCK_CODES.sourceUnavailable
          : BLOCK_CODES.unclaimedTable,
      scope: 'table',
      sourceTable: table.table,
      sourceKey: null,
      sourcePhase: table.phase,
      taskId: null,
      runId: null,
      missingFields: [],
      detail: { reason: table.reason, rows: table.rows },
    }))
  const ruleSetDigest = valueDigest({
    rules: rules.map(({ convert: _convert, ...rule }) => rule),
    lookups: lookups.map(({ build: _build, ...lookup }) => lookup),
    validators: validators.map(({ validate: _validate, ...validator }) => validator),
  })
  const payload = {
    version: 1 as const,
    converterVersion: CONVERTER_VERSION,
    ruleSetDigest,
    sourceFingerprint: input.preflight.fingerprint.digest,
    sourceVersion: input.preflight.sourceVersion,
    sourceGenerationId: input.preflight.sourceGenerationId,
    sourceWatermark: input.preflight.watermark,
    targetContractDigest: compileContract(input.target).digest,
    targetGeneration: input.targetGeneration,
    candidateBuild: input.candidateBuild,
    sourceBackupId: input.sourceBackupId,
    contentManifestDigest: input.contentManifestDigest,
    bootUpgradeEnvironmentDigest: (input.bootUpgradeFacts ?? createBootUpgradeFacts([]))
      .environmentDigest,
    planTime: input.planTime,
    coverage: input.sourceScope ? ('partial' as const) : ('complete' as const),
    chunkLimit,
    preUpgradeWatermark: input.preUpgradePreflight?.watermark ?? null,
    operatorDecisions,
    tables: tables.map((table) => ({
      table: table.table,
      phase: table.phase,
      rows: table.rows,
      rule: claims.get(sourceIdentity(table.table, table.phase))?.ref.id ?? null,
      targets:
        claims
          .get(sourceIdentity(table.table, table.phase))
          ?.produces.map((output) => output.table)
          .sort() ?? [],
    })),
    topology: targetTopology(input.target),
    deferredChecks: input.target.tables.flatMap((table) => [
      ...table.checks
        .filter((check) => !isTypedExpression(check.expression))
        .map((check) => ({ table: table.id, name: check.name })),
      ...table.indexes
        .filter(
          (index) =>
            index.unique &&
            (!index.columns.every(isTypedExpression) ||
              (index.where && !isTypedExpression(index.where))),
        )
        .map((index) => ({ table: table.id, name: index.name })),
    ]),
    blocks,
  }
  return { ...payload, digest: valueDigest(payload) }
}

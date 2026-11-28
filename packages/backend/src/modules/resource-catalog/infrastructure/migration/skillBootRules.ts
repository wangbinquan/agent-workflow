import {
  skillBootIdentityFacts,
  createBootUpgradeFacts,
  bootRowArchive,
  recordBootUpgradeEffect,
  blockBootRow,
  emitBootRow,
  type BootUpgradeFacts,
  type SkillBootIdentityFact,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { ConversionContractError } from '@/platform/persistence/migration/conversion/blockCodes'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { valuesByColumnName } from '@/platform/persistence/migration/conversion/generic/preserved'
import type { LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import type {
  ConversionContribution,
  ConversionRule,
  RuleContext,
  RuleOutput,
} from '@/platform/persistence/migration/conversion/rule'
import type {
  JsonValue,
  SourceRow,
  TargetRef,
  TargetRow,
} from '@/platform/persistence/migration/conversion/types'
import { DATABASE_SKILL_ROOT } from '@/platform/content/locations/skill'
import { unavailableSkillTreeColumns } from '@/platform/content/migration/skillContent'
import { recoveryDirection, type RecoveryDirection } from '../legacy/skillOpRecovery'
import type { SkillOpKind, SkillOpPhase } from '../legacy/skillOperations'
import {
  SkillBootFactSchema,
  skillBootFactId,
  verifyFrozenSkillTree,
  type FrozenSkillTree,
  type SkillBootFact,
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

/** RFC-626 §3.4 row 3a: a skill or version row kept as quarantined by the automatic upgrade. */
export const SKILL_KEPT_UNAVAILABLE = 'v2-boot-skill-kept-unavailable'
/** RFC-626 §3.4 row 3c: an operation of a disposed skill converted as no longer active. */
export const SKILL_OPERATION_KEPT_INACTIVE = 'v2-boot-skill-operation-unsettled-kept'
/**
 * Identity of a group that has operation or lock rows but neither a skill row nor version rows:
 * the audit trail of a deleted skill, or a deletion committed in the database whose tidy-up was
 * interrupted. Such rows are copied as the generic copy used to copy them.
 */
const OPERATIONS_ONLY = 'v2-boot-skill-operations-only'
const OPERATION_MEMBERS = [
  { table: 'skill_operations', column: 'skill_id' },
  { table: 'skill_operation_locks', column: 'locked_skill_id' },
] as const

/**
 * RFC-626 §3.4 row 3d (§3.6): the facts captured for the upgrade contradict the frozen rows.
 * Only a change between capture and conversion produces these; the automatic upgrade ends with
 * an error and a retry captures again.
 */
const CONTRADICTION_CODES: ReadonlySet<string> = new Set([
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
/**
 * RFC-626 §3.4 row 3b: never published (an empty husk still mentioned elsewhere, a reservation
 * that never became ready, versions without a skill row) or not decodable at all. Keeping such a
 * row would hold the name forever and it would never pass the boot check, so it is set aside.
 */
const SET_ASIDE_CODES: ReadonlySet<string> = new Set([
  'v2-boot-skill-husk-references',
  'v2-boot-skill-reservation-unsettled',
  'v2-boot-skill-orphan-version',
  'v2-boot-skill-source-codec',
])
/** RFC-626 §3.4 row 3c: an operation was interrupted when the old service stopped. */
const OPERATION_CODES: ReadonlySet<string> = new Set([
  'v2-boot-skill-operation-unsettled',
  'v2-boot-skill-operation-residue',
])

export type AutomaticSkillDisposition = 'quarantine' | 'set-aside' | 'contradiction'

/** The recovery the old boot would have run for one operation row (RFC-170 §6a). */
export function skillOperationDirection(values: {
  readonly kind?: unknown
  readonly phase?: unknown
}): RecoveryDirection {
  return recoveryDirection(String(values.kind) as SkillOpKind, String(values.phase) as SkillOpPhase)
}

export function isActiveSkillOperation(values: { readonly active?: unknown }): boolean {
  return values.active === 1 || values.active === true
}

/**
 * RFC-626 §3.4 rows 3a–3d: what the automatic upgrade does with a skill the boot facts could not
 * prove. `operations` are the skill's active operation rows. Codes no row names — a read that
 * failed for a reason nobody anticipated — keep the skill quarantined like the known ones: the
 * old boot quarantined whatever it could not verify, and the next boot verifies it again.
 */
export function automaticSkillDisposition(
  code: string,
  operations: readonly { readonly kind?: unknown; readonly phase?: unknown }[],
): AutomaticSkillDisposition {
  if (CONTRADICTION_CODES.has(code)) return 'contradiction'
  if (SET_ASIDE_CODES.has(code)) return 'set-aside'
  // A creation that never reached the database commit is undone by the old recovery: the skill
  // was never published, exactly the 3b case. Every other interruption keeps the skill.
  if (
    OPERATION_CODES.has(code) &&
    operations.some(
      (operation) =>
        operation.kind === 'reserve' && skillOperationDirection(operation) === 'rollback',
    )
  )
    return 'set-aside'
  return 'quarantine'
}

/**
 * Holds one conversion attempt's output until the attempt succeeds. When a later tree fails and
 * the automatic upgrade quarantines the skill instead, nothing from the attempt — no content
 * object, entry or receipt — stays behind. Archives are content-addressed and stored once per
 * reference, so they pass straight through.
 */
function deferredOutput(out: RuleOutput): { readonly out: RuleOutput; commit(): void } {
  const pending: (() => void)[] = []
  return {
    out: {
      row(table, values, origin) {
        pending.push(() => out.row(table, values, origin))
      },
      exception(disposition) {
        pending.push(() => out.exception(disposition))
      },
      evidence(evidence) {
        pending.push(() => out.evidence(evidence))
      },
      artifact(receipt) {
        pending.push(() => out.artifact(receipt))
      },
      archive: (payload) => out.archive(payload),
      block(block) {
        pending.push(() => out.block(block))
      },
      blockExecutable(task, block) {
        pending.push(() => out.blockExecutable(task, block))
      },
      record(record, origin) {
        pending.push(() => out.record(record, origin))
      },
    },
    commit() {
      for (const flush of pending.splice(0)) flush()
    },
  }
}

function isDatabaseSkill(
  skill: SourceRow | undefined,
  versions: readonly SourceRow[],
  fact: SkillBootFact | undefined,
  code: string,
): boolean {
  return (
    skill?.values.managed_path === DATABASE_SKILL_ROOT ||
    versions.some((row) => row.values.files_path === DATABASE_SKILL_ROOT) ||
    fact?.live?.source === 'database-bytes' ||
    (fact?.versions.some((version) => version.tree.source === 'database-bytes') ?? false) ||
    // Only database trees decode stored entries; these codes come from that decoding.
    code.startsWith('v2-skill-')
  )
}

/**
 * RFC-626 §3.4 row 3a: keep the skill and its versions as the old boot kept a skill it could not
 * verify — `version_state='quarantined'`, references naming where each tree was found (or its
 * canonical place), no content object. Every later boot verifies quarantined skills again and
 * restores one whose directory is complete.
 */
function quarantineSkill(
  ctx: RuleContext,
  input: {
    readonly id: string
    readonly skill: SourceRow
    readonly versions: readonly SourceRow[]
    readonly fact: SkillBootFact | undefined
    readonly factIds: readonly string[]
    readonly code: string
    readonly message: string | null
  },
): void {
  const { id, skill, versions, fact } = input
  const source = isDatabaseSkill(skill, versions, fact, input.code)
    ? 'database-bytes'
    : 'local-file'
  const found = (tree: FrozenSkillTree | null | undefined): string | null =>
    tree?.present && tree.source === 'local-file' ? tree.reference : null
  const keep = (
    row: SourceRow,
    column: 'managed_path' | 'files_path',
    tree: string,
    reference: string | null,
  ): void => {
    const content = unavailableSkillTreeColumns({ skillId: id, tree, source, reference })
    const values: Record<string, TargetRow[string]> = Object.fromEntries(
      Object.entries(row.values).filter(([name]) => name !== column),
    )
    if (row === skill) values.version_state = 'quarantined'
    Object.assign(values, {
      content_ref_json: content.refJson,
      content_inline_bytes: content.inline,
    })
    const targets = [{ table: row.table, key: ctx.target.key(row.table, values) }]
    const detail: Record<string, JsonValue> = {
      skillId: id,
      cause: input.code,
      tree,
      reference: content.location,
      ...(input.message === null ? {} : { message: input.message }),
    }
    ctx.out.row(row.table, values, row)
    ctx.out.exception({
      sourceTable: row.table,
      sourceKey: row.encodedKey,
      sourcePhase: row.phase,
      class: 'converted',
      kind: 'conflict-resolved',
      targets,
      archive: bootRowArchive(ctx, row),
      decision: { code: SKILL_KEPT_UNAVAILABLE, detail },
    })
    recordBootUpgradeEffect(ctx, ref, row, {
      disposition: 'transformed',
      targets,
      before: {
        skillId: id,
        reference: typeof row.values[column] === 'string' ? (row.values[column] as string) : null,
        ...(row === skill ? { versionState: String(row.values.version_state) } : {}),
      },
      after: { skillId: id, reference: content.location, quarantined: true },
      reason: SKILL_KEPT_UNAVAILABLE,
      factIds: input.factIds,
    })
    ctx.out.record(
      {
        kind: 'decision',
        code: SKILL_KEPT_UNAVAILABLE,
        payload: {
          automatic: 'kept',
          sourcePhase: row.phase,
          sourceTable: row.table,
          sourceKey: row.encodedKey,
          ...detail,
        },
      },
      row,
    )
  }
  keep(skill, 'managed_path', 'live', found(fact?.live))
  for (const row of versions)
    keep(
      row,
      'files_path',
      `version:${String(row.values.version_index)}`,
      found(fact?.versions.find((version) => version.id === row.values.id)?.tree),
    )
}

/**
 * RFC-626 §3.4 row 3c. Rows of a skill the automatic upgrade disposed of (quarantined or set
 * aside) end their operation: the operation is converted with `active=0` and its lock is set
 * aside, so the boot recovery of the new version finds no operation it would have to judge
 * against a skill that is no longer in the state the operation expects. Otherwise — and always
 * with operator resolution — both are copied as the generic copy did.
 */
function convertOperations(
  ctx: RuleContext,
  id: string,
  operations: readonly SourceRow[],
  locks: readonly SourceRow[],
  settle: boolean,
): void {
  for (const row of operations) {
    const values = valuesByColumnName(row, ctx)
    if (!settle || !isActiveSkillOperation(row.values)) {
      ctx.out.row(row.table, values, row)
      continue
    }
    const operation = {
      skillId: id,
      opId: String(row.values.op_id),
      kind: String(row.values.kind),
      phase: String(row.values.phase),
      direction: skillOperationDirection(row.values),
    }
    emitBootRow(
      ctx,
      ref,
      row,
      { ...values, active: 0 },
      {
        changed: true,
        before: { ...operation, active: 1 },
        after: { ...operation, active: 0 },
        reason: SKILL_OPERATION_KEPT_INACTIVE,
      },
    )
    ctx.out.record(
      {
        kind: 'decision',
        code: SKILL_OPERATION_KEPT_INACTIVE,
        payload: {
          automatic: 'kept',
          sourcePhase: row.phase,
          sourceTable: row.table,
          sourceKey: row.encodedKey,
          ...operation,
        },
      },
      row,
    )
  }
  for (const row of locks)
    if (!settle) ctx.out.row(row.table, valuesByColumnName(row, ctx), row)
    else
      blockBootRow(ctx, ref, row, 'v2-boot-skill-operation-unsettled', {
        skillId: id,
        opId: typeof row.values.op_id === 'string' ? row.values.op_id : null,
      })
}

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
      sources: ['skills', 'skill_versions', ...OPERATION_MEMBERS.map((member) => member.table)],
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
        // RFC-626 §3.4 row 3c: operations and locks are members of their skill's group. Rows
        // whose skill has neither a skill row nor versions get a group of their own instead of
        // an orphan block, as the generic copy carried them.
        for (const member of OPERATION_MEMBERS)
          for (const row of staged.rows(member.table)) {
            const id = row.values[member.column]
            if (typeof id !== 'string' || ids.has(id)) continue
            ids.add(id)
            put(id, { skillId: id, state: 'blocked', reason: OPERATIONS_ONLY, factIds: [] })
          }
      },
    }
    /** Converts one skill and its versions; true when the skill was not carried over as proven. */
    const convertSkill = async (
      id: string,
      skill: SourceRow | undefined,
      versions: readonly SourceRow[],
      operations: readonly SourceRow[],
      ctx: RuleContext,
    ): Promise<boolean> => {
      const automatic = ctx.resolution === 'automatic'
      const identity = ctx.lookup(skillBootIdentityFacts).require(id),
        fact = bound.get(skillBootFactId(id))
      const rows = skill ? [skill, ...versions] : versions
      if (identity.state === 'blocked' || !skill || !fact) {
        const reason = identity.reason ?? 'v2-boot-skill-fact-missing'
        if (!automatic) {
          for (const row of rows)
            blockBootRow(ctx, ref, row, reason, { skillId: id }, identity.factIds)
          return true
        }
        const active = operations.filter((row) => isActiveSkillOperation(row.values))
        const disposition = automaticSkillDisposition(
          reason,
          active.map((row) => row.values),
        )
        if (disposition === 'contradiction')
          throw new ConversionContractError(reason, `skill ${id}`)
        if (disposition === 'quarantine' && skill) {
          quarantineSkill(ctx, {
            id,
            skill,
            versions,
            fact,
            factIds: identity.factIds,
            code: reason,
            message: null,
          })
          return true
        }
        // Set aside. What stays on disk is named in the detail, so the report shows it.
        const detail: Record<string, JsonValue> = { skillId: id }
        if (reason === 'v2-boot-skill-reservation-unsettled')
          Object.assign(detail, {
            liveDirectory: fact?.live?.reference ?? null,
            roots: [...(fact?.roots ?? [])],
          })
        if (OPERATION_CODES.has(reason))
          Object.assign(detail, {
            roots: [...(fact?.roots ?? [])],
            operations: active.map((row) => ({
              opId: String(row.values.op_id),
              kind: String(row.values.kind),
              phase: String(row.values.phase),
              direction: skillOperationDirection(row.values),
            })),
          })
        for (const row of rows) blockBootRow(ctx, ref, row, reason, detail, identity.factIds)
        return true
      }
      // RFC-626: with automatic resolution a failure may still keep the skill (quarantined); the
      // attempt's output is held back until it succeeds.
      const attempt = automatic ? deferredOutput(ctx.out) : null
      const actx: RuleContext = attempt ? { ...ctx, out: attempt.out } : ctx
      try {
        if (
          fact.versions.length !== versions.length ||
          versions.some(
            (row) =>
              !fact.versions.some(
                (version) =>
                  version.id === row.values.id && version.sourceDigest === valueDigest(row.values),
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
          actx.out.exception({
            sourceTable: skill.table,
            sourceKey: skill.encodedKey,
            sourcePhase: skill.phase,
            class: 'archived',
            kind: 'archived',
            targets: [],
            archive: bootRowArchive(actx, skill),
            decision: {
              code: 'v2-boot-skill-empty-husk',
              detail: {
                skillId: id,
                roots: fact.roots,
              },
            },
          })
          recordBootUpgradeEffect(
            { ...actx, out: { ...actx.out, record: (record) => actx.out.record(record) } },
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
        } else {
          if (!fact.live) throw new Error('v2-boot-skill-live-unproven')
          const nextSkill: Record<string, TargetRow[string]> = Object.fromEntries(
            Object.entries(skill.values).filter(([name]) => name !== 'managed_path'),
          )
          if (fact.initialVersion)
            Object.assign(nextSkill, {
              content_version: 1,
              version_state: 'snapshot-authoritative',
              updated_at: actx.planTime,
            })
          const skillTarget = { table: 'skills', key: actx.target.key('skills', nextSkill) }
          const content = await convertContent(
            {
              skillId: id,
              tree: 'live',
              source: skill,
              target: skillTarget,
              snapshot: fact.live,
            },
            actx,
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
              key: actx.target.key('skill_versions', values),
            }
            const content = await convertContent(
              {
                skillId: id,
                tree: `version:${version.version}`,
                source: row,
                target,
                snapshot: version.tree,
              },
              actx,
            )
            Object.assign(values, {
              content_ref_json: content.refJson,
              content_inline_bytes: content.inline,
            })
            outputs.push({ table: 'skill_versions', values, origin: row })
          }
          let initial: { id: string; version: number; hash: string } | null = null
          if (fact.initialVersion) {
            const versionId = actx.ids.child('boot-skill-initial-version@1', skill.encodedKey, 1)
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
              created_at: actx.planTime,
            }
            const target = {
              table: 'skill_versions',
              key: actx.target.key('skill_versions', values),
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
              actx,
            )
            Object.assign(values, {
              content_ref_json: content.refJson,
              content_inline_bytes: content.inline,
            })
            outputs.push({ table: 'skill_versions', values, origin: skill })
            targets.push(target)
            initial = { id: versionId, version: 1, hash: fact.live.contentHash }
          }
          for (const output of outputs) actx.out.row(output.table, output.values, output.origin)
          for (const row of rows) {
            const rowTargets =
              row === skill
                ? targets
                : outputs
                    .filter((output) => output.origin === row)
                    .map((output) => ({
                      table: output.table,
                      key: actx.target.key(output.table, output.values),
                    }))
            actx.out.exception({
              sourceTable: row.table,
              sourceKey: row.encodedKey,
              sourcePhase: row.phase,
              class: 'converted',
              kind: row === skill && initial ? 'derived-id' : 'conflict-resolved',
              targets: rowTargets,
              archive: bootRowArchive(actx, row),
              decision: {
                code: 'v2-boot-skill-content-proven',
                detail: { skillId: id, initial },
              },
            })
            recordBootUpgradeEffect(actx, ref, row, {
              disposition: 'transformed',
              targets: rowTargets,
              before: {
                skillId: id,
                reference:
                  row === skill
                    ? fact.live.reference
                    : fact.versions.find((version) => version.id === row.values.id)!.tree.reference,
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
        }
      } catch (error) {
        if (!automatic) {
          for (const row of rows)
            blockBootRow(
              ctx,
              ref,
              row,
              error instanceof Error ? error.message : 'v2-boot-skill-conversion-unproven',
              { skillId: id },
              identity.factIds,
            )
          return true
        }
        // RFC-626 (CONVERSION-RULES "catch-all"): an engine contract error stays an error, a
        // contradiction of the captured facts ends the upgrade with an error, anything else —
        // a known data state or a read failure nobody named — keeps the skill quarantined.
        if (error instanceof ConversionContractError) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (CONTRADICTION_CODES.has(message))
          throw new ConversionContractError(message, `skill ${id}`)
        quarantineSkill(ctx, {
          id,
          skill,
          versions,
          fact,
          factIds: identity.factIds,
          code: /^v2-[a-z0-9-]+$/.test(message) ? message : 'v2-boot-skill-conversion-unproven',
          message,
        })
        return true
      }
      attempt?.commit()
      return false
    }
    const rule: ConversionRule = {
      ref,
      owner: 'resource-catalog',
      claims: ['skills', 'skill_versions', ...OPERATION_MEMBERS.map((member) => member.table)],
      // The operation records were copied as they are before they became members of this
      // group; their rows keep that class (the independent mapping oracle says `preserved`).
      preservedClaims: OPERATION_MEMBERS.map((member) => member.table),
      produces: [
        { table: 'skills' },
        { table: 'skill_versions' },
        { table: 'content_objects' },
        { table: 'content_bytes' },
        { table: 'skill_content_entries' },
        ...OPERATION_MEMBERS.map((member) => ({ table: member.table })),
      ],
      lookups: [skillBootIdentityFacts],
      unit: {
        kind: 'group',
        driver: skillBootIdentityFacts,
        groupColumn: 'id',
        members: [
          { table: 'skills', column: 'id' },
          { table: 'skill_versions', column: 'skill_id' },
          ...OPERATION_MEMBERS,
        ],
        groupsPerUnit: 1,
      },
      async convert(unit, ctx) {
        const automatic = ctx.resolution === 'automatic'
        const allRows = [...unit.rows.values()].flat()
        for (const id of unit.groupKeys ?? []) {
          const skill = unit.rows.get('skills')?.find((row) => row.values.id === id)
          const versions =
            unit.rows.get('skill_versions')?.filter((row) => row.values.skill_id === id) ?? []
          const operations =
            unit.rows.get('skill_operations')?.filter((row) => row.values.skill_id === id) ?? []
          const locks =
            unit.rows
              .get('skill_operation_locks')
              ?.filter((row) => row.values.locked_skill_id === id) ?? []
          // A group of operation rows alone has no skill to dispose of; with automatic resolution
          // its operations still end, so the new boot recovery never judges them (RFC-626 §3.3
          // "the upgraded service must start").
          const disposed =
            skill || versions.length
              ? await convertSkill(id, skill, versions, operations, ctx)
              : automatic
          convertOperations(ctx, id, operations, locks, automatic && disposed)
        }
        if (!unit.groupKeys?.length && allRows.length) {
          if (automatic)
            throw new ConversionContractError(
              'v2-boot-skill-group-unproven',
              `${allRows.length} rows without a group`,
            )
          for (const row of allRows)
            blockBootRow(ctx, ref, row, 'v2-boot-skill-group-unproven', null)
        }
      },
    }
    return { rules: [rule], lookups: [identities], validators: [] }
  }
  return { ...bind(createBootUpgradeFacts([])), withBootUpgrade: bind }
}

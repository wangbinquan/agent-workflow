import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type {
  IntentResourceChangesetReceipt,
  VersionedIntentResourceChangesetPlan,
} from '../../public/types'
import type { ResourceRequestContext } from '../../public/participants'
import { CATALOG_SELECTOR_KINDS, type CatalogSelectorKind } from '../../domain/resourceKinds'
import type { ResourceCatalogAclIdentityReadPort } from '../../application/ports/providerResourceCatalogPersistence'
import type { PostgresqlResourceCatalogTransaction } from '../postgresql/repositorySupport'

type PlanOf<K extends CatalogSelectorKind> = Extract<
  VersionedIntentResourceChangesetPlan,
  { readonly kind: K }
>
type ReceiptOf<K extends CatalogSelectorKind> = Extract<
  IntentResourceChangesetReceipt,
  { readonly kind: K }
>

export interface PostgresqlIntentApplyPrepareContext {
  readonly pendingIds: ReadonlySet<string>
  readonly pendingAgentNames: ReadonlyMap<string, string>
  readonly clientMutationId: string
}

export type PostgresqlIntentApplyArtifact =
  | Readonly<{
      readonly kind: 'plugin-install'
      readonly pluginId: string
      readonly generationId: string
      readonly generationDir: string
    }>
  | Readonly<{
      readonly kind: 'skill-stage'
      readonly skillId: string
      readonly operationId: string
      readonly stagingDirectory: string
    }>
  | Readonly<{
      readonly kind: 'skill-version-stage'
      readonly skillId: string
      readonly operationId: string
      readonly version: number
      readonly stagingDirectory: string
      readonly versionDirectory: string
    }>

export interface PostgresqlIntentApplyPrestageContext {
  recordArtifact(artifact: PostgresqlIntentApplyArtifact): Promise<void>
}

export interface PostgresqlIntentApplyCommitContext {
  readonly bundleCreatedNames: Readonly<{
    readonly workflow: ReadonlySet<string>
    readonly workgroup: ReadonlySet<string>
  }>
}

/**
 * One provider-private aggregate arm. Preparation and filesystem/plugin
 * staging happen before the owning Intent transaction; commit receives the
 * exact reserved PostgreSQL transaction and cannot open a shadow transaction.
 */
export interface PostgresqlIntentApplyMutationPort<
  K extends CatalogSelectorKind,
  TPrepared extends object,
> {
  prepare(plan: PlanOf<K>, context: PostgresqlIntentApplyPrepareContext): Promise<TPrepared>
  prestage?(
    plan: PlanOf<K>,
    prepared: TPrepared,
    context: PostgresqlIntentApplyPrestageContext,
  ): Promise<void>
  commitInTransaction(input: {
    readonly transaction: PostgresqlResourceCatalogTransaction
    readonly authority: ResourceRequestContext
    readonly plan: PlanOf<K>
    readonly prepared: TPrepared
    readonly context: PostgresqlIntentApplyCommitContext
  }): Promise<ReceiptOf<K>>
  afterCommitted?(input: {
    readonly plan: PlanOf<K>
    readonly prepared: TPrepared
    readonly receipt: ReceiptOf<K>
  }): Promise<void> | void
  rollForwardCommitted?(input: {
    readonly plan: PlanOf<K>
    readonly prepared: TPrepared
    readonly receipt: ReceiptOf<K>
  }): Promise<void> | void
  abortPrepared?(input: {
    readonly plan: PlanOf<K>
    readonly prepared: TPrepared
    /** True means the database receipt is durable, so only roll-forward is legal. */
    readonly databaseCommitted: boolean
  }): Promise<void> | void
}

export interface PostgresqlIntentApplyResourcePorts<
  TAgent extends object,
  TSkill extends object,
  TMcp extends object,
  TPlugin extends object,
  TWorkflow extends object,
  TWorkgroup extends object,
> {
  readonly agent: PostgresqlIntentApplyMutationPort<'agent', TAgent>
  readonly skill: PostgresqlIntentApplyMutationPort<'skill', TSkill>
  readonly mcp: PostgresqlIntentApplyMutationPort<'mcp', TMcp>
  readonly plugin: PostgresqlIntentApplyMutationPort<'plugin', TPlugin>
  readonly workflow: PostgresqlIntentApplyMutationPort<'workflow', TWorkflow>
  readonly workgroup: PostgresqlIntentApplyMutationPort<'workgroup', TWorkgroup>
}

export interface PostgresqlIntentApplyResourceParticipantInTransaction {
  authorizeAndCommit(
    authority: ResourceRequestContext,
    plan: VersionedIntentResourceChangesetPlan,
  ): Promise<IntentResourceChangesetReceipt>
}

export interface PostgresqlIntentApplyResourceTransactionAttempt {
  readonly participant: PostgresqlIntentApplyResourceParticipantInTransaction
  /** Promote this attempt's tail only after the outer Intent transaction commits. */
  commitSucceeded(): void
}

export interface PostgresqlIntentApplyResourceSession {
  preflight(
    manifest: readonly PostgresqlIntentApplyManifestEntry[],
    changeset: PostgresqlIntentApplyChangeset,
  ): Promise<PostgresqlIntentApplyResourcePreflight>
  prepare(
    plan: VersionedIntentResourceChangesetPlan,
    context: PostgresqlIntentApplyPrepareContext,
  ): Promise<void>
  prestage(
    plan: VersionedIntentResourceChangesetPlan,
    context: PostgresqlIntentApplyPrestageContext,
  ): Promise<void>
  createTransactionAttempt(
    transaction: PostgresqlResourceCatalogTransaction,
    context: PostgresqlIntentApplyCommitContext,
  ): PostgresqlIntentApplyResourceTransactionAttempt
  rollForwardCommitted(): Promise<void>
  broadcastCommitted(): Promise<void>
  abortPrepared(input: { readonly databaseCommitted: boolean }): Promise<void>
}

export interface PostgresqlIntentApplyResourceSessionOptions {
  readonly actor: DirectAuthenticatedAuthority
  readonly authority: ResourceRequestContext
}

export interface PostgresqlIntentApplyManifestEntry {
  readonly handle: string
  readonly resourceType: string
  readonly resourceId: string
}

export interface PostgresqlIntentApplyChangeset {
  readonly ops: ReadonlyArray<{
    readonly action: string
    readonly resourceType: string
    readonly target?: string
  }>
}

export interface PostgresqlIntentApplyResourcePreflight {
  readonly occupiedNames: ReadonlyMap<CatalogSelectorKind, ReadonlySet<string>>
  readonly copyOnlyTargets: ReadonlyMap<string, string>
}

function isCatalogSelectorKind(value: string): value is CatalogSelectorKind {
  return CATALOG_SELECTOR_KINDS.some((kind) => kind === value)
}

async function resolvePostgresqlIntentApplyResourcePreflight(
  identities: ResourceCatalogAclIdentityReadPort,
  ownerUserId: string,
  manifest: readonly PostgresqlIntentApplyManifestEntry[],
  changeset: PostgresqlIntentApplyChangeset,
): Promise<PostgresqlIntentApplyResourcePreflight> {
  const occupiedNames = new Map<CatalogSelectorKind, ReadonlySet<string>>()
  for (const type of CATALOG_SELECTOR_KINDS) {
    const names = await identities.listOwnedNames(type, ownerUserId)
    occupiedNames.set(type, new Set(names.map((name) => name.toLowerCase())))
  }

  const copyOnlyTargets = new Map<string, string>()
  const byHandle = new Map(manifest.map((entry) => [entry.handle, entry] as const))
  for (const op of changeset.ops) {
    if (op.action !== 'update' || op.target === undefined) continue
    const entry = byHandle.get(op.target)
    if (entry === undefined || !isCatalogSelectorKind(entry.resourceType)) continue
    const resourceOwnerUserId = await identities.getOwner(entry.resourceType, entry.resourceId)
    if (resourceOwnerUserId !== undefined && resourceOwnerUserId !== ownerUserId) {
      copyOnlyTargets.set(op.target, 'owned by another user or built-in')
    }
  }
  return Object.freeze({ occupiedNames, copyOnlyTargets })
}

function missingPreparation(plan: VersionedIntentResourceChangesetPlan): Error {
  return new Error(`postgresql-intent-resource-not-prepared:${plan.kind}:${plan.operationId}`)
}

/**
 * Bind six exact Resource Catalog mutation arms to one Intent apply session.
 * The maps are deliberately per-session and keyed by the exact frozen plan
 * object, so a structurally identical plan from another request cannot reuse a
 * prepared filesystem/plugin capability.
 */
export function createPostgresqlIntentApplyResourceSession<
  TAgent extends object,
  TSkill extends object,
  TMcp extends object,
  TPlugin extends object,
  TWorkflow extends object,
  TWorkgroup extends object,
>(
  options: PostgresqlIntentApplyResourceSessionOptions,
  identities: ResourceCatalogAclIdentityReadPort,
  ports: PostgresqlIntentApplyResourcePorts<TAgent, TSkill, TMcp, TPlugin, TWorkflow, TWorkgroup>,
): PostgresqlIntentApplyResourceSession {
  const agent = new WeakMap<PlanOf<'agent'>, TAgent>()
  const skill = new WeakMap<PlanOf<'skill'>, TSkill>()
  const mcp = new WeakMap<PlanOf<'mcp'>, TMcp>()
  const plugin = new WeakMap<PlanOf<'plugin'>, TPlugin>()
  const workflow = new WeakMap<PlanOf<'workflow'>, TWorkflow>()
  const workgroup = new WeakMap<PlanOf<'workgroup'>, TWorkgroup>()

  const abortPreparedTail: Array<(databaseCommitted: boolean) => Promise<void>> = []
  const committedRollForwardTail: Array<() => Promise<void>> = []
  const committedAfterTail: Array<() => Promise<void>> = []

  const session: PostgresqlIntentApplyResourceSession = {
    preflight(manifest, changeset) {
      return resolvePostgresqlIntentApplyResourcePreflight(
        identities,
        options.actor.user.id,
        manifest,
        changeset,
      )
    },
    async prepare(plan, context) {
      switch (plan.kind) {
        case 'agent':
          agent.set(plan, await ports.agent.prepare(plan, context))
          abortPreparedTail.push(async (databaseCommitted) => {
            const prepared = agent.get(plan)
            if (prepared !== undefined) {
              await ports.agent.abortPrepared?.({ plan, prepared, databaseCommitted })
            }
          })
          return
        case 'skill':
          skill.set(plan, await ports.skill.prepare(plan, context))
          abortPreparedTail.push(async (databaseCommitted) => {
            const prepared = skill.get(plan)
            if (prepared !== undefined) {
              await ports.skill.abortPrepared?.({ plan, prepared, databaseCommitted })
            }
          })
          return
        case 'mcp':
          mcp.set(plan, await ports.mcp.prepare(plan, context))
          abortPreparedTail.push(async (databaseCommitted) => {
            const prepared = mcp.get(plan)
            if (prepared !== undefined) {
              await ports.mcp.abortPrepared?.({ plan, prepared, databaseCommitted })
            }
          })
          return
        case 'plugin':
          plugin.set(plan, await ports.plugin.prepare(plan, context))
          abortPreparedTail.push(async (databaseCommitted) => {
            const prepared = plugin.get(plan)
            if (prepared !== undefined) {
              await ports.plugin.abortPrepared?.({ plan, prepared, databaseCommitted })
            }
          })
          return
        case 'workflow':
          workflow.set(plan, await ports.workflow.prepare(plan, context))
          abortPreparedTail.push(async (databaseCommitted) => {
            const prepared = workflow.get(plan)
            if (prepared !== undefined) {
              await ports.workflow.abortPrepared?.({ plan, prepared, databaseCommitted })
            }
          })
          return
        case 'workgroup':
          workgroup.set(plan, await ports.workgroup.prepare(plan, context))
          abortPreparedTail.push(async (databaseCommitted) => {
            const prepared = workgroup.get(plan)
            if (prepared !== undefined) {
              await ports.workgroup.abortPrepared?.({ plan, prepared, databaseCommitted })
            }
          })
      }
    },
    async prestage(plan, context) {
      switch (plan.kind) {
        case 'agent': {
          const prepared = agent.get(plan)
          if (prepared === undefined) throw missingPreparation(plan)
          await ports.agent.prestage?.(plan, prepared, context)
          return
        }
        case 'skill': {
          const prepared = skill.get(plan)
          if (prepared === undefined) throw missingPreparation(plan)
          await ports.skill.prestage?.(plan, prepared, context)
          return
        }
        case 'mcp': {
          const prepared = mcp.get(plan)
          if (prepared === undefined) throw missingPreparation(plan)
          await ports.mcp.prestage?.(plan, prepared, context)
          return
        }
        case 'plugin': {
          const prepared = plugin.get(plan)
          if (prepared === undefined) throw missingPreparation(plan)
          await ports.plugin.prestage?.(plan, prepared, context)
          return
        }
        case 'workflow': {
          const prepared = workflow.get(plan)
          if (prepared === undefined) throw missingPreparation(plan)
          await ports.workflow.prestage?.(plan, prepared, context)
          return
        }
        case 'workgroup': {
          const prepared = workgroup.get(plan)
          if (prepared === undefined) throw missingPreparation(plan)
          await ports.workgroup.prestage?.(plan, prepared, context)
        }
      }
    },
    createTransactionAttempt(
      transaction: PostgresqlResourceCatalogTransaction,
      context: PostgresqlIntentApplyCommitContext,
    ): PostgresqlIntentApplyResourceTransactionAttempt {
      const attemptTail: Array<() => Promise<void>> = []
      const attemptRollForwardTail: Array<() => Promise<void>> = []
      let promoted = false
      const participant: PostgresqlIntentApplyResourceParticipantInTransaction = Object.freeze({
        async authorizeAndCommit(
          authority: ResourceRequestContext,
          plan: VersionedIntentResourceChangesetPlan,
        ): Promise<IntentResourceChangesetReceipt> {
          if (authority !== options.authority) {
            throw new Error('foreign-postgresql-intent-apply-authority')
          }
          switch (plan.kind) {
            case 'agent': {
              const prepared = agent.get(plan)
              if (prepared === undefined) throw missingPreparation(plan)
              const receipt = await ports.agent.commitInTransaction({
                transaction,
                authority,
                plan,
                prepared,
                context,
              })
              attemptTail.push(async () => {
                await ports.agent.afterCommitted?.({ plan, prepared, receipt })
              })
              attemptRollForwardTail.push(async () => {
                await ports.agent.rollForwardCommitted?.({ plan, prepared, receipt })
              })
              return receipt
            }
            case 'skill': {
              const prepared = skill.get(plan)
              if (prepared === undefined) throw missingPreparation(plan)
              const receipt = await ports.skill.commitInTransaction({
                transaction,
                authority,
                plan,
                prepared,
                context,
              })
              attemptTail.push(async () => {
                await ports.skill.afterCommitted?.({ plan, prepared, receipt })
              })
              attemptRollForwardTail.push(async () => {
                await ports.skill.rollForwardCommitted?.({ plan, prepared, receipt })
              })
              return receipt
            }
            case 'mcp': {
              const prepared = mcp.get(plan)
              if (prepared === undefined) throw missingPreparation(plan)
              const receipt = await ports.mcp.commitInTransaction({
                transaction,
                authority,
                plan,
                prepared,
                context,
              })
              attemptTail.push(async () => {
                await ports.mcp.afterCommitted?.({ plan, prepared, receipt })
              })
              attemptRollForwardTail.push(async () => {
                await ports.mcp.rollForwardCommitted?.({ plan, prepared, receipt })
              })
              return receipt
            }
            case 'plugin': {
              const prepared = plugin.get(plan)
              if (prepared === undefined) throw missingPreparation(plan)
              const receipt = await ports.plugin.commitInTransaction({
                transaction,
                authority,
                plan,
                prepared,
                context,
              })
              attemptTail.push(async () => {
                await ports.plugin.afterCommitted?.({ plan, prepared, receipt })
              })
              attemptRollForwardTail.push(async () => {
                await ports.plugin.rollForwardCommitted?.({ plan, prepared, receipt })
              })
              return receipt
            }
            case 'workflow': {
              const prepared = workflow.get(plan)
              if (prepared === undefined) throw missingPreparation(plan)
              const receipt = await ports.workflow.commitInTransaction({
                transaction,
                authority,
                plan,
                prepared,
                context,
              })
              attemptTail.push(async () => {
                await ports.workflow.afterCommitted?.({ plan, prepared, receipt })
              })
              attemptRollForwardTail.push(async () => {
                await ports.workflow.rollForwardCommitted?.({ plan, prepared, receipt })
              })
              return receipt
            }
            case 'workgroup': {
              const prepared = workgroup.get(plan)
              if (prepared === undefined) throw missingPreparation(plan)
              const receipt = await ports.workgroup.commitInTransaction({
                transaction,
                authority,
                plan,
                prepared,
                context,
              })
              attemptTail.push(async () => {
                await ports.workgroup.afterCommitted?.({ plan, prepared, receipt })
              })
              attemptRollForwardTail.push(async () => {
                await ports.workgroup.rollForwardCommitted?.({ plan, prepared, receipt })
              })
              return receipt
            }
          }
        },
      })
      return Object.freeze({
        participant,
        commitSucceeded() {
          if (promoted) throw new Error('postgresql-intent-resource-attempt-already-promoted')
          promoted = true
          committedRollForwardTail.push(...attemptRollForwardTail)
          committedAfterTail.push(...attemptTail)
        },
      })
    },
    async rollForwardCommitted() {
      while (committedRollForwardTail.length > 0) {
        const rollForward = committedRollForwardTail[0]
        if (rollForward === undefined) return
        await rollForward()
        committedRollForwardTail.shift()
      }
    },
    async broadcastCommitted() {
      while (committedAfterTail.length > 0) {
        const publish = committedAfterTail[0]
        if (publish === undefined) return
        await publish()
        committedAfterTail.shift()
      }
    },
    async abortPrepared({ databaseCommitted }) {
      const failures: unknown[] = []
      for (const abort of [...abortPreparedTail].reverse()) {
        try {
          await abort(databaseCommitted)
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'postgresql-intent-resource-abort-failed')
      }
    },
  }
  return Object.freeze(session)
}

import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import {
  decodeBundleIdentityRef,
  type BundleOp,
  type BundleResourceType,
} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { z } from 'zod'

import type { SecretBox } from '@/auth/secretBox'
import type { Actor } from '@/auth/actor'
import type { PostgresqlResourcePackageMutationSessionFactory } from './aggregateAdapters/postgresqlResourcePackageMutationParticipants'
import type {
  ResourcePackageImportDecision,
  ResourcePackageHumanMemberMapping,
  ResourcePackageSecretInput,
} from '../application/package/ports'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type {
  PreparedPackageMutation,
  ResourcePackageMutationReceipt,
} from '@/modules/resource-catalog/public/types'
import { preparedPackageMutation } from '@/modules/resource-catalog/public/types'
import type { ResourcePackageApplyActivityQuery } from '@/modules/resource-catalog/public/queries'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createAtomicApplyLock } from '@/platform/atomic-apply/keyedLock'
import {
  resourcePackageApplyErrors,
  resourcePackageApplyErrorText as errorText,
} from './resourcePackageApplyErrors'
import { createAtomicApply } from '@/platform/atomic-apply/stateMachine'
import { createResourcePackageAtomicJournal } from './resourcePackageAtomicJournal'
import {
  resourcePackageArtifactCodecs,
  decodeResourcePackageReceiptJson,
} from './resourcePackageArtifactCodec'
import { ResourcePackageReceiptSchema as ReceiptSchema } from './resourcePackageCurrentCodec'
import {
  assertActionsAllowed,
  humanMemberKey,
  materializedSecretProjections,
  materializedWorkgroupSlugs,
  translateDecisions,
  translatedBundle,
  typeOfSlug,
} from '@/services/resourcePackage/commit'
import type { ParsedPackage } from '@/services/resourcePackage/parse'
import { applyPackageSecretInputs } from '@/services/resourcePackage/secretInputs'
import {
  normalizeHumanMemberBaseline,
  verifyPreviewToken,
  type HumanMemberBaselineEntry,
} from '@/services/resourcePackage/preview'
import { ConflictError, ValidationError } from '@/util/errors'
import { createLogger, type Logger } from '@/util/log'
import { opSlug, planBundleOps, resourceTypeOfOp } from '@/services/bundle/provider'

type PostgresqlResourcePackageMutationSession = ReturnType<
  PostgresqlResourcePackageMutationSessionFactory['create']
>
type PostgresqlResourcePackageTransactionSession = ReturnType<
  PostgresqlResourcePackageMutationSession['bindTransaction']
>
type PostgresqlResourcePackageTransactionReader =
  PostgresqlResourcePackageTransactionSession['reader']
type PostgresqlResourcePackageSelectedResource = Parameters<
  PostgresqlResourcePackageTransactionReader['assertSelected']
>[0]
type PostgresqlResourcePackageSelectionFence = PostgresqlResourcePackageSelectedResource['fence']
type PostgresqlResourcePackageMutationArtifact = Parameters<
  PostgresqlResourcePackageMutationSession['compensate']
>[0]['artifacts'][number]
type PostgresqlResourcePackageApplyReceipt = Parameters<
  PostgresqlResourcePackageMutationSession['afterCommitted']
>[0]

interface ResourcePackageAtomicApplyInput<TPackage> {
  readonly authority: ResourceRequestContext
  readonly actor: Actor
  readonly package: TPackage
  readonly previewToken: string
  readonly decisions: readonly ResourcePackageImportDecision[]
  readonly humanMemberMappings: readonly ResourcePackageHumanMemberMapping[]
  readonly secretInputs: readonly ResourcePackageSecretInput[]
  readonly mutationSessionFactory: PostgresqlResourcePackageMutationSessionFactory
}

interface ResourcePackageAtomicApplyOrchestrator<TPackage> {
  apply(
    input: ResourcePackageAtomicApplyInput<TPackage>,
  ): Promise<PostgresqlResourcePackageApplyReceipt>
}

const PACKAGE_IDEMPOTENCY_SCOPE = 'package'

const ExpectedObjectSchema = z.record(z.unknown())

export interface ResourcePackageAtomicApplyDependencies {
  readonly db: PersistenceDb
  readonly box: SecretBox
  readonly id?: () => string
  readonly now?: () => number
  readonly log?: Logger
}

export interface ResourcePackageAtomicApplyOperations
  extends
    ResourcePackageAtomicApplyOrchestrator<ParsedPackage>,
    ResourcePackageApplyActivityQuery {}

interface HumanMappingPlan {
  readonly activeUserIds: readonly string[]
}

interface PreparedOperations {
  readonly items: readonly PreparedPackageMutation[]
}

function validateHumanMappings(
  baseline: readonly HumanMemberBaselineEntry[],
  materializedWorkgroups: ReadonlySet<string>,
  mappings: readonly {
    readonly workgroupSlug: string
    readonly username: string
    readonly userId?: string | null
  }[],
): HumanMappingPlan {
  const confirmed = new Map(
    normalizeHumanMemberBaseline(baseline).map((slot) => [
      humanMemberKey(slot.workgroupSlug, slot.username),
      slot,
    ]),
  )
  const wanted = new Map(
    [...confirmed].filter(([, slot]) => materializedWorkgroups.has(slot.workgroupSlug)),
  )
  const given = new Map<string, (typeof mappings)[number]>()
  for (const mapping of mappings) {
    const key = humanMemberKey(mapping.workgroupSlug, mapping.username)
    if (!confirmed.has(key)) {
      throw new ValidationError(
        'package-human-mapping-unconfirmed',
        `member '${mapping.username}' of '${mapping.workgroupSlug}' was not part of the confirmed preview`,
      )
    }
    if (!materializedWorkgroups.has(mapping.workgroupSlug)) continue
    if (given.has(key)) {
      throw new ValidationError(
        'package-human-mapping-duplicate',
        `member '${mapping.username}' of '${mapping.workgroupSlug}' has more than one mapping`,
      )
    }
    given.set(key, mapping)
  }

  const activeUserIds = new Set<string>()
  for (const [key, slot] of wanted) {
    const mapping = given.get(key)
    if (mapping === undefined) {
      throw new ValidationError(
        'package-human-mapping-missing',
        `no mapping for member '${slot.username}' of '${slot.workgroupSlug}'`,
      )
    }
    const userId = mapping.userId ?? null
    if (userId === null) {
      if (slot.required) {
        throw new ValidationError(
          'package-human-mapping-required',
          `member '${slot.username}' of '${slot.workgroupSlug}' was confirmed as required and cannot be skipped`,
        )
      }
      continue
    }
    activeUserIds.add(userId)
  }
  return Object.freeze({ activeUserIds: Object.freeze([...activeUserIds]) })
}

function expectedObject(value: unknown, localSlug: string): Readonly<Record<string, unknown>> {
  const parsed = ExpectedObjectSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError(
      'package-preview-token-invalid',
      `confirmed revision fence for '${localSlug}' has an invalid shape`,
    )
  }
  return parsed.data
}

function expectedNumber(
  expected: Readonly<Record<string, unknown>>,
  field: string,
  localSlug: string,
): number {
  const value = expected[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(
      'package-preview-token-invalid',
      `confirmed revision fence '${field}' for '${localSlug}' is invalid`,
    )
  }
  return value
}

function expectedString(
  expected: Readonly<Record<string, unknown>>,
  field: string,
  localSlug: string,
): string {
  const value = expected[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(
      'package-preview-token-invalid',
      `confirmed revision fence '${field}' for '${localSlug}' is invalid`,
    )
  }
  return value
}

function selectionFence(
  type: BundleResourceType,
  expectedValue: unknown,
  localSlug: string,
): PostgresqlResourcePackageSelectionFence {
  const expected = expectedObject(expectedValue, localSlug)
  switch (type) {
    case 'agent':
      return Object.freeze({
        kind: 'agent-revision',
        expectedUpdatedAt: expectedNumber(expected, 'expectedUpdatedAt', localSlug),
        expectedAclRevision: expectedNumber(expected, 'expectedAclRevision', localSlug),
      })
    case 'skill':
      return Object.freeze({
        kind: 'skill-revision',
        expectedContentVersion: expectedNumber(expected, 'expectedContentVersion', localSlug),
        expectedMetaRevision: expectedNumber(expected, 'expectedMetaRevision', localSlug),
        expectedAclRevision: expectedNumber(expected, 'expectedAclRevision', localSlug),
      })
    case 'mcp':
      return Object.freeze({
        kind: 'mcp-config',
        expectedConfigHash: expectedString(expected, 'expectedConfigHash', localSlug),
      })
    case 'plugin':
      return Object.freeze({
        kind: 'plugin-config',
        expectedConfigHash: expectedString(expected, 'expectedConfigHash', localSlug),
      })
    case 'workflow':
      return Object.freeze({
        kind: 'workflow-version',
        expectedVersion: expectedNumber(expected, 'expectedVersion', localSlug),
      })
    case 'workgroup':
      return Object.freeze({
        kind: 'workgroup-version',
        expectedVersion: expectedNumber(expected, 'expectedVersion', localSlug),
      })
    case 'capability_template':
      return Object.freeze({
        kind: 'capability-template-revision',
        expectedUpdatedAt: expectedNumber(expected, 'expectedUpdatedAt', localSlug),
        expectedAclRevision: expectedNumber(expected, 'expectedAclRevision', localSlug),
      })
  }
}

function selectedResource(
  type: BundleResourceType,
  action: 'reuse' | 'overwrite',
  id: string,
  fence: PostgresqlResourcePackageSelectionFence,
): PostgresqlResourcePackageSelectedResource {
  switch (type) {
    case 'agent':
      if (fence.kind !== 'agent-revision') break
      return Object.freeze({ type, action, id, fence })
    case 'skill':
      if (fence.kind !== 'skill-revision') break
      return Object.freeze({ type, action, id, fence })
    case 'mcp':
      if (fence.kind !== 'mcp-config') break
      return Object.freeze({ type, action, id, fence })
    case 'plugin':
      if (fence.kind !== 'plugin-config') break
      return Object.freeze({ type, action, id, fence })
    case 'workflow':
      if (fence.kind !== 'workflow-version') break
      return Object.freeze({ type, action, id, fence })
    case 'workgroup':
      if (fence.kind !== 'workgroup-version') break
      return Object.freeze({ type, action, id, fence })
    case 'capability_template':
      if (fence.kind !== 'capability-template-revision') break
      return Object.freeze({ type, action, id, fence })
  }
  throw new Error(`resource-package-selection-fence-kind-mismatch:${type}:${fence.kind}`)
}

async function assertSelectedResources(
  reader: PostgresqlResourcePackageTransactionReader,
  pkg: ParsedPackage,
  decisions: ResourcePackageAtomicApplyInput<ParsedPackage>['decisions'],
  baseline: ReadonlyMap<string, { readonly expectByCandidateId: Record<string, unknown> }>,
): Promise<Map<string, Awaited<ReturnType<typeof reader.assertSelected>>>> {
  const selected = new Map<string, Awaited<ReturnType<typeof reader.assertSelected>>>()
  for (const decision of decisions) {
    if (decision.action !== 'reuse' && decision.action !== 'overwrite') continue
    const resourceType = typeOfSlug(pkg, decision.localSlug)
    const resourceId = decision.targetId
    if (resourceType === null || resourceId === undefined) {
      throw new ValidationError(
        'package-decision-invalid',
        `decision for '${decision.localSlug}' has no selected target`,
      )
    }
    const expected = baseline.get(decision.localSlug)?.expectByCandidateId[resourceId]
    if (expected === undefined) {
      throw new ValidationError(
        'package-decision-unconfirmed',
        `target '${resourceId}' for '${decision.localSlug}' was not part of the confirmed preview`,
      )
    }
    const resource = await reader.assertSelected(
      selectedResource(
        resourceType,
        decision.action,
        resourceId,
        selectionFence(resourceType, expected, decision.localSlug),
      ),
    )
    selected.set(decision.localSlug, resource)
  }
  return selected
}

interface ReferencedResource {
  readonly type: BundleResourceType
  readonly ref: string
}

function collectReferencedResources(
  operations: readonly BundleOp[],
): readonly ReferencedResource[] {
  const out = new Map<string, ReferencedResource>()
  const take = (type: BundleResourceType, value: unknown): void => {
    if (typeof value !== 'string') return
    const decoded = decodeBundleIdentityRef(value)
    if (decoded === null || (decoded.k !== 'external' && decoded.k !== 'builtin')) return
    out.set(`${type}\u0000${value}`, Object.freeze({ type, ref: value }))
  }
  const takeAll = (type: BundleResourceType, value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const ref of value) take(type, ref)
  }

  for (const operation of operations) {
    if ('target' in operation) take(resourceTypeOfOp(operation), operation.target)
    const payload = operation.payload as Readonly<Record<string, unknown>>
    takeAll('skill', payload.skills)
    takeAll('agent', payload.dependsOn)
    takeAll('mcp', payload.mcp)
    takeAll('plugin', payload.plugins)
    for (const raw of Array.isArray(payload.members) ? payload.members : []) {
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        take('agent', Reflect.get(raw, 'agentRef'))
      }
    }
    take('capability_template', payload.frameworkRef)
    if (
      payload.agentBySlot !== null &&
      typeof payload.agentBySlot === 'object' &&
      !Array.isArray(payload.agentBySlot)
    ) {
      for (const ref of Object.values(payload.agentBySlot)) take('agent', ref)
    }
    if (
      payload.definition !== null &&
      typeof payload.definition === 'object' &&
      !Array.isArray(payload.definition)
    ) {
      const nodes = Reflect.get(payload.definition, 'nodes')
      for (const raw of Array.isArray(nodes) ? nodes : []) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
        take('agent', Reflect.get(raw, 'agentRef'))
        take('workflow', Reflect.get(raw, 'workflowRef'))
        take('workgroup', Reflect.get(raw, 'workgroupRef'))
      }
    }
  }
  return Object.freeze([...out.values()])
}

async function assertReferencedResources(
  reader: PostgresqlResourcePackageTransactionReader,
  operations: readonly BundleOp[],
): Promise<void> {
  for (const reference of collectReferencedResources(operations)) {
    const decoded = decodeBundleIdentityRef(reference.ref)
    if (decoded === null) continue
    if (decoded.k === 'external') {
      await reader.assertVisible(reference.type, decoded.token)
      continue
    }
    if (decoded.k === 'builtin') {
      const resource = await reader.findBuiltin(reference.type, decoded.name)
      if (resource === null) {
        throw new ValidationError(
          'bundle-builtin-missing',
          `this instance has no builtin ${reference.type} named '${decoded.name}'`,
        )
      }
    }
  }
}

async function assertActiveHumanMappings(
  reader: PostgresqlResourcePackageTransactionReader,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return
  const rows = await reader.findActiveUsersByIds(userIds)
  const active = new Set(rows.map((row) => row.userId))
  const invalid = userIds.find((userId) => !active.has(userId))
  if (invalid !== undefined) {
    throw new ValidationError(
      'package-human-mapping-invalid',
      'one or more human member mapping targets are not active users',
    )
  }
}

async function prepareOperations(
  session: PostgresqlResourcePackageMutationSession,
  operations: readonly BundleOp[],
): Promise<PreparedOperations> {
  const items: PreparedPackageMutation[] = []
  for (const operation of operations) {
    switch (operation.kind) {
      case 'agent-create':
      case 'agent-update':
        items.push(await session.participants.agents.prepareOpaque(operation))
        break
      case 'skill-create':
      case 'skill-update':
        items.push(await session.participants.skills.prepareOpaque(operation))
        break
      case 'mcp-create':
      case 'mcp-update':
        items.push(await session.participants.mcps.prepareOpaque(operation))
        break
      case 'plugin-create':
      case 'plugin-update':
        items.push(await session.participants.plugins.prepareOpaque(operation))
        break
      case 'workflow-create':
      case 'workflow-update':
        items.push(await session.participants.workflows.prepareOpaque(operation))
        break
      case 'workgroup-create':
      case 'workgroup-update':
        items.push(await session.participants.workgroups.prepareOpaque(operation))
        break
      case 'capability-framework-create':
      case 'capability-framework-update':
      case 'capability-binding-create':
      case 'capability-binding-update':
      case 'capability-template-create':
      case 'capability-template-update':
        items.push(await session.participants.capabilityTemplates.prepareOpaque(operation))
        break
    }
  }
  return Object.freeze({ items: Object.freeze(items) })
}

async function commitPrepared(
  transactionSession: PostgresqlResourcePackageTransactionSession,
  prepared: PreparedPackageMutation,
): Promise<ResourcePackageMutationReceipt> {
  switch (prepared.mutation.kind) {
    case 'agent-create':
    case 'agent-update':
      if (preparedPackageMutation.isPreparedAgent(prepared))
        return await transactionSession.participants.agents.commit(prepared)
      break
    case 'skill-create':
    case 'skill-update':
      if (preparedPackageMutation.isPreparedSkill(prepared))
        return await transactionSession.participants.skills.commit(prepared)
      break
    case 'mcp-create':
    case 'mcp-update':
      if (preparedPackageMutation.isPreparedMcp(prepared))
        return await transactionSession.participants.mcps.commit(prepared)
      break
    case 'plugin-create':
    case 'plugin-update':
      if (preparedPackageMutation.isPreparedPlugin(prepared)) {
        return await transactionSession.participants.plugins.commit(prepared)
      }
      break
    case 'workflow-create':
    case 'workflow-update':
      if (preparedPackageMutation.isPreparedWorkflow(prepared)) {
        return await transactionSession.participants.workflows.commit(prepared)
      }
      break
    case 'workgroup-create':
    case 'workgroup-update':
      if (preparedPackageMutation.isPreparedWorkgroup(prepared)) {
        return await transactionSession.participants.workgroups.commit(prepared)
      }
      break
    case 'capability-framework-create':
    case 'capability-framework-update':
    case 'capability-binding-create':
    case 'capability-binding-update':
    case 'capability-template-create':
    case 'capability-template-update':
      if (preparedPackageMutation.isPreparedCapabilityTemplate(prepared)) {
        return await transactionSession.participants.capabilityTemplates.commit(prepared)
      }
      break
  }
  throw new Error(`resource-package-prepared-kind-mismatch:${prepared.mutation.kind}`)
}

async function resolveRoot(
  reader: PostgresqlResourcePackageTransactionReader,
  session: PostgresqlResourcePackageMutationSession,
  pkg: ParsedPackage,
  decisions: ResourcePackageAtomicApplyInput<ParsedPackage>['decisions'],
  selected: ReadonlyMap<string, Awaited<ReturnType<typeof reader.assertSelected>>>,
  applied: readonly ResourcePackageMutationReceipt[],
): Promise<NonNullable<PostgresqlResourcePackageApplyReceipt['root']>> {
  const rootRef = pkg.bundle.rootRef
  if (rootRef === undefined) {
    throw new ValidationError('package-invalid', 'a config package must have a root')
  }
  const decoded = decodeBundleIdentityRef(rootRef)
  if (decoded?.k === 'builtin') {
    const resource = await reader.findBuiltin(decoded.type, decoded.name)
    if (resource === null) {
      throw new ValidationError(
        'bundle-builtin-missing',
        `this instance has no builtin ${decoded.type} named '${decoded.name}'`,
      )
    }
    return Object.freeze({
      resourceType: decoded.type,
      resourceId: resource.id,
      name: resource.name,
      action: 'reuse',
    })
  }
  if (decoded?.k !== 'local') {
    throw new ValidationError(
      'package-invalid',
      'a config package must have a local or builtin root',
    )
  }
  const rootSlug = decoded.slug
  const rootOp = pkg.bundle.ops.find((operation) => opSlug(operation) === rootSlug)
  const decision = decisions.find((entry) => entry.localSlug === rootSlug)
  if (rootOp === undefined || decision === undefined) {
    throw new ValidationError(
      'package-root-unresolved',
      `package root '${rootSlug}' has no confirmed decision`,
    )
  }
  const resourceType = resourceTypeOfOp(rootOp)
  if (decision.action === 'reuse') {
    const resource = selected.get(rootSlug)
    if (resource === undefined) {
      throw new ValidationError(
        'package-root-unresolved',
        `reuse decision for root '${rootSlug}' has no selected target`,
      )
    }
    return Object.freeze({
      resourceType,
      resourceId: resource.id,
      name: resource.name,
      action: 'reuse',
    })
  }
  const receipt = applied.find((entry) => entry.operationId === rootOp.opId)
  if (receipt === undefined) {
    throw new ValidationError(
      'package-root-unresolved',
      `package root '${rootSlug}' was not applied`,
    )
  }
  const expectedId =
    decision.action === 'new'
      ? session.request.ids.findCreate({ type: resourceType, localSlug: rootSlug })
      : decision.targetId
  if (expectedId === null || expectedId === undefined || receipt.resourceId !== expectedId) {
    throw new Error(`resource-package-root-receipt-identity-mismatch:${rootSlug}`)
  }
  const resource = await reader.getById(resourceType, receipt.resourceId)
  if (resource === null) {
    throw new Error(`resource-package-root-not-persisted:${receipt.resourceId}`)
  }
  return Object.freeze({
    resourceType,
    resourceId: resource.id,
    name: resource.name,
    action: receipt.action,
  })
}

const applyLock = createAtomicApplyLock()

export function createResourcePackageAtomicApplyOperations(
  dependencies: ResourcePackageAtomicApplyDependencies,
): ResourcePackageAtomicApplyOperations {
  const now = dependencies.now ?? Date.now
  const log = dependencies.log ?? createLogger('postgresqlResourcePackageApply')
  const machine = createAtomicApply({
    journal: createResourcePackageAtomicJournal(dependencies.db),
    codecs: {
      encode: (artifacts: readonly PostgresqlResourcePackageMutationArtifact[]) =>
        resourcePackageArtifactCodecs.encode(artifacts),
    },
    receipt: { decode: decodeResourcePackageReceiptJson, encode: JSON.stringify },
    errors: resourcePackageApplyErrors,
    id: dependencies.id ?? ulid,
    now,
  })
  async function applyUnlocked(
    input: ResourcePackageAtomicApplyInput<ParsedPackage>,
  ): Promise<PostgresqlResourcePackageApplyReceipt> {
    const verified = verifyPreviewToken(dependencies.box, input.previewToken)
    if (verified.actorUserId !== input.actor.user.id) {
      throw new ValidationError(
        'package-preview-token-invalid',
        'preview token belongs to another user',
      )
    }
    if (verified.packageDigest !== input.package.digest) {
      throw new ValidationError(
        'package-preview-token-invalid',
        'the uploaded package is not the one that was previewed',
      )
    }

    const { resourceBundleApplies } = tablesOf(dependencies.db)
    const replay = await first(
      dependencies.db
        .select()
        .from(resourceBundleApplies)
        .where(
          and(
            eq(resourceBundleApplies.scope, PACKAGE_IDEMPOTENCY_SCOPE),
            eq(resourceBundleApplies.key, verified.importId),
          ),
        ),
    )
    if (replay !== undefined) return machine.replay(replay)

    if (now() > verified.expiresAt) {
      throw new ConflictError(
        'package-preview-expired',
        'this preview has expired; re-run the preview and confirm again',
      )
    }

    assertActionsAllowed(input.actor, input.package, input.decisions, verified.baseline)
    const baseline = new Map(verified.baseline.map((entry) => [entry.localSlug, entry]))
    const { ops, externalOfSlug } = translateDecisions(input.package, input.decisions, baseline)
    const translated = translatedBundle(input.package, ops, externalOfSlug)
    const secretProjection = applyPackageSecretInputs(
      translated,
      input.package.manifest.secrets,
      input.secretInputs,
      materializedSecretProjections(input.package, input.decisions, translated),
    )
    const operations = planBundleOps(secretProjection.bundle.ops)
    const humanMappings = validateHumanMappings(
      verified.humanBaseline,
      materializedWorkgroupSlugs(input.package, input.decisions),
      input.humanMemberMappings,
    )
    const readSkillFile = (ref: string): Uint8Array => {
      const bytes = input.package.files.get(ref)
      if (bytes === undefined) {
        throw new ValidationError('package-invalid', `package does not contain skill file '${ref}'`)
      }
      return bytes
    }
    const session = input.mutationSessionFactory.create({
      actor: input.actor,
      authority: input.authority,
      humanMemberMappings: input.humanMemberMappings,
      secretInputs: input.secretInputs,
      readSkillFile,
    })
    for (const operation of operations) {
      const localSlug = opSlug(operation)
      if (localSlug === null) continue
      session.request.ids.mintCreate({ type: resourceTypeOfOp(operation), localSlug })
    }

    const claim = await machine.claim({
      key: { scope: PACKAGE_IDEMPOTENCY_SCOPE, key: verified.importId },
      beforeLookup: async () => undefined,
      prepare: async () => ({
        insert: {
          scope: PACKAGE_IDEMPOTENCY_SCOPE,
          key: verified.importId,
          actorUserId: input.actor.user.id,
        },
        value: undefined,
      }),
    })
    if (claim.kind === 'replay') return claim.receipt
    const { journalId } = claim
    return machine.execute({
      journalId,
      async prepare(recordArtifact) {
        const prepared = await prepareOperations(session, operations)
        for (const item of prepared.items) await session.prestage(item, { recordArtifact })
        return prepared
      },
      async commit(transaction, journalId, prepared) {
        const transactionSession = session.bindTransaction(transaction)
        const selected = await assertSelectedResources(
          transactionSession.reader,
          input.package,
          input.decisions,
          baseline,
        )
        await assertReferencedResources(transactionSession.reader, operations)
        await assertActiveHumanMappings(transactionSession.reader, humanMappings.activeUserIds)

        const applied: ResourcePackageMutationReceipt[] = []
        for (const item of prepared.items) {
          applied.push(await commitPrepared(transactionSession, item))
        }
        const root = await resolveRoot(
          transactionSession.reader,
          session,
          input.package,
          input.decisions,
          selected,
          applied,
        )
        const receiptValue: PostgresqlResourcePackageApplyReceipt = ReceiptSchema.parse({
          journalId,
          applied,
          root,
          ...(secretProjection.skippedRefs.length === 0
            ? {}
            : { skippedSecrets: secretProjection.skippedRefs }),
        })

        return { receipt: receiptValue }
      },
      async afterCommit({ receipt }, artifacts) {
        await session.rollForward({ artifacts, receipt })
        await session.afterCommitted(receipt)
      },
      async compensate(artifacts) {
        try {
          await session.compensate({ artifacts, databaseCommitted: false })
          return []
        } catch (error) {
          return [error]
        }
      },
      async committedFailure(error, artifacts) {
        try {
          await session.compensate({ artifacts, databaseCommitted: true })
        } catch (recoveryError) {
          log.warn('resource-package-committed-recovery-failed', {
            journalId,
            err: errorText(recoveryError),
          })
        }
        log.warn('resource-package-roll-forward-crashed', { journalId, err: errorText(error) })
      },
      leftRetryable(error, errors) {
        log.warn('resource-package-left-retryable', {
          journalId,
          err: errorText(error),
          cleanup: errors.map(errorText).join('; '),
        })
      },
    })
  }
  return Object.freeze({
    apply: (input: ResourcePackageAtomicApplyInput<ParsedPackage>) =>
      applyLock.run(`${input.actor.user.id}:${input.previewToken}`, () => applyUnlocked(input)),
    activeApplyIds: machine.activeJournalIds,
  })
}

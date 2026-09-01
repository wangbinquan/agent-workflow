// RFC-349 — provider-neutral capability-template CRUD and authorization use cases.

import {
  CapabilityTemplateCopySchema,
  CapabilityTemplateWriteSchema,
  TEMPLATE_PRIVILEGED_FIELDS,
  type CapabilityTemplateWire,
  type CapabilityTemplateWrite,
  type ResourceAccess,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import { canWriteFramework } from '../domain/templateLayers'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type {
  CapabilityTemplatePersistence,
  CapabilityTemplateRecord,
  PreparedCapabilityTemplateWrite,
} from './ports/capabilityTemplatePersistence'

export interface CapabilityTemplateResourceAccess {
  filterVisible(
    actor: Actor,
    rows: readonly CapabilityTemplateRecord[],
  ): Promise<CapabilityTemplateRecord[]>
  canView(actor: Actor, row: CapabilityTemplateRecord): Promise<boolean>
  requireEdit(actor: Actor, row: CapabilityTemplateRecord): Promise<ResourceAccess>
  requireGovern(actor: Actor, row: CapabilityTemplateRecord): Promise<void>
  assertNameUnchangedForEditor(
    access: ResourceAccess,
    currentName: string,
    submittedName: string | null | undefined,
  ): void
}

export interface CapabilityTemplateOperations {
  list(actor: Actor): Promise<CapabilityTemplateWire[]>
  get(actor: Actor, id: string): Promise<CapabilityTemplateWire>
  create(actor: Actor, raw: unknown): Promise<CapabilityTemplateWire>
  update(actor: Actor, id: string, raw: unknown): Promise<CapabilityTemplateWire>
  copy(actor: Actor, id: string, raw: unknown): Promise<CapabilityTemplateWire>
  delete(actor: Actor, id: string): Promise<void>
  requireVisible(actor: Actor, id: string): Promise<void>
  requireEditable(actor: Actor, id: string): Promise<void>
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(raw)
    return value === null ? fallback : (value as T)
  } catch {
    return fallback
  }
}

function mayReadScripts(actor: Actor): boolean {
  return actor.permissions.has('scripts:author')
}

function serialize(row: CapabilityTemplateRecord, actor: Actor): CapabilityTemplateWire {
  const base = {
    id: row.id,
    name: row.name,
    description: row.description,
    capability: row.capability,
    paramSchema: parseJson<CapabilityTemplateWire['paramSchema']>(row.paramSchemaJson, []),
    paramDefaults: parseJson<Record<string, unknown>>(row.paramDefaultsJson, {}),
    agentBySlot: parseJson<Record<string, string>>(row.agentBySlotJson, {}),
    promptBySlot: parseJson<Record<string, string>>(row.promptBySlotJson, {}),
    params: parseJson<Record<string, unknown>>(row.paramsJson, {}),
    stageContractVer: row.stageContractVer,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    builtin: row.builtin,
    aclRevision: row.aclRevision,
    upstream:
      row.upstreamId === null || row.upstreamVersion === null || row.baseDigest === null
        ? null
        : {
            upstreamId: row.upstreamId,
            upstreamVersion: row.upstreamVersion,
            baseDigest: row.baseDigest,
          },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (!mayReadScripts(actor)) return { ...base, scriptsRedacted: true }
  return {
    ...base,
    scripts: parseJson<NonNullable<CapabilityTemplateWire['scripts']>>(row.scriptsJson, {}),
    hooks: parseJson<NonNullable<CapabilityTemplateWire['hooks']>>(row.hooksJson, []),
    scriptsRedacted: false,
  }
}

function mergeableSnapshot(row: CapabilityTemplateRecord): Record<string, unknown> {
  return {
    description: row.description,
    scripts: parseJson<unknown>(row.scriptsJson, {}),
    hooks: parseJson<unknown>(row.hooksJson, []),
    paramSchema: parseJson<unknown>(row.paramSchemaJson, []),
    paramDefaults: parseJson<unknown>(row.paramDefaultsJson, {}),
    agentBySlot: parseJson<unknown>(row.agentBySlotJson, {}),
    promptBySlot: parseJson<unknown>(row.promptBySlotJson, {}),
    params: parseJson<unknown>(row.paramsJson, {}),
    stageContractVer: row.stageContractVer,
  }
}

function digest(row: CapabilityTemplateRecord): string {
  return sha256Hex(
    JSON.stringify([
      row.capability,
      row.scriptsJson,
      row.hooksJson,
      row.paramSchemaJson,
      row.paramDefaultsJson,
      row.agentBySlotJson,
      row.promptBySlotJson,
      row.paramsJson,
      row.stageContractVer,
    ]),
  )
}

function assertBuiltinMutable(row: CapabilityTemplateRecord): void {
  if (!row.builtin) return
  throw new ValidationError(
    'capability-template-builtin',
    'this template ships with the platform; copy it and edit the copy',
  )
}

function assertFieldsAllowed(
  actor: Actor,
  input: Pick<CapabilityTemplateWrite, 'scripts' | 'hooks'>,
  existing: CapabilityTemplateRecord | null,
): void {
  const changed = TEMPLATE_PRIVILEGED_FIELDS.filter((field) => {
    const next = JSON.stringify(input[field])
    const before =
      existing === null ? null : field === 'scripts' ? existing.scriptsJson : existing.hooksJson
    if (before === null) return next !== (field === 'scripts' ? '{}' : '[]')
    return next !== before
  })
  if (changed.length === 0) return
  if (canWriteFramework({ hasResourceWrite: true, hasScriptsAuthor: mayReadScripts(actor) })) return
  throw new ForbiddenError(
    'capability-template-scripts-forbidden',
    `changing ${changed.join(' and ')} requires the scripts:author permission — those run with the daemon’s credentials`,
  )
}

function rowFromInput(
  input: CapabilityTemplateWrite,
  base: Pick<
    CapabilityTemplateRecord,
    | 'id'
    | 'ownerUserId'
    | 'visibility'
    | 'aclRevision'
    | 'builtin'
    | 'upstreamId'
    | 'upstreamVersion'
    | 'baseDigest'
    | 'baseSnapshotJson'
    | 'createdAt'
  >,
  now: number,
): CapabilityTemplateRecord {
  return {
    ...base,
    name: input.name,
    description: input.description ?? null,
    capability: input.capability,
    scriptsJson: JSON.stringify(input.scripts),
    hooksJson: JSON.stringify(input.hooks),
    paramSchemaJson: JSON.stringify(input.paramSchema),
    paramDefaultsJson: JSON.stringify(input.paramDefaults),
    agentBySlotJson: JSON.stringify(input.agentBySlot),
    promptBySlotJson: JSON.stringify(input.promptBySlot),
    paramsJson: JSON.stringify(input.params),
    stageContractVer: input.stageContractVer,
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    updatedAt: now,
  }
}

function parseWrite(
  raw: unknown,
  actor: Actor,
  existing: CapabilityTemplateRecord | null,
): CapabilityTemplateWrite {
  const loose =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {}
  if (!mayReadScripts(actor) && existing !== null) {
    if (loose.scripts === undefined) loose.scripts = parseJson<unknown>(existing.scriptsJson, {})
    if (loose.hooks === undefined) loose.hooks = parseJson<unknown>(existing.hooksJson, [])
  }
  const parsed = CapabilityTemplateWriteSchema.safeParse(loose)
  if (!parsed.success) {
    throw new ValidationError('capability-template-invalid', 'invalid template payload', {
      issues: parsed.error.issues,
    })
  }
  return parsed.data
}

/**
 * Provider-owned ResourcePackage writers reuse the exact template validation
 * and row projection used by HTTP CRUD. The caller supplies its transaction-
 * bound uniqueness query, so this application function neither opens a second
 * transaction nor imports a provider mechanism.
 */
export async function prepareCapabilityTemplatePackageWrite(input: {
  readonly actor: Actor
  readonly raw: unknown
  readonly resourceId: string
  readonly existing: CapabilityTemplateRecord | null
  readonly nameExists: (input: {
    readonly ownerUserId: string | null
    readonly name: string
    readonly excludeId: string | null
  }) => Promise<boolean>
  readonly now?: number
}): Promise<PreparedCapabilityTemplateWrite> {
  const body = parseWrite(input.raw, input.actor, input.existing)
  if (input.existing !== null) assertBuiltinMutable(input.existing)
  assertFieldsAllowed(input.actor, body, input.existing)
  const ownerUserId = input.existing?.ownerUserId ?? input.actor.user.id
  if (
    await input.nameExists({
      ownerUserId,
      name: body.name,
      excludeId: input.existing?.id ?? null,
    })
  ) {
    throw new ConflictError(
      'capability-template-name-taken',
      `you already have one named '${body.name}'`,
    )
  }
  const timestamp = input.now ?? Date.now()
  return Object.freeze({
    existing: input.existing,
    row: rowFromInput(
      body,
      {
        id: input.existing?.id ?? input.resourceId,
        ownerUserId,
        visibility: input.existing?.visibility ?? 'private',
        aclRevision: input.existing?.aclRevision ?? 0,
        builtin: false,
        upstreamId: input.existing?.upstreamId ?? null,
        upstreamVersion: input.existing?.upstreamVersion ?? null,
        baseDigest: input.existing?.baseDigest ?? null,
        baseSnapshotJson: input.existing?.baseSnapshotJson ?? null,
        createdAt: input.existing?.createdAt ?? timestamp,
      },
      timestamp,
    ),
  })
}

export function createCapabilityTemplateOperations(input: {
  readonly persistence: CapabilityTemplatePersistence
  readonly access: CapabilityTemplateResourceAccess
  readonly now?: () => number
  readonly mintId?: () => string
}): CapabilityTemplateOperations {
  const persistence = input.persistence
  const access = input.access
  const now = input.now ?? (() => Date.now())
  const mintId = input.mintId ?? (() => ulid())

  const loadVisible = async (actor: Actor, id: string): Promise<CapabilityTemplateRecord> => {
    const row = await persistence.load(id)
    if (row === null || !(await access.canView(actor, row))) {
      throw new NotFoundError('capability-template-not-found', `template '${id}' not found`)
    }
    return row
  }
  const assertNameFree = async (
    ownerUserId: string | null,
    name: string,
    excludeId: string | null,
  ): Promise<void> => {
    if (!(await persistence.ownerNameExists({ ownerUserId, name, excludeId }))) return
    throw new ConflictError(
      'capability-template-name-taken',
      `you already have one named '${name}'`,
    )
  }

  const operations: CapabilityTemplateOperations = {
    async list(actor) {
      return (await access.filterVisible(actor, await persistence.list())).map((row) =>
        serialize(row, actor),
      )
    },
    async get(actor, id) {
      return serialize(await loadVisible(actor, id), actor)
    },
    async create(actor, raw) {
      const body = parseWrite(raw, actor, null)
      assertFieldsAllowed(actor, body, null)
      await assertNameFree(actor.user.id, body.name, null)
      const timestamp = now()
      const row = rowFromInput(
        body,
        {
          id: mintId(),
          ownerUserId: actor.user.id,
          visibility: body.visibility ?? 'private',
          aclRevision: 0,
          builtin: false,
          upstreamId: null,
          upstreamVersion: null,
          baseDigest: null,
          baseSnapshotJson: null,
          createdAt: timestamp,
        },
        timestamp,
      )
      await persistence.insert(row)
      return serialize(row, actor)
    },
    async update(actor, id, raw) {
      const existing = await loadVisible(actor, id)
      const resourceAccess = await access.requireEdit(actor, existing)
      const body = parseWrite(raw, actor, existing)
      access.assertNameUnchangedForEditor(resourceAccess, existing.name, body.name)
      assertBuiltinMutable(existing)
      assertFieldsAllowed(actor, body, existing)
      await assertNameFree(existing.ownerUserId, body.name, existing.id)
      const row = rowFromInput(body, existing, now())
      await persistence.replace(row)
      return serialize(row, actor)
    },
    async copy(actor, id, raw) {
      const source = await loadVisible(actor, id)
      const parsed = CapabilityTemplateCopySchema.safeParse(raw)
      if (!parsed.success) {
        throw new ValidationError('capability-template-invalid', 'invalid copy payload', {
          issues: parsed.error.issues,
        })
      }
      const name = parsed.data.name ?? `${source.name} copy`
      await assertNameFree(actor.user.id, name, null)
      const timestamp = now()
      const row: CapabilityTemplateRecord = {
        ...source,
        id: mintId(),
        name,
        ownerUserId: actor.user.id,
        visibility: 'private',
        aclRevision: 0,
        builtin: false,
        upstreamId: source.id,
        upstreamVersion: source.updatedAt,
        baseDigest: digest(source),
        baseSnapshotJson: JSON.stringify(mergeableSnapshot(source)),
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      await persistence.insert(row)
      return serialize(row, actor)
    },
    async delete(actor, id) {
      const row = await loadVisible(actor, id)
      await access.requireGovern(actor, row)
      assertBuiltinMutable(row)
      await persistence.delete(row.id)
    },
    async requireVisible(actor, id) {
      await loadVisible(actor, id)
    },
    async requireEditable(actor, id) {
      const row = await loadVisible(actor, id)
      await access.requireEdit(actor, row)
    },
  }
  return Object.freeze(operations)
}

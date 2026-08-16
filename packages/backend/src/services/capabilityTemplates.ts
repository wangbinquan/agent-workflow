// RFC-304 T57 — CRUD for the two capability template layers.
//
// This file is the JOIN the RFC has been missing. `rejectFrameworkOnlyFields`
// and `canWriteFramework` have existed in `domain/templateLayers.ts` since PR-2
// with zero callers repo-wide, because neither resource had an HTTP surface at
// all. Rules with no call site never fail — the layer boundary they describe
// was documentation, not enforcement.
//
// ## Two things this must get right
//
// A framework write needs BOTH resource write access and `scripts:author`.
// Either one alone is a way around the other: resource write alone would let
// someone granted a framework reach the daemon's credentials, and
// `scripts:author` alone would bypass the resource ACL entirely.
//
// A framework READ redacts script bodies from anyone without `scripts:author`.
// Redacted, not withheld: a group lead has to see which frameworks exist and
// what parameters they take, or the group layer cannot be used without handing
// out the department layer — which is the split's entire purpose.

import { and, eq, ne } from 'drizzle-orm'
import { ulid } from 'ulid'
import type {
  CapabilityBindingWire,
  CapabilityBindingWrite,
  CapabilityFrameworkWire,
  CapabilityFrameworkWrite,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { capabilityBindings, capabilityFrameworks } from '@/db/schema'
import { canWriteFramework } from '@/modules/code-capability/domain/templateLayers'
import { ConflictError, ForbiddenError, ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'

type FrameworkRow = typeof capabilityFrameworks.$inferSelect
type BindingRow = typeof capabilityBindings.$inferSelect

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(raw)
    return value === null ? fallback : (value as T)
  } catch {
    // A row whose JSON column will not parse is corrupt, not fatal. Returning
    // the empty shape keeps the list rendering — with one broken entry — rather
    // than 500-ing the whole page over one row.
    return fallback
  }
}

/**
 * The body digest a copy records as its base (T64).
 *
 * Covers only the fields a merge would compare — not `updatedAt`, not the ACL,
 * not the id. Including those would make every ACL edit look like a body change
 * and mark healthy copies `conflicted`.
 */
export function frameworkDigest(row: {
  capability: string
  scriptsJson: string
  hooksJson: string
  paramSchemaJson: string
  paramDefaultsJson: string
  stageContractVer: number
}): string {
  return sha256Hex(
    JSON.stringify([
      row.capability,
      row.scriptsJson,
      row.hooksJson,
      row.paramSchemaJson,
      row.paramDefaultsJson,
      row.stageContractVer,
    ]),
  )
}

export function bindingDigest(row: {
  frameworkId: string
  agentBySlotJson: string
  promptBySlotJson: string
  paramsJson: string
}): string {
  return sha256Hex(
    JSON.stringify([row.frameworkId, row.agentBySlotJson, row.promptBySlotJson, row.paramsJson]),
  )
}

/** Whether this actor may see script bodies. */
export function mayReadScripts(actor: Actor): boolean {
  return actor.permissions.has('scripts:author')
}

export function serializeFramework(row: FrameworkRow, actor: Actor): CapabilityFrameworkWire {
  const base = {
    id: row.id,
    name: row.name,
    description: row.description,
    capability: row.capability,
    paramSchema: parseJson<CapabilityFrameworkWire['paramSchema']>(row.paramSchemaJson, []),
    paramDefaults: parseJson<Record<string, unknown>>(row.paramDefaultsJson, {}),
    stageContractVer: row.stageContractVer,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    builtin: row.builtin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }

  if (!mayReadScripts(actor)) {
    // The fields are ABSENT, and a flag says so. Returning `{}` would read as
    // "this framework has no scripts", which is false for every framework that
    // does anything, and would send the reader to fix a template that is fine.
    return { ...base, scriptsRedacted: true }
  }

  return {
    ...base,
    scripts: parseJson<NonNullable<CapabilityFrameworkWire['scripts']>>(row.scriptsJson, {}),
    hooks: parseJson<NonNullable<CapabilityFrameworkWire['hooks']>>(row.hooksJson, []),
    scriptsRedacted: false,
  }
}

export function serializeBinding(row: BindingRow): CapabilityBindingWire {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    frameworkId: row.frameworkId,
    agentBySlot: parseJson<Record<string, string>>(row.agentBySlotJson, {}),
    promptBySlot: parseJson<Record<string, string>>(row.promptBySlotJson, {}),
    params: parseJson<Record<string, unknown>>(row.paramsJson, {}),
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    builtin: row.builtin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listFrameworkRows(db: DbClient): Promise<FrameworkRow[]> {
  return await db.select().from(capabilityFrameworks)
}

export async function getFrameworkRow(db: DbClient, id: string): Promise<FrameworkRow | null> {
  return (
    (await db.select().from(capabilityFrameworks).where(eq(capabilityFrameworks.id, id)))[0] ?? null
  )
}

export async function listBindingRows(db: DbClient): Promise<BindingRow[]> {
  return await db.select().from(capabilityBindings)
}

export async function getBindingRow(db: DbClient, id: string): Promise<BindingRow | null> {
  return (
    (await db.select().from(capabilityBindings).where(eq(capabilityBindings.id, id)))[0] ?? null
  )
}

/**
 * The two-factor framework write check, as a throwing guard.
 *
 * `canWriteFramework` is the pure predicate; this is where it finally gets
 * called. The message names BOTH factors because "forbidden" alone would send
 * someone to ask for the wrong grant — the common case is holding the resource
 * ACL and not `scripts:author`.
 */
export function assertMayWriteFramework(actor: Actor, hasResourceWrite: boolean): void {
  if (canWriteFramework({ hasResourceWrite, hasScriptsAuthor: mayReadScripts(actor) })) return
  throw new ForbiddenError(
    'capability-framework-forbidden',
    hasResourceWrite
      ? 'writing a capability framework also requires the scripts:author permission — its scripts run with the daemon’s credentials'
      : 'you do not have write access to this capability framework',
  )
}

async function assertNameFree(
  db: DbClient,
  table: typeof capabilityFrameworks | typeof capabilityBindings,
  ownerUserId: string | null,
  name: string,
  excludeId: string | null,
): Promise<void> {
  // Owner-scoped uniqueness, matching the unique index on the table. Checked
  // here so the caller gets a named error rather than a raw SQLite constraint
  // message with the index name in it.
  const clauses = [eq(table.name, name)]
  clauses.push(
    ownerUserId === null ? eq(table.ownerUserId, '') : eq(table.ownerUserId, ownerUserId),
  )
  if (excludeId !== null) clauses.push(ne(table.id, excludeId))
  const clash = await db
    .select({ id: table.id })
    .from(table)
    .where(and(...clauses))
    .limit(1)
  if (clash.length > 0) {
    throw new ConflictError(
      'capability-template-name-taken',
      `you already have one named '${name}'`,
    )
  }
}

export async function createFramework(
  db: DbClient,
  input: CapabilityFrameworkWrite,
  actor: Actor,
  now = Date.now(),
): Promise<FrameworkRow> {
  assertMayWriteFramework(actor, true)
  await assertNameFree(db, capabilityFrameworks, actor.user.id, input.name, null)

  const row: FrameworkRow = {
    id: ulid(),
    name: input.name,
    description: input.description ?? null,
    capability: input.capability,
    scriptsJson: JSON.stringify(input.scripts),
    hooksJson: JSON.stringify(input.hooks),
    paramSchemaJson: JSON.stringify(input.paramSchema),
    paramDefaultsJson: JSON.stringify(input.paramDefaults),
    stageContractVer: input.stageContractVer,
    ownerUserId: actor.user.id,
    // Private by default (RFC-099): a newly created resource is the creator's
    // until they say otherwise. A public default would publish every draft
    // framework — including its scripts — to everyone the moment it is saved.
    visibility: input.visibility ?? 'private',
    aclRevision: 0,
    builtin: false,
    // Authored here, not copied — no origin, which is a normal state rather
    // than missing data.
    upstreamId: null,
    upstreamVersion: null,
    baseDigest: null,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(capabilityFrameworks).values(row)
  return row
}

export async function updateFramework(
  db: DbClient,
  existing: FrameworkRow,
  input: CapabilityFrameworkWrite,
  actor: Actor,
  now = Date.now(),
): Promise<FrameworkRow> {
  assertBuiltinImmutable(existing.builtin, 'framework')
  await assertNameFree(db, capabilityFrameworks, existing.ownerUserId, input.name, existing.id)

  const next: FrameworkRow = {
    ...existing,
    name: input.name,
    description: input.description ?? null,
    capability: input.capability,
    scriptsJson: JSON.stringify(input.scripts),
    hooksJson: JSON.stringify(input.hooks),
    paramSchemaJson: JSON.stringify(input.paramSchema),
    paramDefaultsJson: JSON.stringify(input.paramDefaults),
    stageContractVer: input.stageContractVer,
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    updatedAt: now,
  }
  await db.update(capabilityFrameworks).set(next).where(eq(capabilityFrameworks.id, existing.id))
  return next
}

export async function createBinding(
  db: DbClient,
  input: CapabilityBindingWrite,
  actor: Actor,
  now = Date.now(),
): Promise<BindingRow> {
  // The framework must exist AND be visible to this actor. Skipping the
  // visibility half would let a binding name a private framework the author
  // cannot see, turning the binding into an existence oracle.
  const framework = await getFrameworkRow(db, input.frameworkId)
  if (framework === null) {
    throw new ValidationError(
      'capability-framework-not-found',
      `no capability framework '${input.frameworkId}'`,
    )
  }
  await assertNameFree(db, capabilityBindings, actor.user.id, input.name, null)

  const row: BindingRow = {
    id: ulid(),
    name: input.name,
    description: input.description ?? null,
    frameworkId: input.frameworkId,
    agentBySlotJson: JSON.stringify(input.agentBySlot),
    promptBySlotJson: JSON.stringify(input.promptBySlot),
    paramsJson: JSON.stringify(input.params),
    ownerUserId: actor.user.id,
    visibility: input.visibility ?? 'private',
    aclRevision: 0,
    builtin: false,
    upstreamId: null,
    upstreamVersion: null,
    baseDigest: null,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(capabilityBindings).values(row)
  return row
}

export async function updateBinding(
  db: DbClient,
  existing: BindingRow,
  input: CapabilityBindingWrite,
  now = Date.now(),
): Promise<BindingRow> {
  assertBuiltinImmutable(existing.builtin, 'binding')
  await assertNameFree(db, capabilityBindings, existing.ownerUserId, input.name, existing.id)

  const next: BindingRow = {
    ...existing,
    name: input.name,
    description: input.description ?? null,
    frameworkId: input.frameworkId,
    agentBySlotJson: JSON.stringify(input.agentBySlot),
    promptBySlotJson: JSON.stringify(input.promptBySlot),
    paramsJson: JSON.stringify(input.params),
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    updatedAt: now,
  }
  await db.update(capabilityBindings).set(next).where(eq(capabilityBindings.id, existing.id))
  return next
}

/**
 * Copy a template, so a team can start from one that works.
 *
 * The copy is owned by whoever made it and starts PRIVATE regardless of the
 * source's visibility — copying a public framework must not publish the copy,
 * which will be edited before it is fit to share.
 */
export async function copyFramework(
  db: DbClient,
  source: FrameworkRow,
  actor: Actor,
  name: string | undefined,
  now = Date.now(),
): Promise<FrameworkRow> {
  assertMayWriteFramework(actor, true)
  const copyName = name ?? `${source.name} copy`
  await assertNameFree(db, capabilityFrameworks, actor.user.id, copyName, null)

  const row: FrameworkRow = {
    ...source,
    id: ulid(),
    name: copyName,
    ownerUserId: actor.user.id,
    visibility: 'private',
    aclRevision: 0,
    // A copy of a built-in is an ordinary resource — that is the point of
    // copying one. Carrying the flag across would make it uneditable.
    builtin: false,
    // T64 — the link, written HERE because this is the only moment all three
    // facts are true at once. After this the source moves on and its `updatedAt`
    // no longer describes what was copied.
    upstreamId: source.id,
    upstreamVersion: source.updatedAt,
    baseDigest: frameworkDigest(source),
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(capabilityFrameworks).values(row)
  return row
}

export async function copyBinding(
  db: DbClient,
  source: BindingRow,
  actor: Actor,
  name: string | undefined,
  now = Date.now(),
): Promise<BindingRow> {
  const copyName = name ?? `${source.name} copy`
  await assertNameFree(db, capabilityBindings, actor.user.id, copyName, null)

  const row: BindingRow = {
    ...source,
    id: ulid(),
    name: copyName,
    ownerUserId: actor.user.id,
    visibility: 'private',
    aclRevision: 0,
    builtin: false,
    upstreamId: source.id,
    upstreamVersion: source.updatedAt,
    baseDigest: bindingDigest(source),
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(capabilityBindings).values(row)
  return row
}

export async function deleteFramework(db: DbClient, row: FrameworkRow): Promise<void> {
  assertBuiltinImmutable(row.builtin, 'framework')
  // Refuse while a binding still points at it. Deleting anyway leaves every
  // dependent cell reporting `framework-missing` — a readiness state that
  // names a cause the person did not cause and cannot undo.
  const dependents = await db
    .select({ id: capabilityBindings.id })
    .from(capabilityBindings)
    .where(eq(capabilityBindings.frameworkId, row.id))
    .limit(1)
  if (dependents.length > 0) {
    throw new ConflictError(
      'capability-framework-in-use',
      'a capability binding still references this framework; change or delete it first',
    )
  }
  await db.delete(capabilityFrameworks).where(eq(capabilityFrameworks.id, row.id))
}

export async function deleteBinding(db: DbClient, row: BindingRow): Promise<void> {
  assertBuiltinImmutable(row.builtin, 'binding')
  await db.delete(capabilityBindings).where(eq(capabilityBindings.id, row.id))
}

function assertBuiltinImmutable(builtin: boolean, kind: 'framework' | 'binding'): void {
  if (!builtin) return
  throw new ValidationError(
    'capability-template-builtin',
    `this ${kind} ships with the platform; copy it and edit the copy`,
  )
}

// ---------------------------------------------------------------------------
// RFC-304 T17b — the config-package path.
//
// Split into prepare (async, validates and resolves refs) and commit (sync,
// inside the bundle's single transaction), because that is the shape the bundle
// applier requires: every op is validated BEFORE anything is written, so a
// package that is going to fail fails without leaving half of itself behind.
//
// Reusing the same row builders as the HTTP path rather than a parallel set: a
// package is another way to write the same row, and two writers that drift are
// how an imported template ends up subtly unlike a created one.

export interface PreparedFrameworkWrite {
  row: FrameworkRow
  /** Present for an update; the row being replaced. */
  existing: FrameworkRow | null
}

export interface PreparedBindingWrite {
  row: BindingRow
  existing: BindingRow | null
}

/**
 * Validate a framework write from a package.
 *
 * The two-factor check runs HERE as well as at the HTTP route, and that is not
 * belt-and-braces: the package path never passes through the route, so leaving
 * it to the route would mean an import is a way around the rule rather than
 * another way to use it.
 */
export async function prepareFrameworkFromBundle(
  db: DbClient,
  input: CapabilityFrameworkWrite & { id: string },
  actor: Actor,
  existingId: string | null,
  now = Date.now(),
): Promise<PreparedFrameworkWrite> {
  assertMayWriteFramework(actor, true)
  const existing = existingId === null ? null : await getFrameworkRow(db, existingId)
  if (existingId !== null && existing === null) {
    throw new ValidationError(
      'capability-framework-not-found',
      `framework '${existingId}' no longer exists`,
    )
  }
  if (existing !== null) assertBuiltinImmutable(existing.builtin, 'framework')
  await assertNameFree(
    db,
    capabilityFrameworks,
    existing?.ownerUserId ?? actor.user.id,
    input.name,
    existing?.id ?? null,
  )

  return {
    existing,
    row: {
      id: existing?.id ?? input.id,
      name: input.name,
      description: input.description ?? null,
      capability: input.capability,
      scriptsJson: JSON.stringify(input.scripts),
      hooksJson: JSON.stringify(input.hooks),
      paramSchemaJson: JSON.stringify(input.paramSchema),
      paramDefaultsJson: JSON.stringify(input.paramDefaults),
      stageContractVer: input.stageContractVer,
      // An import lands as the IMPORTER's private resource, never carrying the
      // source instance's owner across: that user id means nothing here, and a
      // package that could set visibility would publish somebody else's
      // template on arrival.
      ownerUserId: existing?.ownerUserId ?? actor.user.id,
      visibility: existing?.visibility ?? 'private',
      aclRevision: existing?.aclRevision ?? 0,
      builtin: false,
      // An imported template keeps whatever origin it already had here; the
      // package itself carries no resolvable link (`packagedUpstreamState`
      // reports `detached` on an instance that never saw the upstream), so
      // inventing one would claim a relationship this instance cannot check.
      upstreamId: existing?.upstreamId ?? null,
      upstreamVersion: existing?.upstreamVersion ?? null,
      baseDigest: existing?.baseDigest ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
  }
}

export async function prepareBindingFromBundle(
  db: DbClient,
  input: CapabilityBindingWrite & { id: string },
  actor: Actor,
  existingId: string | null,
  now = Date.now(),
): Promise<PreparedBindingWrite> {
  const existing = existingId === null ? null : await getBindingRow(db, existingId)
  if (existingId !== null && existing === null) {
    throw new ValidationError(
      'capability-binding-not-found',
      `binding '${existingId}' no longer exists`,
    )
  }
  if (existing !== null) assertBuiltinImmutable(existing.builtin, 'binding')

  // The framework must resolve on THIS instance. A binding whose framework did
  // not come along is not importable — it would land pointing at nothing and
  // report `framework-missing` on every cell that used it.
  const framework = await getFrameworkRow(db, input.frameworkId)
  if (framework === null) {
    throw new ValidationError(
      'capability-framework-not-found',
      `this binding names framework '${input.frameworkId}', which is not in the package or on this instance`,
    )
  }
  await assertNameFree(
    db,
    capabilityBindings,
    existing?.ownerUserId ?? actor.user.id,
    input.name,
    existing?.id ?? null,
  )

  return {
    existing,
    row: {
      id: existing?.id ?? input.id,
      name: input.name,
      description: input.description ?? null,
      frameworkId: input.frameworkId,
      agentBySlotJson: JSON.stringify(input.agentBySlot),
      promptBySlotJson: JSON.stringify(input.promptBySlot),
      paramsJson: JSON.stringify(input.params),
      ownerUserId: existing?.ownerUserId ?? actor.user.id,
      visibility: existing?.visibility ?? 'private',
      aclRevision: existing?.aclRevision ?? 0,
      builtin: false,
      upstreamId: existing?.upstreamId ?? null,
      upstreamVersion: existing?.upstreamVersion ?? null,
      baseDigest: existing?.baseDigest ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
  }
}

export function commitFrameworkInTx(tx: DbTxSync, prepared: PreparedFrameworkWrite): void {
  if (prepared.existing === null) {
    tx.insert(capabilityFrameworks).values(prepared.row).run()
    return
  }
  tx.update(capabilityFrameworks)
    .set(prepared.row)
    .where(eq(capabilityFrameworks.id, prepared.row.id))
    .run()
}

export function commitBindingInTx(tx: DbTxSync, prepared: PreparedBindingWrite): void {
  if (prepared.existing === null) {
    tx.insert(capabilityBindings).values(prepared.row).run()
    return
  }
  tx.update(capabilityBindings)
    .set(prepared.row)
    .where(eq(capabilityBindings.id, prepared.row.id))
    .run()
}

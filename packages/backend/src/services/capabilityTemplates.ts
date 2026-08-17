// RFC-309 T7/T8 — CRUD for the capability template. One family, not two.
//
// RFC-304 had two of everything here: `createFramework`/`createBinding`,
// `copyFramework`/`copyBinding`, two digests, two serializers, two bundle
// preparers. That was the two-layer data model showing through, and the layers
// existed for one reason — scripts run as the daemon, so writing them needs
// `scripts:author` on top of resource write access.
//
// The merge keeps that reason and drops the duplication, by moving the check
// from the OBJECT to the FIELD:
//
//   name / agents / prompts / params  →  ordinary resource write
//   scripts / hooks                   →  + `scripts:author`
//
// ## The two things this must still get right
//
// A write that touches `scripts` or `hooks` needs BOTH factors. Either one
// alone is a way around the other: resource write alone would let anyone who
// owns a template reach the daemon's credentials, and `scripts:author` alone
// would bypass the resource ACL entirely.
//
// A READ redacts script bodies from anyone without `scripts:author`. Redacted,
// not withheld: a group lead has to see which templates exist and what
// parameters they take, or templates cannot be used at all without handing out
// the daemon — which is what the old split was protecting against.
//
// ## Why a rejected write is rejected WHOLE
//
// The tempting alternative is to accept the request and quietly keep the old
// script. That is how a team comes to believe their hook is running when their
// save silently dropped it, and they would only find out from the absence of
// failures. `assertTemplateFieldsAllowed` compares against the stored row and
// throws if a privileged field actually changed.

import { and, eq, ne } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  TEMPLATE_PRIVILEGED_FIELDS,
  type CapabilityTemplateWire,
  type CapabilityTemplateWrite,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { capabilityTemplates } from '@/db/schema'
import { canWriteFramework } from '@/modules/code-capability/domain/templateLayers'
import { ConflictError, ForbiddenError, ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'

type TemplateRow = typeof capabilityTemplates.$inferSelect

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
 *
 * RFC-309 folds the old `frameworkDigest` and `bindingDigest` into one, because
 * a merge now compares one row against one row.
 */
export function templateDigest(row: {
  capability: string
  scriptsJson: string
  hooksJson: string
  paramSchemaJson: string
  paramDefaultsJson: string
  agentBySlotJson: string
  promptBySlotJson: string
  paramsJson: string
  stageContractVer: number
}): string {
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

/** Whether this actor may see — and write — script bodies. */
export function mayReadScripts(actor: Actor): boolean {
  return actor.permissions.has('scripts:author')
}

export function serializeTemplate(row: TemplateRow, actor: Actor): CapabilityTemplateWire {
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

  if (!mayReadScripts(actor)) {
    // The fields are ABSENT, and a flag says so. Returning `{}` would read as
    // "this template has no scripts", which is false for every template that
    // does anything, and would send the reader to fix a template that is fine.
    return { ...base, scriptsRedacted: true }
  }

  return {
    ...base,
    scripts: parseJson<NonNullable<CapabilityTemplateWire['scripts']>>(row.scriptsJson, {}),
    hooks: parseJson<NonNullable<CapabilityTemplateWire['hooks']>>(row.hooksJson, []),
    scriptsRedacted: false,
  }
}

export async function listTemplateRows(db: DbClient): Promise<TemplateRow[]> {
  return await db.select().from(capabilityTemplates)
}

export async function getTemplateRow(db: DbClient, id: string): Promise<TemplateRow | null> {
  return (
    (await db.select().from(capabilityTemplates).where(eq(capabilityTemplates.id, id)))[0] ?? null
  )
}

/**
 * The two-factor check, now scoped to the FIELDS that need it.
 *
 * `existing` is null on create, where any non-empty privileged field is a
 * write. On update the comparison is against what is stored, so re-saving a
 * template without touching its scripts is allowed for someone who cannot
 * author scripts — which is the whole point of the merge: swapping an agent
 * must not require the daemon.
 *
 * Note the REDACTION interaction: a reader without `scripts:author` never
 * received the script bodies, so their round-trip cannot carry them back. The
 * route re-fills those fields from the stored row before validating, so an
 * honest save from a redacted view is a no-op on them rather than a wipe.
 */
export function assertTemplateFieldsAllowed(
  actor: Actor,
  hasResourceWrite: boolean,
  input: Pick<CapabilityTemplateWrite, 'scripts' | 'hooks'>,
  existing: TemplateRow | null,
): void {
  if (!hasResourceWrite) {
    throw new ForbiddenError(
      'capability-template-forbidden',
      'you do not have write access to this capability template',
    )
  }
  const changed = TEMPLATE_PRIVILEGED_FIELDS.filter((field) => {
    const next = JSON.stringify(input[field])
    const before =
      existing === null ? null : field === 'scripts' ? existing.scriptsJson : existing.hooksJson
    if (before === null) return next !== (field === 'scripts' ? '{}' : '[]')
    return next !== before
  })
  if (changed.length === 0) return
  if (canWriteFramework({ hasResourceWrite, hasScriptsAuthor: mayReadScripts(actor) })) return
  throw new ForbiddenError(
    'capability-template-scripts-forbidden',
    // Names the field AND the grant: "forbidden" alone sends someone to ask for
    // the wrong permission, and the common case here is holding the resource
    // ACL and not `scripts:author`.
    `changing ${changed.join(' and ')} requires the scripts:author permission — those run with the daemon’s credentials`,
  )
}

async function assertNameFree(
  db: DbClient,
  ownerUserId: string | null,
  name: string,
  excludeId: string | null,
): Promise<void> {
  // Owner-scoped uniqueness, matching the unique index on the table. Checked
  // here so the caller gets a named error rather than a raw SQLite constraint
  // message with the index name in it.
  const clauses = [eq(capabilityTemplates.name, name)]
  clauses.push(
    ownerUserId === null
      ? eq(capabilityTemplates.ownerUserId, '')
      : eq(capabilityTemplates.ownerUserId, ownerUserId),
  )
  if (excludeId !== null) clauses.push(ne(capabilityTemplates.id, excludeId))
  const clash = await db
    .select({ id: capabilityTemplates.id })
    .from(capabilityTemplates)
    .where(and(...clauses))
    .limit(1)
  if (clash.length > 0) {
    throw new ConflictError(
      'capability-template-name-taken',
      `you already have one named '${name}'`,
    )
  }
}

function rowFromInput(
  input: CapabilityTemplateWrite,
  base: Pick<
    TemplateRow,
    'id' | 'ownerUserId' | 'visibility' | 'aclRevision' | 'builtin' | 'createdAt'
  > &
    Pick<TemplateRow, 'upstreamId' | 'upstreamVersion' | 'baseDigest'>,
  now: number,
): TemplateRow {
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

export async function createTemplate(
  db: DbClient,
  input: CapabilityTemplateWrite,
  actor: Actor,
  now = Date.now(),
): Promise<TemplateRow> {
  assertTemplateFieldsAllowed(actor, true, input, null)
  await assertNameFree(db, actor.user.id, input.name, null)

  const row = rowFromInput(
    input,
    {
      id: ulid(),
      ownerUserId: actor.user.id,
      // Private by default (RFC-099): a newly created resource is the creator's
      // until they say otherwise. A public default would publish every draft
      // template — including its scripts — to everyone the moment it is saved.
      visibility: input.visibility ?? 'private',
      aclRevision: 0,
      builtin: false,
      // Authored here, not copied — no origin, which is a normal state rather
      // than missing data.
      upstreamId: null,
      upstreamVersion: null,
      baseDigest: null,
      createdAt: now,
    },
    now,
  )
  await db.insert(capabilityTemplates).values(row)
  return row
}

export async function updateTemplate(
  db: DbClient,
  existing: TemplateRow,
  input: CapabilityTemplateWrite,
  actor: Actor,
  now = Date.now(),
): Promise<TemplateRow> {
  assertBuiltinImmutable(existing.builtin)
  assertTemplateFieldsAllowed(actor, true, input, existing)
  await assertNameFree(db, existing.ownerUserId, input.name, existing.id)

  const next = rowFromInput(
    input,
    {
      id: existing.id,
      ownerUserId: existing.ownerUserId,
      visibility: existing.visibility,
      aclRevision: existing.aclRevision,
      builtin: existing.builtin,
      upstreamId: existing.upstreamId,
      upstreamVersion: existing.upstreamVersion,
      baseDigest: existing.baseDigest,
      createdAt: existing.createdAt,
    },
    now,
  )
  await db.update(capabilityTemplates).set(next).where(eq(capabilityTemplates.id, existing.id))
  return next
}

/**
 * Copy a template, so a team can start from one that works.
 *
 * After RFC-309 this is the PRIMARY way a team gets a template — the shared
 * department framework is gone, so "everyone uses the same scripts" is now
 * "everyone copied from the same place and can see when it moves".
 *
 * The copy is owned by whoever made it and starts PRIVATE regardless of the
 * source's visibility: copying a public template must not publish the copy,
 * which will be edited before it is fit to share.
 *
 * Copying does NOT require `scripts:author`. The copier receives the scripts
 * unchanged and cannot alter them without the grant, so the bytes that run as
 * the daemon are still exactly the ones an authorised author wrote.
 */
export async function copyTemplate(
  db: DbClient,
  source: TemplateRow,
  actor: Actor,
  name: string | undefined,
  now = Date.now(),
): Promise<TemplateRow> {
  const copyName = name ?? `${source.name} copy`
  await assertNameFree(db, actor.user.id, copyName, null)

  const row: TemplateRow = {
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
    baseDigest: templateDigest(source),
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(capabilityTemplates).values(row)
  return row
}

export async function deleteTemplate(db: DbClient, row: TemplateRow): Promise<void> {
  assertBuiltinImmutable(row.builtin)
  // RFC-309: there is no dependent template layer to refuse for any more — the
  // old `capability-framework-in-use` guard existed because a binding pointed at
  // a framework. Matrix cells referencing this template are handled by the
  // readiness path, which reports `binding-missing` and offers a repair, rather
  // than by blocking the delete.
  await db.delete(capabilityTemplates).where(eq(capabilityTemplates.id, row.id))
}

function assertBuiltinImmutable(builtin: boolean): void {
  if (!builtin) return
  throw new ValidationError(
    'capability-template-builtin',
    'this template ships with the platform; copy it and edit the copy',
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
// Reusing the same row builder as the HTTP path rather than a parallel set: a
// package is another way to write the same row, and two writers that drift are
// how an imported template ends up subtly unlike a created one.

export interface PreparedTemplateWrite {
  row: TemplateRow
  /** Present for an update; the row being replaced. */
  existing: TemplateRow | null
}

/**
 * Validate a template write from a package.
 *
 * The field-level check runs HERE as well as at the HTTP route, and that is not
 * belt-and-braces: the package path never passes through the route, so leaving
 * it to the route would make an import a way around the rule rather than
 * another way to use it.
 */
export async function prepareTemplateFromBundle(
  db: DbClient,
  input: CapabilityTemplateWrite & { id: string },
  actor: Actor,
  existingId: string | null,
  now = Date.now(),
): Promise<PreparedTemplateWrite> {
  const existing = existingId === null ? null : await getTemplateRow(db, existingId)
  if (existingId !== null && existing === null) {
    throw new ValidationError(
      'capability-template-not-found',
      `template '${existingId}' no longer exists`,
    )
  }
  if (existing !== null) assertBuiltinImmutable(existing.builtin)
  assertTemplateFieldsAllowed(actor, true, input, existing)
  await assertNameFree(db, existing?.ownerUserId ?? actor.user.id, input.name, existing?.id ?? null)

  return {
    existing,
    row: rowFromInput(
      input,
      {
        id: existing?.id ?? input.id,
        // An import lands as the IMPORTER's private resource, never carrying
        // the source instance's owner across: that user id means nothing here,
        // and a package that could set visibility would publish somebody else's
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
      },
      now,
    ),
  }
}

export function commitTemplateInTx(tx: DbTxSync, prepared: PreparedTemplateWrite): void {
  if (prepared.existing === null) {
    tx.insert(capabilityTemplates).values(prepared.row).run()
    return
  }
  tx.update(capabilityTemplates)
    .set(prepared.row)
    .where(eq(capabilityTemplates.id, prepared.row.id))
    .run()
}

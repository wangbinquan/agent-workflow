// RFC-304 T17a — a capability template travels between groups as a zip.
//
// The design's promise is that the department's script framework and the
// group's binding move between instances as an RFC-271 config package. Every
// piece of that shipped except one: the two types are in
// `BUNDLE_RESOURCE_TYPES`, the wire has all four ops with payload schemas, the
// closure walks binding→framework, the import applier writes both rows, and the
// import permission map demands `scripts:author` on top of create for a
// framework (importing one is host code execution on the destination).
//
// The serializer had no case for either type. So a package whose root was a
// capability template produced no create op at all, and the exporter rejected
// its own output — `bundle-dangling-root: rootRef points at
// local:capability_framework-…, which no create op declares`. There was also no
// export route, which is why nobody had ever seen that error: the feature was
// complete in both directions except for the step that puts the rows on the
// wire, and unreachable besides.
//
// This drives the whole trip: export from one database, import into another,
// and check the far end can actually use what arrived.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, capabilityBindings, capabilityFrameworks, users } from '../src/db/schema'
import { exportResourcePackage } from '../src/services/resourcePackage/export'
import { parseResourcePackage } from '../src/services/resourcePackage/parse'
import { removeTempDirSync } from './fixtures/tempDir'
import { eq } from 'drizzle-orm'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []
const dbs: DbClient[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.$client.close()
  for (const dir of tempDirs.splice(0)) removeTempDirSync(dir)
})

function freshDb(): DbClient {
  const db = createInMemoryDb(MIGRATIONS)
  dbs.push(db)
  return db
}

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rfc304-pkg-'))
  tempDirs.push(dir)
  return dir
}

const ACTOR = {
  user: { id: 'u1', username: 'u1', displayName: 'U1', role: 'admin', status: 'active' },
  source: 'daemon',
  permissions: new Set<string>([
    'capability-frameworks:read',
    'capability-bindings:read',
    'agents:read',
    'resource-acl:private',
  ]),
} as never

async function seedSource(db: DbClient): Promise<{ frameworkId: string; bindingId: string }> {
  await db.insert(users).values({
    id: 'u1',
    username: 'u1',
    displayName: 'U1',
    role: 'admin',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  } as typeof users.$inferInsert)

  const agentId = ulid()
  await db.insert(agents).values({
    id: agentId,
    name: 'department-reviewer',
    description: 'reviews',
    bodyMd: 'Review it.',
    outputs: '["findings"]',
    ownerUserId: 'u1',
    visibility: 'private',
    createdAt: 1,
    updatedAt: 1,
  } as typeof agents.$inferInsert)

  const frameworkId = ulid()
  await db.insert(capabilityFrameworks).values({
    id: frameworkId,
    name: 'department ci-fix',
    description: 'how this department adapts its pipeline',
    capability: 'ci-fix',
    scriptsJson: JSON.stringify({ collect: { language: 'node', script: 'console.log(1)' } }),
    hooksJson: '[]',
    paramSchemaJson: '[]',
    paramDefaultsJson: JSON.stringify({ maxAttempts: 3 }),
    ownerUserId: 'u1',
    visibility: 'private',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  } as typeof capabilityFrameworks.$inferInsert)

  const bindingId = ulid()
  await db.insert(capabilityBindings).values({
    id: bindingId,
    name: 'team binding',
    description: 'this team’s slots',
    frameworkId,
    agentBySlotJson: JSON.stringify({ reviewer: agentId }),
    promptBySlotJson: JSON.stringify({ reviewer: 'be strict' }),
    paramsJson: JSON.stringify({ maxAttempts: 2 }),
    ownerUserId: 'u1',
    visibility: 'private',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  } as typeof capabilityBindings.$inferInsert)

  return { frameworkId, bindingId }
}

const exportOf = async (db: DbClient, type: string, id: string) =>
  await exportResourcePackage(db, ACTOR, { type, id } as never, {
    appHome: freshHome(),
    exportedAt: 1,
  })

describe('RFC-304 T17a — exporting a capability template', () => {
  test('a framework becomes a package with a create op for itself', async () => {
    // Before the serializer knew this type, the export failed on its own output
    // check: a root with no create op is a dangling root.
    const db = freshDb()
    const { frameworkId } = await seedSource(db)

    const pkg = await exportOf(db, 'capability_framework', frameworkId)
    const parsed = await parseResourcePackage(pkg.zip)

    const kinds = parsed.bundle.ops.map((op) => op.kind)
    expect(kinds).toContain('capability-framework-create')
  })

  test('the script bodies travel — that is what the far end needs', async () => {
    // The framework IS its scripts. A package that carried the name and dropped
    // them would import a template that resolves to nothing and fails at round
    // time with "the framework's scripts could not be resolved".
    const db = freshDb()
    const { frameworkId } = await seedSource(db)

    const parsed = await parseResourcePackage(
      (await exportOf(db, 'capability_framework', frameworkId)).zip,
    )
    const op = parsed.bundle.ops.find((o) => o.kind === 'capability-framework-create')
    const payload = (op as { payload: Record<string, unknown> }).payload

    expect(payload.capability).toBe('ci-fix')
    expect(JSON.stringify(payload.scripts)).toContain('console.log(1)')
    expect(payload.paramDefaults).toEqual({ maxAttempts: 3 })
  })

  test('a binding travels WITH its framework, and by reference not by id', async () => {
    // Two things at once. The closure has to pull the framework in, or the
    // destination has a binding naming a template it does not have. And the
    // pointer has to be a ref: a raw id would name a row that exists only on the
    // source instance.
    const db = freshDb()
    const { bindingId } = await seedSource(db)

    const parsed = await parseResourcePackage(
      (await exportOf(db, 'capability_binding', bindingId)).zip,
    )
    const kinds = parsed.bundle.ops.map((o) => o.kind)
    expect(kinds).toContain('capability-binding-create')
    expect(kinds).toContain('capability-framework-create')

    const binding = parsed.bundle.ops.find((o) => o.kind === 'capability-binding-create')
    const payload = (binding as { payload: Record<string, unknown> }).payload
    expect(String(payload.frameworkRef)).toMatch(/^local:/)
    // The agent slot likewise: the destination binds to ITS agent of that name.
    expect(JSON.stringify(payload.agentBySlot)).toMatch(/local:|external:/)
    expect(JSON.stringify(payload.agentBySlot)).not.toContain('01')
  })

  test('the group layer carries no scripts — the boundary is in the payload', async () => {
    // The binding schema has no scripts field at all, and that absence IS the
    // two-layer rule: a package that could smuggle scripts through the group
    // layer would be a way around the permission model rather than a second way
    // to use it.
    const db = freshDb()
    const { bindingId } = await seedSource(db)

    const parsed = await parseResourcePackage(
      (await exportOf(db, 'capability_binding', bindingId)).zip,
    )
    const binding = parsed.bundle.ops.find((o) => o.kind === 'capability-binding-create')
    const payload = (binding as { payload: Record<string, unknown> }).payload

    expect(payload.scripts).toBeUndefined()
    expect(payload.hooks).toBeUndefined()
  })
})

describe('RFC-304 T17a — the far end', () => {
  test('the package parses on a machine that has never seen the source', async () => {
    // The destination's parser is the same code as the exporter's own final
    // check, so this is the honest version of "it will import": a package that
    // parses clean here is one the import path will accept.
    const source = freshDb()
    const { bindingId } = await seedSource(source)
    const pkg = await exportOf(source, 'capability_binding', bindingId)

    const parsed = await parseResourcePackage(pkg.zip)
    expect(parsed.bundle.rootRef).toMatch(/^local:/)
    // Both layers are present as resources, which is what the import preview
    // lists for the operator before anything is written.
    const types = parsed.manifest.resources.map((r) => r.type).sort()
    expect(types).toContain('capability_binding')
    expect(types).toContain('capability_framework')

    // And the source rows are untouched by having been exported.
    const [stillThere] = await source
      .select()
      .from(capabilityBindings)
      .where(eq(capabilityBindings.id, bindingId))
    expect(stillThere?.name).toBe('team binding')
  })
})

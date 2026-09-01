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
import { agents, capabilityTemplates, users } from '../src/db/schema'
import { lowerBundlePayloads } from '../src/services/bundle/lower'
import { opSlug, resourceTypeOfOp, type BundleApplyProvider } from '../src/services/bundle/provider'
import { translateDecisions } from '../src/services/resourcePackage/commit'
import { parseResourcePackage } from '../src/services/resourcePackage/parse'
import { removeTempDirSync } from './fixtures/tempDir'
import { exportResourcePackage } from './helpers/resourcePackageProvider'
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
    'capability-templates:read',
    'capability-templates:read',
    'agents:read',
    'resource-acl:private',
  ]),
} as never

async function seedSource(db: DbClient): Promise<{ templateId: string }> {
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

  // RFC-309 — one template carries both halves. The pair this replaced existed
  // so a package had to pull the framework along with the binding; there is
  // nothing left to dangle.
  const templateId = ulid()
  await db.insert(capabilityTemplates).values({
    id: templateId,
    name: 'team ci-fix',
    description: 'scripts and slots in one row',
    capability: 'ci-fix',
    scriptsJson: JSON.stringify({ collect: { language: 'node', script: 'console.log(1)' } }),
    hooksJson: '[]',
    paramSchemaJson: '[]',
    paramDefaultsJson: JSON.stringify({ maxAttempts: 3 }),
    agentBySlotJson: JSON.stringify({ reviewer: agentId }),
    promptBySlotJson: JSON.stringify({ reviewer: 'be strict' }),
    paramsJson: JSON.stringify({ maxAttempts: 2 }),
    ownerUserId: 'u1',
    visibility: 'private',
    createdAt: 1,
    updatedAt: 1,
  } as typeof capabilityTemplates.$inferInsert)

  return { templateId }
}

const exportOf = async (db: DbClient, type: string, id: string) =>
  await exportResourcePackage(db, ACTOR, { type, id } as never, {
    appHome: freshHome(),
    exportedAt: 1,
  })

describe('RFC-304 T17a → RFC-309 — exporting a capability template', () => {
  test('a template becomes a package with ONE create op for itself', async () => {
    // Before the serializer knew this type, the export failed on its own output
    // check: a root with no create op is a dangling root. RFC-309 makes it one
    // op instead of two, because a template is one row.
    const db = freshDb()
    const { templateId } = await seedSource(db)

    const parsed = await parseResourcePackage(
      (await exportOf(db, 'capability_template', templateId)).zip,
    )
    const kinds = parsed.bundle.ops.map((op) => op.kind)
    expect(kinds).toContain('capability-template-create')
    // And the pair it replaced is not produced any more: two ways to write the
    // same row is how the two drift.
    expect(kinds).not.toContain('capability-framework-create')
    expect(kinds).not.toContain('capability-binding-create')
  })

  test('the script bodies travel — that is what the far end needs', async () => {
    // A package that carried the name and dropped them would import a template
    // that resolves to nothing and fails at round time with "the template's
    // scripts could not be resolved".
    const db = freshDb()
    const { templateId } = await seedSource(db)

    const parsed = await parseResourcePackage(
      (await exportOf(db, 'capability_template', templateId)).zip,
    )
    const op = parsed.bundle.ops.find((o) => o.kind === 'capability-template-create')
    const payload = (op as { payload: Record<string, unknown> }).payload

    expect(payload.capability).toBe('ci-fix')
    expect(JSON.stringify(payload.scripts)).toContain('console.log(1)')
    expect(payload.paramDefaults).toEqual({ maxAttempts: 3 })
  })

  test('the agents travel by REFERENCE, not by id', async () => {
    // A raw id would name a row that exists only on the source instance. The
    // `frameworkRef` this test used to also check is gone with the merge — the
    // scripts are in the same payload now, so there is no second row to point
    // at and no way for that pointer to dangle at the far end.
    const db = freshDb()
    const { templateId } = await seedSource(db)

    const parsed = await parseResourcePackage(
      (await exportOf(db, 'capability_template', templateId)).zip,
    )
    const op = parsed.bundle.ops.find((o) => o.kind === 'capability-template-create')
    const payload = (op as { payload: Record<string, unknown> }).payload

    expect(JSON.stringify(payload.agentBySlot)).toMatch(/local:|external:/)
    expect(JSON.stringify(payload.agentBySlot)).not.toContain('01')
    // No dangling pointer to another template: the closure has nothing left to
    // pull in but the agents.
    expect(payload.frameworkRef).toBeUndefined()
  })

  test('the whole configuration travels in one payload', async () => {
    // The half that used to be the binding's — the boundary is not in the
    // payload any more, it is the `scripts:author` check the import path runs
    // when the payload actually carries script bodies.
    const db = freshDb()
    const { templateId } = await seedSource(db)

    const parsed = await parseResourcePackage(
      (await exportOf(db, 'capability_template', templateId)).zip,
    )
    const op = parsed.bundle.ops.find((o) => o.kind === 'capability-template-create')
    const payload = (op as { payload: Record<string, unknown> }).payload

    expect(payload.promptBySlot).toEqual({ reviewer: 'be strict' })
    expect(payload.params).toEqual({ maxAttempts: 2 })
  })

  test('a reused destination agent is rewritten and lowered into the imported template', async () => {
    const source = freshDb()
    const { templateId } = await seedSource(source)
    const parsed = await parseResourcePackage(
      (await exportOf(source, 'capability_template', templateId)).zip,
    )
    const templateOp = parsed.bundle.ops.find(
      (op) => resourceTypeOfOp(op) === 'capability_template',
    )
    const agentOp = parsed.bundle.ops.find((op) => resourceTypeOfOp(op) === 'agent')
    const templateSlug = templateOp === undefined ? null : opSlug(templateOp)
    const agentSlug = agentOp === undefined ? null : opSlug(agentOp)
    expect(templateSlug).not.toBeNull()
    expect(agentSlug).not.toBeNull()

    const destinationAgentId = ulid()
    const translated = translateDecisions(
      parsed,
      [
        { localSlug: templateSlug!, action: 'new', finalName: 'imported ci-fix' },
        { localSlug: agentSlug!, action: 'reuse', targetId: destinationAgentId },
      ],
      new Map(),
    )
    const translatedTemplate = translated.ops.find(
      (op) => resourceTypeOfOp(op) === 'capability_template',
    )
    expect((translatedTemplate?.payload as { agentBySlot?: unknown }).agentBySlot).toEqual({
      reviewer: `external:${destinationAgentId}`,
    })

    const destination = freshDb()
    await destination.insert(agents).values({
      id: destinationAgentId,
      name: 'department-reviewer',
      description: 'destination agent',
      bodyMd: 'Review it.',
      outputs: '["findings"]',
      ownerUserId: null,
      visibility: 'public',
      createdAt: 1,
      updatedAt: 1,
    } as typeof agents.$inferInsert)
    const provider: BundleApplyProvider = {
      idempotencyKey: { scope: 'test', key: ulid() },
      serializationKey: ulid(),
      actor: ACTOR,
      resolveExternal: async (ref, type) => {
        expect(ref).toBe(`external:${destinationAgentId}`)
        expect(type).toBe('agent')
        return destinationAgentId
      },
      readSkillFile: () => new Uint8Array(),
    }
    const lowered = await lowerBundlePayloads(destination, translated.ops, provider)
    const loweredTemplate = lowered.find((op) => op.resourceType === 'capability_template')
    expect(loweredTemplate?.payload.agentBySlot).toEqual({ reviewer: destinationAgentId })
  })
})

describe('RFC-304 T17a — the far end', () => {
  test('the package parses on a machine that has never seen the source', async () => {
    // The destination's parser is the same code as the exporter's own final
    // check, so this is the honest version of "it will import": a package that
    // parses clean here is one the import path will accept.
    const source = freshDb()
    const { templateId } = await seedSource(source)
    const pkg = await exportOf(source, 'capability_template', templateId)

    const parsed = await parseResourcePackage(pkg.zip)
    expect(parsed.bundle.rootRef).toMatch(/^local:/)
    // One template resource plus the agent it uses — which is what the import
    // preview lists for the operator before anything is written. RFC-309: this
    // used to be two template resources, and the pair could arrive incomplete.
    const types = parsed.manifest.resources.map((r) => r.type).sort()
    expect(types).toContain('capability_template')
    expect(types.filter((t) => t === 'capability_template')).toHaveLength(1)

    // And the source row is untouched by having been exported.
    const [stillThere] = await source
      .select()
      .from(capabilityTemplates)
      .where(eq(capabilityTemplates.id, templateId))
    expect(stillThere?.name).toBe('team ci-fix')
  })
})

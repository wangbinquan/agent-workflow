// RFC-304 T47 — a cell's effective parameters, against a real database.
//
// The shared validator is tested in `shared/tests/rfc304-capability-params`;
// this file is about the CHAIN: framework table + framework defaults + binding
// overrides → what the scripts actually read.
//
// The case worth the most here is the one that only appears over time. A
// binding validated when it was saved becomes invalid later without anyone
// touching it — the framework's author adds a required parameter, or renames
// one — and every binding pointing at it is now wrong. Validating only on save
// lets those run with a missing parameter and fail somewhere deep, on
// somebody's merge request.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { capabilityTemplates, repoCapabilityConfig } from '../src/db/schema'
import { resolveCellParams } from '../src/services/codeCapabilityParams'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const REPO = 'repo-1'
const NOW = 1_700_000_000_000

const TABLE = JSON.stringify([
  { name: 'triggerLabel', kind: 'string', required: true },
  { name: 'maxAttempts', kind: 'number', min: 1, max: 10 },
  { name: 'strategy', kind: 'enum', options: ['fast', 'thorough'] },
])

describe('RFC-304 T47 — resolving a cell’s parameters', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  const seed = async (over: {
    paramSchemaJson?: string
    paramDefaultsJson?: string
    paramsJson?: string
  }): Promise<void> => {
    await db.insert(capabilityTemplates).values({
      id: 'binding-1',
      name: 'binding-1',
      paramsJson: over.paramsJson ?? '{}',
      createdAt: NOW,
      updatedAt: NOW,
      capability: 'requirement',
      paramSchemaJson: over.paramSchemaJson ?? TABLE,
      paramDefaultsJson: over.paramDefaultsJson ?? '{}',
    })
    await db.insert(repoCapabilityConfig).values({
      id: ulid(),
      repoId: REPO,
      capability: 'requirement',
      templateId: 'binding-1',
      enabled: true,
      readiness: 'ready',
      createdAt: NOW,
      updatedAt: NOW,
    })
  }

  const params = () => resolveCellParams(db, { repoId: REPO, capability: 'requirement' })

  test('defaults flow through, and the binding overrides only what it names', async () => {
    await seed({
      paramDefaultsJson: JSON.stringify({
        triggerLabel: 'aw:implement',
        maxAttempts: 3,
        strategy: 'fast',
      }),
      paramsJson: JSON.stringify({ strategy: 'thorough' }),
    })

    const out = await params()
    expect(out.ok).toBe(true)
    // Whole-object replacement would blank the other two, silently: the script
    // reads undefined and behaves as though nothing was configured.
    expect(out.ok && out.params).toEqual({
      triggerLabel: 'aw:implement',
      maxAttempts: 3,
      strategy: 'thorough',
    })
  })

  test('an override the framework does not declare is reported', async () => {
    await seed({
      paramDefaultsJson: JSON.stringify({ triggerLabel: 'aw:implement' }),
      paramsJson: JSON.stringify({ renamedAgesAgo: 'x' }),
    })

    const out = await params()
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.issues[0]?.field).toBe('renamedAgesAgo')
  })

  test('an out-of-range override is reported with its bound', async () => {
    await seed({
      paramDefaultsJson: JSON.stringify({ triggerLabel: 'x' }),
      paramsJson: JSON.stringify({ maxAttempts: 99 }),
    })

    const out = await params()
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.issues[0]?.message).toContain('at most 10')
  })

  test('a required parameter nobody sets is reported — the case that appears LATER', async () => {
    // The binding is empty and passes validation on its own; the framework's
    // required parameter has no default. Validating the overrides alone would
    // miss it, and the script would read undefined on somebody's merge request.
    await seed({ paramDefaultsJson: '{}', paramsJson: '{}' })

    const out = await params()
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.issues[0]?.field).toBe('triggerLabel')
    expect(out.ok === false && out.issues[0]?.message).toContain(
      'neither the framework nor this binding',
    )
  })

  test('a framework default satisfies a required parameter', async () => {
    await seed({ paramDefaultsJson: JSON.stringify({ triggerLabel: 'aw:implement' }) })
    const out = await params()
    expect(out.ok).toBe(true)
    expect(out.ok && out.params.triggerLabel).toBe('aw:implement')
  })

  test('a malformed table is reported rather than read as "no parameters"', async () => {
    // Read as empty, every binding would pass and every script would read
    // undefined — with the matrix reporting the cell as healthy.
    await seed({ paramSchemaJson: '{not json' })
    const out = await params()
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.issues[0]?.message).toContain('not valid JSON')
  })

  test('the column default `{}` means no parameters', async () => {
    await seed({ paramSchemaJson: '{}' })
    expect(await params()).toEqual({ ok: true, table: [], params: {} })
  })

  test('a cell with no binding resolves empty rather than reporting a param problem', async () => {
    // "No binding" is a configuration state the readiness check already
    // reports; repeating it here would point the operator at the wrong field.
    await db.insert(repoCapabilityConfig).values({
      id: ulid(),
      repoId: 'repo-2',
      capability: 'requirement',
      enabled: true,
      readiness: 'misconfigured',
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(await resolveCellParams(db, { repoId: 'repo-2', capability: 'requirement' })).toEqual({
      ok: true,
      table: [],
      params: {},
    })
  })

  test('another repository’s cell does not supply these parameters', async () => {
    // The `and(...)` guard. With a JS `&&` the repo filter vanishes and one
    // team's parameters resolve from whichever cell sorted first.
    await seed({ paramDefaultsJson: JSON.stringify({ triggerLabel: 'mine' }) })

    const other = await resolveCellParams(db, {
      repoId: 'repo-elsewhere',
      capability: 'requirement',
    })
    expect(other).toEqual({ ok: true, table: [], params: {} })
  })
})

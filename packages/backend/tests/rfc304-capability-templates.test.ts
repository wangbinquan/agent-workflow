// RFC-304 T57 — the two template layers, over HTTP.
//
// These routes are the JOIN that `domain/templateLayers.ts` was waiting for
// since PR-2: `rejectFrameworkOnlyFields` and `canWriteFramework` had zero
// callers repo-wide, so the layer boundary they describe was a comment. A rule
// with no call site never fails a test, which is why nothing was red.
//
// What the tests are about, in order of how much damage the alternative does:
//
//   1. a framework write needs BOTH resource write access and `scripts:author`.
//      Either alone is a way around the other, and the "granted the framework,
//      not a script author" case is the one a real deployment produces.
//   2. a framework read REDACTS script bodies rather than withholding the
//      framework. Withholding would make the group layer unusable without
//      handing out the department layer — the split's whole purpose.
//   3. a binding payload carrying `scripts` or `hooks` is REJECTED with a
//      message naming the layer. Stripping it silently is how a team comes to
//      believe their gate runs when it never has.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { capabilityBindings, capabilityFrameworks } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import {
  assertMayWriteFramework,
  copyFramework,
  createBinding,
  createFramework,
  deleteFramework,
  getFrameworkRow,
  serializeFramework,
  updateFramework,
} from '../src/services/capabilityTemplates'
import { SYSTEM_DOMAIN_POINTS, type Permission } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

const actorWith = (id: string, points: Permission[]): Actor =>
  ({
    user: { id, name: id, role: 'user' },
    permissions: new Set<Permission>(points),
    source: 'session',
  }) as unknown as Actor

const AUTHOR = actorWith('u-author', [
  'capability-frameworks:create',
  'capability-frameworks:update',
  'capability-frameworks:delete',
  'scripts:author',
])
/** Holds the resource points but NOT `scripts:author` — the real-world case. */
const NOT_AN_AUTHOR = actorWith('u-lead', [
  'capability-frameworks:create',
  'capability-frameworks:update',
  'capability-bindings:create',
])

const FRAMEWORK_INPUT = {
  name: 'gitlab standard',
  description: null,
  capability: 'mr-review',
  scripts: { collect: { language: 'node' as const, script: 'console.log(1)' } },
  hooks: [],
  paramSchema: [],
  paramDefaults: {},
  stageContractVer: 1,
}

describe('RFC-304 T57 — a framework write needs BOTH factors', () => {
  test('resource write alone is refused, and the message names the missing one', () => {
    // The common real case: someone was granted the framework and assumes that
    // is enough. "Forbidden" alone would send them to ask for the wrong grant.
    expect(() => assertMayWriteFramework(NOT_AN_AUTHOR, true)).toThrow(/scripts:author/)
  })

  test('scripts:author alone is refused too', () => {
    // The other direction, and the reason the check is an AND rather than an
    // OR: a script author must not be able to edit a framework they have no
    // resource access to, or `scripts:author` would bypass the ACL entirely.
    const authorNoAcl = actorWith('u-x', ['scripts:author'])
    expect(() => assertMayWriteFramework(authorNoAcl, false)).toThrow()
  })

  test('both together pass', () => {
    expect(() => assertMayWriteFramework(AUTHOR, true)).not.toThrow()
  })
})

describe('RFC-304 T57 — framework reads redact rather than withhold', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('a non-author sees the framework, its params, and NO script bodies', async () => {
    const row = await createFramework(db, FRAMEWORK_INPUT, AUTHOR, NOW)
    const wire = serializeFramework(row, NOT_AN_AUTHOR)

    // Visible enough to bind: name, capability and parameters are what a group
    // lead needs to choose one.
    expect(wire.name).toBe('gitlab standard')
    expect(wire.capability).toBe('mr-review')
    // Absent, not empty. `{}` would read as "this framework has no scripts",
    // which is false and sends the reader to fix a template that is fine.
    expect(wire.scripts).toBeUndefined()
    expect(wire.hooks).toBeUndefined()
    expect(wire.scriptsRedacted).toBe(true)
  })

  test('an author sees the script bodies', async () => {
    const row = await createFramework(db, FRAMEWORK_INPUT, AUTHOR, NOW)
    const wire = serializeFramework(row, AUTHOR)

    expect(wire.scriptsRedacted).toBe(false)
    expect(wire.scripts?.collect?.script).toBe('console.log(1)')
  })
})

describe('RFC-304 T57 — creation and copying', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('a new framework is PRIVATE by default', async () => {
    // A public default would publish every draft — script bodies included — to
    // everyone the moment it is first saved.
    const row = await createFramework(db, FRAMEWORK_INPUT, AUTHOR, NOW)
    expect(row.visibility).toBe('private')
    expect(row.ownerUserId).toBe('u-author')
  })

  test('a copy is owned by the copier and is private even from a public source', async () => {
    const source = await createFramework(
      db,
      { ...FRAMEWORK_INPUT, visibility: 'public' as const },
      AUTHOR,
      NOW,
    )
    const other = actorWith('u-two', ['capability-frameworks:create', 'scripts:author'])
    const copy = await copyFramework(db, source, other, undefined, NOW)

    expect(copy.ownerUserId).toBe('u-two')
    // Copying a public framework must not publish the copy — it will be edited
    // before it is fit to share.
    expect(copy.visibility).toBe('private')
    expect(copy.name).toBe('gitlab standard copy')
    // The scripts came with it; that is the point of copying one.
    expect(copy.scriptsJson).toBe(source.scriptsJson)
  })

  test('a copy of a built-in is an ordinary resource', async () => {
    // Carrying the flag across would make the copy uneditable, which defeats
    // the only reason to copy a built-in.
    await db.insert(capabilityFrameworks).values({
      id: 'fw-builtin',
      name: 'shipped',
      capability: 'mr-review',
      scriptsJson: '{}',
      hooksJson: '[]',
      paramSchemaJson: '[]',
      paramDefaultsJson: '{}',
      stageContractVer: 1,
      ownerUserId: null,
      visibility: 'public',
      aclRevision: 0,
      builtin: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const source = await getFrameworkRow(db, 'fw-builtin')
    const copy = await copyFramework(db, source!, AUTHOR, 'mine', NOW)
    expect(copy.builtin).toBe(false)
  })

  test('a built-in cannot be edited in place', async () => {
    await db.insert(capabilityFrameworks).values({
      id: 'fw-builtin',
      name: 'shipped',
      capability: 'mr-review',
      scriptsJson: '{}',
      hooksJson: '[]',
      paramSchemaJson: '[]',
      paramDefaultsJson: '{}',
      stageContractVer: 1,
      ownerUserId: null,
      visibility: 'public',
      aclRevision: 0,
      builtin: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const row = await getFrameworkRow(db, 'fw-builtin')
    await expect(updateFramework(db, row!, FRAMEWORK_INPUT, AUTHOR, NOW)).rejects.toThrow(/copy it/)
  })

  test('two frameworks of one owner cannot share a name', async () => {
    await createFramework(db, FRAMEWORK_INPUT, AUTHOR, NOW)
    await expect(createFramework(db, FRAMEWORK_INPUT, AUTHOR, NOW)).rejects.toThrow(/already have/)
  })

  test('two OWNERS may each have one of the same name', async () => {
    // Owner-scoped, not global: one team naming their template "standard" must
    // not stop another team from doing the same.
    const other = actorWith('u-two', ['capability-frameworks:create', 'scripts:author'])
    await createFramework(db, FRAMEWORK_INPUT, AUTHOR, NOW)
    await expect(createFramework(db, FRAMEWORK_INPUT, other, NOW)).resolves.toBeDefined()
  })
})

describe('RFC-304 T57 — deleting a framework something still uses', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('a framework with a dependent binding is refused', async () => {
    // Deleting anyway leaves every dependent cell reporting `framework-missing`
    // — a readiness state naming a cause its owner did not create and cannot
    // undo, because the thing to point back at is gone.
    const fw = await createFramework(db, FRAMEWORK_INPUT, AUTHOR, NOW)
    await createBinding(
      db,
      {
        name: 'team binding',
        description: null,
        frameworkId: fw.id,
        agentBySlot: {},
        promptBySlot: {},
        params: {},
      },
      NOT_AN_AUTHOR,
      NOW,
    )

    await expect(deleteFramework(db, fw)).rejects.toThrow(/still references/)
  })

  test('a framework nothing references deletes cleanly', async () => {
    const fw = await createFramework(db, FRAMEWORK_INPUT, AUTHOR, NOW)
    await deleteFramework(db, fw)
    expect(await getFrameworkRow(db, fw.id)).toBeNull()
  })
})

describe('RFC-304 T57 — a binding cannot reach the daemon surface', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('the binding TABLE has no column for scripts or hooks', async () => {
    // The first line of the boundary, and the one that holds even against a raw
    // SQL writer. The route-level rejection is the second line; this asserts
    // the first still exists, because a migration could quietly add a column
    // and nothing else here would notice.
    const columns = Object.keys(capabilityBindings)
    expect(columns).not.toContain('scriptsJson')
    expect(columns).not.toContain('hooksJson')
  })

  test('a binding names a framework that must exist', async () => {
    await expect(
      createBinding(
        db,
        {
          name: 'orphan',
          description: null,
          frameworkId: 'fw-nope',
          agentBySlot: {},
          promptBySlot: {},
          params: {},
        },
        NOT_AN_AUTHOR,
        NOW,
      ),
    ).rejects.toThrow(/no capability framework/)
  })

  test('a group lead with NO scripts:author can create a binding', async () => {
    // The property the whole two-layer split exists for: the group layer is
    // usable by someone who was never handed the daemon's credentials.
    const fw = await createFramework(db, FRAMEWORK_INPUT, AUTHOR, NOW)
    const binding = await createBinding(
      db,
      {
        name: 'team binding',
        description: null,
        frameworkId: fw.id,
        agentBySlot: { reviewer: 'agent-1' },
        promptBySlot: {},
        params: {},
      },
      NOT_AN_AUTHOR,
      NOW,
    )
    expect(binding.ownerUserId).toBe('u-lead')
    expect(binding.visibility).toBe('private')
  })
})

// The routes themselves, driven through a real app.
//
// `route-error-code-coverage` requires every route error code to be named by
// some test. Naming them in a list of tautologies would satisfy that guard and
// prove nothing — so each one is REACHED here instead, which also pins the
// status codes a client branches on.
describe('RFC-304 T57 — the template routes', () => {
  const TOKEN = 'a'.repeat(64)
  let db: DbClient

  const appWith = () =>
    createApp({ token: TOKEN, configPath: '', opencodeVersion: '1.14.25', dbVersion: 1, db })

  const call = async (path: string, init?: RequestInit) =>
    await appWith().request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('a binding carrying `hooks` is refused with the LAYER message', async () => {
    // The join this whole PR is about. Zod's `.strict()` would also refuse it,
    // with "unrecognized key" — which tells an author their JSON is malformed
    // when their JSON is fine and their model of the two layers is not.
    const res = await call('/api/capability-bindings', {
      method: 'POST',
      body: JSON.stringify({
        name: 'sneaky',
        frameworkId: 'fw-1',
        hooks: [{ stage: 'publish', phase: 'pre', script: 'curl $SECRET_URL' }],
      }),
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as { code?: string; message?: string }
    expect(body.code).toBe('binding-carries-framework-only-field')
    // The message has to name the LAYER and why, or the author just deletes the
    // field and never learns where hooks actually belong.
    expect(body.message).toMatch(/framework/i)
    expect(body.message).toMatch(/scripts:author/)
  })

  test('a binding carrying `scripts` is refused the same way', async () => {
    const res = await call('/api/capability-bindings', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', frameworkId: 'fw-1', scripts: { collect: {} } }),
    })
    expect(((await res.json()) as { code?: string }).code).toBe(
      'binding-carries-framework-only-field',
    )
  })

  test('a binding naming a framework that does not exist is refused', async () => {
    const res = await call('/api/capability-bindings', {
      method: 'POST',
      body: JSON.stringify({ name: 'orphan', frameworkId: 'fw-nope' }),
    })
    expect(((await res.json()) as { code?: string }).code).toBe('capability-framework-not-found')
  })

  test('a malformed binding payload is refused as invalid', async () => {
    const res = await call('/api/capability-bindings', {
      method: 'POST',
      body: JSON.stringify({ frameworkId: 'fw-1' }),
    })
    expect(((await res.json()) as { code?: string }).code).toBe('capability-binding-invalid')
  })

  test('an absent binding 404s rather than 403s', async () => {
    // Invisible and missing must be indistinguishable, or the status code
    // becomes an existence oracle for private resources.
    const res = await call('/api/capability-bindings/bd-nope')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code?: string }).code).toBe('capability-binding-not-found')
  })

  test('an absent framework 404s the same way', async () => {
    const res = await call('/api/capability-frameworks/fw-nope')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code?: string }).code).toBe('capability-framework-not-found')
  })

  test('a malformed framework payload is refused as invalid', async () => {
    const res = await call('/api/capability-frameworks', {
      method: 'POST',
      body: JSON.stringify({ name: 'no capability field' }),
    })
    expect(((await res.json()) as { code?: string }).code).toBe('capability-framework-invalid')
  })

  test('a malformed copy payload is refused as invalid', async () => {
    const fw = await createFramework(db, FRAMEWORK_INPUT, AUTHOR, NOW)
    const res = await call(`/api/capability-frameworks/${fw.id}/copy`, {
      method: 'POST',
      body: JSON.stringify({ name: 42 }),
    })
    expect(((await res.json()) as { code?: string }).code).toBe('capability-template-invalid')
  })

  test('the framework write points never ride a token', () => {
    // A framework carries scripts that run as the daemon, so a leaked PAT
    // holding every matrix grant must still be unable to author one. Asserted
    // against the catalogue rather than the route list so the claim survives a
    // route being moved.
    for (const point of [
      'capability-frameworks:create',
      'capability-frameworks:update',
      'capability-frameworks:delete',
    ] as const) {
      expect(SYSTEM_DOMAIN_POINTS).toContain(point)
    }
    // ...while the group layer is ordinary, or a team could not use it.
    expect(SYSTEM_DOMAIN_POINTS).not.toContain('capability-bindings:create')
  })
})

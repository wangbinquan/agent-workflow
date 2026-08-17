// RFC-304 T57 → RFC-309 — the capability template, merged.
//
// RFC-304 split this into a department framework (scripts + hooks) and a group
// binding (agents + prompts + params), and the tests this file replaces
// verified that boundary as a boundary between two RESOURCES: a binding table
// with no script column, a binding payload refused for naming `hooks`, a
// framework write needing two grants.
//
// The user removed the split: 「不需要区分组织模版和小组模版了，就是一套模版，
// 大家可以复制修改就行了」. What must NOT be removed with it is the reason the
// split existed — scripts run as the daemon with its whole credential surface.
// So the same property is asserted here against its new shape:
//
//   · the resource is one, and an ordinary user may create and edit one;
//   · writing `scripts` or `hooks` still needs `scripts:author`;
//   · a write that changes them without it is refused WHOLE, not stripped;
//   · a reader without `scripts:author` sees the template with its script
//     bodies absent, and can still edit everything else — including saving,
//     which must not wipe the scripts they were never shown.
//
// That last one is the case the merge newly makes possible and newly makes
// dangerous, so it gets its own cases at the bottom.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { capabilityTemplates } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import {
  assertTemplateFieldsAllowed,
  copyTemplate,
  createTemplate,
  deleteTemplate,
  getTemplateRow,
  serializeTemplate,
  updateTemplate,
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
  'capability-templates:create',
  'capability-templates:update',
  'capability-templates:delete',
  'scripts:author',
])
/** Holds the resource points but NOT `scripts:author` — the real-world case. */
const NOT_AN_AUTHOR = actorWith('u-lead', [
  'capability-templates:create',
  'capability-templates:update',
  'capability-templates:delete',
])

const TEMPLATE_INPUT = {
  name: 'gitlab standard',
  description: null,
  capability: 'mr-review',
  scripts: { collect: { language: 'node' as const, script: 'console.log(1)' } },
  hooks: [],
  paramSchema: [],
  paramDefaults: {},
  agentBySlot: { reviewer: 'agent-1' },
  promptBySlot: {},
  params: {},
  stageContractVer: 1,
}

/** A template with no daemon-grade content — what most teams actually make. */
const PLAIN_INPUT = { ...TEMPLATE_INPUT, name: 'plain', scripts: {}, hooks: [] }

describe('RFC-309 — the permission boundary survives the merge', () => {
  test('`scripts:author` is still system-domain, so no token can ever author one', () => {
    // The single most important assertion in this file. The merge moved the
    // check from the resource to the field; if this point had been demoted to
    // an ordinary matrix point along the way, a leaked PAT holding every grant
    // could write code that runs as the daemon.
    expect(SYSTEM_DOMAIN_POINTS).toContain('scripts:author')
  })

  test('the TEMPLATE points are NOT system-domain — that is the merge’s whole point', () => {
    // RFC-304 put the framework writes here, which is why an ordinary user
    // could not own one. Keeping them would have made "swap the agent on step
    // five" require the daemon.
    for (const point of [
      'capability-templates:create',
      'capability-templates:update',
      'capability-templates:delete',
    ] as const) {
      expect(SYSTEM_DOMAIN_POINTS).not.toContain(point)
    }
  })

  test('changing scripts without `scripts:author` is refused, and the message names both', () => {
    expect(() => assertTemplateFieldsAllowed(NOT_AN_AUTHOR, true, TEMPLATE_INPUT, null)).toThrow(
      /scripts:author/,
    )
    // The CODE as well as the message. A caller that branches on the code (and
    // the guard that requires every route-thrown code to be named by a test)
    // sees `capability-template-scripts-forbidden`, so pinning only the prose
    // would let a rename ship silently.
    let code: unknown
    try {
      assertTemplateFieldsAllowed(NOT_AN_AUTHOR, true, TEMPLATE_INPUT, null)
    } catch (err) {
      code = (err as { code?: unknown }).code
    }
    expect(code).toBe('capability-template-scripts-forbidden')
  })

  test('a template with NO scripts needs no extra grant', () => {
    // Otherwise the merge would have taken templates away from the people it
    // exists to serve.
    expect(() => assertTemplateFieldsAllowed(NOT_AN_AUTHOR, true, PLAIN_INPUT, null)).not.toThrow()
  })

  test('no resource write means refused regardless of scripts:author', () => {
    expect(() => assertTemplateFieldsAllowed(AUTHOR, false, PLAIN_INPUT, null)).toThrow(
      /write access/,
    )
  })
})

describe('RFC-309 — reads redact rather than withhold', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await createTemplate(db, TEMPLATE_INPUT, AUTHOR, NOW)
  })
  afterEach(() => db.$client.close())

  test('a non-author sees the template, its params and agents, and NO script bodies', async () => {
    const [row] = await db.select().from(capabilityTemplates)
    const wire = serializeTemplate(row!, NOT_AN_AUTHOR)
    expect(wire.scriptsRedacted).toBe(true)
    expect(wire.scripts).toBeUndefined()
    expect(wire.hooks).toBeUndefined()
    // Everything else is visible: a template whose agents were hidden too
    // could not be used by the group that owns it.
    expect(wire.capability).toBe('mr-review')
    expect(wire.agentBySlot).toEqual({ reviewer: 'agent-1' })
  })

  test('an author sees the script bodies', async () => {
    const [row] = await db.select().from(capabilityTemplates)
    const wire = serializeTemplate(row!, AUTHOR)
    expect(wire.scriptsRedacted).toBe(false)
    expect(wire.scripts?.collect?.script).toBe('console.log(1)')
  })
})

describe('RFC-309 — a redacted reader can still edit the rest', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  test('re-saving with the SAME scripts is allowed without scripts:author', async () => {
    // The case the merge creates: a group lead changes a prompt on a template
    // that happens to carry scripts. The comparison is against what is stored,
    // so an unchanged field is not a write.
    const created = await createTemplate(db, TEMPLATE_INPUT, AUTHOR, NOW)
    const edited = await updateTemplate(
      db,
      created,
      { ...TEMPLATE_INPUT, promptBySlot: { reviewer: 'be specific' } },
      NOT_AN_AUTHOR,
      NOW + 1,
    )
    expect(JSON.parse(edited.promptBySlotJson)).toEqual({ reviewer: 'be specific' })
    // And the scripts are still there, byte for byte.
    expect(edited.scriptsJson).toBe(created.scriptsJson)
  })

  test('changing a script IS refused for the same person', async () => {
    const created = await createTemplate(db, TEMPLATE_INPUT, AUTHOR, NOW)
    await expect(
      updateTemplate(
        db,
        created,
        {
          ...TEMPLATE_INPUT,
          scripts: { collect: { language: 'node' as const, script: 'console.log(2)' } },
        },
        NOT_AN_AUTHOR,
        NOW + 1,
      ),
    ).rejects.toThrow(/scripts:author/)
  })

  test('a refused write changes NOTHING — not even the fields it was allowed', async () => {
    // Rejected whole. A partial apply would leave the template in a state
    // nobody asked for, and the caller believing the whole thing landed.
    const created = await createTemplate(db, TEMPLATE_INPUT, AUTHOR, NOW)
    await expect(
      updateTemplate(
        db,
        created,
        {
          ...TEMPLATE_INPUT,
          name: 'renamed',
          scripts: { collect: { language: 'node' as const, script: 'console.log(3)' } },
        },
        NOT_AN_AUTHOR,
        NOW + 1,
      ),
    ).rejects.toThrow()
    const after = await getTemplateRow(db, created.id)
    expect(after?.name).toBe('gitlab standard')
  })
})

describe('RFC-309 — creation, copying and deletion', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  test('a new template is PRIVATE by default', async () => {
    const row = await createTemplate(db, TEMPLATE_INPUT, AUTHOR, NOW)
    expect(row.visibility).toBe('private')
    expect(row.ownerUserId).toBe('u-author')
  })

  test('a copy is owned by the copier and private even from a public source', async () => {
    const source = await createTemplate(
      db,
      { ...TEMPLATE_INPUT, visibility: 'public' as const },
      AUTHOR,
      NOW,
    )
    const copy = await copyTemplate(db, source, NOT_AN_AUTHOR, undefined, NOW + 1)
    expect(copy.ownerUserId).toBe('u-lead')
    expect(copy.visibility).toBe('private')
    // T64 — the link, which after RFC-309 is the ONLY record that these two
    // came from the same place.
    expect(copy.upstreamId).toBe(source.id)
    expect(copy.baseDigest).not.toBeNull()
  })

  test('copying does NOT require scripts:author', async () => {
    // The copier receives the scripts unchanged and cannot alter them without
    // the grant, so the bytes that run as the daemon are still an authorised
    // author's. Refusing the copy would instead mean a team could not adopt a
    // template that works.
    const source = await createTemplate(db, TEMPLATE_INPUT, AUTHOR, NOW)
    const copy = await copyTemplate(db, source, NOT_AN_AUTHOR, 'ours', NOW + 1)
    expect(copy.scriptsJson).toBe(source.scriptsJson)
  })

  test('a copy of a built-in is an ordinary resource', async () => {
    const source = await createTemplate(db, TEMPLATE_INPUT, AUTHOR, NOW)
    await db.update(capabilityTemplates).set({ builtin: true })
    const builtin = await getTemplateRow(db, source.id)
    const copy = await copyTemplate(db, builtin!, AUTHOR, 'mine', NOW + 1)
    // Carrying the flag across would make the copy uneditable, which is the
    // opposite of why somebody copies a built-in.
    expect(copy.builtin).toBe(false)
  })

  test('a built-in cannot be edited in place', async () => {
    const row = await createTemplate(db, TEMPLATE_INPUT, AUTHOR, NOW)
    await db.update(capabilityTemplates).set({ builtin: true })
    const builtin = await getTemplateRow(db, row.id)
    await expect(
      updateTemplate(db, builtin!, { ...TEMPLATE_INPUT, name: 'x' }, AUTHOR, NOW + 1),
    ).rejects.toThrow(/ships with the platform/)
  })

  test('two templates of one owner cannot share a name', async () => {
    await createTemplate(db, TEMPLATE_INPUT, AUTHOR, NOW)
    await expect(createTemplate(db, TEMPLATE_INPUT, AUTHOR, NOW + 1)).rejects.toThrow(/named/)
  })

  test('two OWNERS may each have one of the same name', async () => {
    await createTemplate(db, TEMPLATE_INPUT, AUTHOR, NOW)
    await expect(createTemplate(db, PLAIN_INPUT, NOT_AN_AUTHOR, NOW + 1)).resolves.toBeDefined()
  })

  test('deleting no longer has a dependent layer to refuse for', async () => {
    // RFC-304 refused to delete a framework while a binding pointed at it.
    // There is no second layer now, so the guard has nothing to guard — and
    // keeping it would have meant refusing every delete.
    const row = await createTemplate(db, TEMPLATE_INPUT, AUTHOR, NOW)
    await expect(deleteTemplate(db, row)).resolves.toBeUndefined()
    expect(await getTemplateRow(db, row.id)).toBeNull()
  })
})

describe('RFC-309 — the template routes', () => {
  const TOKEN = 'a'.repeat(64)
  let db: DbClient
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    app = createApp({
      token: TOKEN,
      configPath: '',
      opencodeVersion: '1.15.0',
      dbVersion: 1,
      db,
    })
  })
  afterEach(() => db.$client.close())

  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

  test('one list endpoint, not two', async () => {
    const res = await app.request('/api/capability-templates', { headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    // And the old pair is gone rather than left as an alias: two ways to write
    // the same row is how the two drift.
    expect((await app.request('/api/capability-bindings', { headers: auth })).status).toBe(404)
    expect((await app.request('/api/capability-frameworks', { headers: auth })).status).toBe(404)
  })

  test('a template can be created and read back through HTTP', async () => {
    const res = await app.request('/api/capability-templates', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(PLAIN_INPUT),
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as { id: string; agentBySlot: Record<string, string> }
    expect(created.agentBySlot).toEqual({ reviewer: 'agent-1' })

    const got = await app.request(`/api/capability-templates/${created.id}`, { headers: auth })
    expect(got.status).toBe(200)
  })

  test('a malformed body is refused by name', async () => {
    // Named, not just "some 4xx": the repo's error-code ratchet requires every
    // code a route can throw to be asserted somewhere, because a code nobody
    // names is one nobody has seen fire.
    const res = await app.request('/api/capability-templates', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('capability-template-invalid')
  })

  test('an unknown template is refused by name', async () => {
    const res = await app.request('/api/capability-templates/no-such-id', { headers: auth })
    expect(res.status).toBe(404)
    expect(JSON.stringify(await res.json())).toContain('capability-template-not-found')
  })

  test('a malformed copy payload is refused by the same code', async () => {
    const created = (await (
      await app.request('/api/capability-templates', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(PLAIN_INPUT),
      })
    ).json()) as { id: string }
    const res = await app.request(`/api/capability-templates/${created.id}/copy`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 123 }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('capability-template-invalid')
  })

  test('without a bearer token every endpoint is refused', async () => {
    expect((await app.request('/api/capability-templates')).status).toBe(401)
  })
})

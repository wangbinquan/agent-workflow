// RFC-304 §11.6 (T64) — the four states, and the base that makes them knowable.
//
// Copying is how teams start, so within a quarter there are dozens of templates
// descended from a handful of originals. Then the original gets a fix and
// nobody downstream hears about it. The failure is quiet in both directions:
//
//   no link            — an upstream fix never reaches the copies, and five
//                        teams debug the same bug separately;
//   link, no base      — "update from upstream" silently discards the local
//                        changes that were the whole reason for copying.
//
// The BASE is what separates those. Without it, "upstream says A, local says B"
// cannot distinguish "upstream changed it" from "local changed it", so a
// two-way merge guesses — and is wrong half the time on exactly the fields
// somebody cared enough to edit.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import type { Actor } from '../src/auth/actor'
import {
  copyTemplate as copyTemplateWithPersistence,
  createTemplate as createTemplateWithPersistence,
  templateDigest,
} from '../src/services/capabilityTemplates'
import type { CapabilityTemplatePersistence } from '../src/modules/code-capability/application/ports/capabilityTemplatePersistence'
import { createSqliteCapabilityTemplatePersistence } from '../src/modules/code-capability/infrastructure/sqliteCapabilityTemplatePersistence'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function bindTemplatePersistence<Args extends unknown[], Result>(
  operation: (persistence: CapabilityTemplatePersistence, ...args: Args) => Result,
): (db: DbClient, ...args: Args) => Result {
  return (db, ...args) => operation(createSqliteCapabilityTemplatePersistence(db), ...args)
}

const copyTemplate = bindTemplatePersistence(copyTemplateWithPersistence)
const createTemplate = bindTemplatePersistence(createTemplateWithPersistence)
import {
  judgeUpstream,
  mergeUnoverridden,
  packagedUpstreamState,
  resolveThreeWay,
  type UpstreamLink,
} from '../src/modules/code-capability/domain/templateUpstream'

const link: UpstreamLink = { upstreamId: 'fw-1', upstreamVersion: 100, baseDigest: 'd0' }

describe('RFC-304 T64 — the four states', () => {
  test('upstream unchanged is current', () => {
    const s = judgeUpstream({
      link,
      upstreamVersionNow: 100,
      localDigest: 'd0',
      localOverrides: [],
    })
    expect(s.state).toBe('current')
  })

  test('local edits ALONE are not a state — a customised copy is doing its job', () => {
    // Flagging this would put a permanent badge on every template anyone
    // customised, which is all of them, which means the badge stops meaning
    // anything.
    const s = judgeUpstream({
      link,
      upstreamVersionNow: 100,
      localDigest: 'd9',
      localOverrides: ['paramDefaults'],
    })
    expect(s.state).toBe('current')
    expect(s.message).toContain('local changes are intact')
  })

  test('upstream moved with no local edits can fast-forward', () => {
    const s = judgeUpstream({
      link,
      upstreamVersionNow: 101,
      localDigest: 'd0',
      localOverrides: [],
    })
    expect(s.state).toBe('update-available')
    expect(s.message).toContain('cleanly')
  })

  test('upstream moved AND edited locally is a decision, not an auto-merge', () => {
    const s = judgeUpstream({
      link,
      upstreamVersionNow: 101,
      localDigest: 'd9',
      localOverrides: ['scripts', 'paramDefaults'],
    })
    expect(s.state).toBe('conflicted')
    expect(s.message).toContain('2 field(s)')
  })

  test('a deleted upstream is ORPHANED, checked before anything else', () => {
    // Reporting `current` here would be the most misleading of the four: it
    // says "nothing to do" about a link that can never be followed again.
    const s = judgeUpstream({
      link,
      upstreamVersionNow: null,
      localDigest: 'd0',
      localOverrides: [],
    })
    expect(s.state).toBe('orphaned')
    expect(s.message).toContain('no longer exists')
  })

  test('orphaned wins even when there are local edits', () => {
    const s = judgeUpstream({
      link,
      upstreamVersionNow: null,
      localDigest: 'd9',
      localOverrides: ['scripts'],
    })
    expect(s.state).toBe('orphaned')
  })
})

describe('RFC-304 T64 — the three-way diff', () => {
  test('only upstream changed: take it', () => {
    const [r] = resolveThreeWay([{ field: 'a', base: 1, upstream: 2, local: 1 }])
    expect(r).toEqual({ field: 'a', action: 'take-upstream', value: 2 })
  })

  test('only local changed: keep it', () => {
    const [r] = resolveThreeWay([{ field: 'a', base: 1, upstream: 1, local: 9 }])
    expect(r).toEqual({ field: 'a', action: 'keep-local', value: 9 })
  })

  test('both changed differently: a person decides', () => {
    const [r] = resolveThreeWay([{ field: 'a', base: 1, upstream: 2, local: 9 }])
    expect(r?.action).toBe('conflict')
  })

  test('both changed to the SAME value is not a conflict', () => {
    // A team that independently made the same fix should not be asked to
    // adjudicate between two identical answers.
    const [r] = resolveThreeWay([{ field: 'a', base: 1, upstream: 7, local: 7 }])
    expect(r?.action).toBe('unchanged')
  })

  test('key ORDER is not a change', () => {
    // Otherwise a round trip through JSON manufactures a conflict on a field
    // nobody touched — and every template that has been exported and imported
    // would arrive permanently "conflicted".
    const [r] = resolveThreeWay([
      {
        field: 'params',
        base: { a: 1, b: 2 },
        upstream: { b: 2, a: 1 },
        local: { a: 1, b: 2 },
      },
    ])
    expect(r?.action).toBe('unchanged')
  })

  test('nested objects compare by content, not identity', () => {
    const [r] = resolveThreeWay([
      {
        field: 'scripts',
        base: { collect: { language: 'node', script: 'x' } },
        upstream: { collect: { script: 'x', language: 'node' } },
        local: { collect: { language: 'node', script: 'x' } },
      },
    ])
    expect(r?.action).toBe('unchanged')
  })
})

describe('RFC-304 T64 — “merge only what I have not overridden”', () => {
  test('it takes upstream, keeps local, and leaves conflicts alone', () => {
    // Silently choosing upstream on a conflict discards the local change that
    // was the reason for copying; choosing local makes "update from upstream"
    // do nothing on precisely the fields the fix was about. So it does neither.
    const merged = mergeUnoverridden(
      resolveThreeWay([
        { field: 'a', base: 1, upstream: 2, local: 1 },
        { field: 'b', base: 1, upstream: 1, local: 9 },
        { field: 'c', base: 1, upstream: 2, local: 9 },
        { field: 'd', base: 1, upstream: 1, local: 1 },
      ]),
    )
    expect(merged.applied).toEqual(['a'])
    expect(merged.keptLocal).toEqual(['b'])
    expect(merged.stillConflicted).toEqual(['c'])
  })
})

describe('RFC-304 T64 — what a package says about origin', () => {
  test('an instance that cannot resolve the upstream reports DETACHED', () => {
    // The honest answer. Reporting `linked` would claim a relationship the
    // destination cannot check, and the first "update from upstream" there
    // would fail on a link the page said was fine.
    expect(packagedUpstreamState({ link, upstreamResolvableHere: false })).toBe('detached')
  })

  test('an instance that has the upstream reports linked', () => {
    expect(packagedUpstreamState({ link, upstreamResolvableHere: true })).toBe('linked')
  })

  test('a template nobody copied has no origin at all', () => {
    expect(packagedUpstreamState({ link: null, upstreamResolvableHere: false })).toBe('none')
  })
})

// The join: the link is written at COPY time. A rule with no writer would leave
// every copy `orphaned`-looking forever, and the three facts it needs cannot be
// reconstructed later — after the copy, the source moves on and its `updatedAt`
// no longer describes what was taken.
describe('RFC-304 T64 — copying records the origin', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  const AUTHOR = {
    user: { id: 'u-1', name: 'u-1', role: 'user' },
    permissions: new Set(['capability-templates:create', 'scripts:author']),
    source: 'session',
  } as unknown as Actor

  const FRAMEWORK = {
    name: 'gitlab standard',
    description: null,
    capability: 'mr-review',
    scripts: { collect: { language: 'node' as const, script: 'console.log(1)' } },
    hooks: [],
    paramSchema: [],
    paramDefaults: {},
    agentBySlot: {},
    promptBySlot: {},
    params: {},
    stageContractVer: 1,
  }

  test('a fresh template has NO origin — that is a state, not missing data', async () => {
    const row = await createTemplate(db, FRAMEWORK, AUTHOR, 1000)
    expect(row.upstreamId).toBeNull()
    expect(row.baseDigest).toBeNull()
  })

  test('a copy records source, version and base digest together', async () => {
    const source = await createTemplate(db, FRAMEWORK, AUTHOR, 1000)
    const copy = await copyTemplate(db, source, AUTHOR, 'mine', 2000)

    expect(copy.upstreamId).toBe(source.id)
    expect(copy.upstreamVersion).toBe(source.updatedAt)
    expect(copy.baseDigest).toBe(templateDigest(source))
  })

  test('the base digest matches the source at copy time, so a fresh copy is CURRENT', async () => {
    const source = await createTemplate(db, FRAMEWORK, AUTHOR, 1000)
    const copy = await copyTemplate(db, source, AUTHOR, 'mine', 2000)

    const status = judgeUpstream({
      link: {
        upstreamId: copy.upstreamId!,
        upstreamVersion: copy.upstreamVersion!,
        baseDigest: copy.baseDigest!,
      },
      upstreamVersionNow: source.updatedAt,
      localDigest: templateDigest(copy),
      localOverrides: [],
    })
    expect(status.state).toBe('current')
  })

  test('the digest ignores the ACL, so a visibility change is not a body change', async () => {
    // Otherwise every grant edit upstream would mark healthy copies
    // `conflicted`, and the state would stop meaning anything.
    const source = await createTemplate(db, FRAMEWORK, AUTHOR, 1000)
    const withDifferentAcl = { ...source, visibility: 'public' as const, aclRevision: 7 }
    expect(templateDigest(withDifferentAcl)).toBe(templateDigest(source))
  })

  test('the digest DOES change when a script body changes', async () => {
    const source = await createTemplate(db, FRAMEWORK, AUTHOR, 1000)
    const edited = { ...source, scriptsJson: JSON.stringify({ collect: { script: 'other' } }) }
    expect(templateDigest(edited)).not.toBe(templateDigest(source))
  })
})

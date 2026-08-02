// RFC-247 D9 / AC-12 / AC-38 — locks what a token may read.
//
// "Reads are always on" makes tokens usable and makes the read path the only
// thing standing between a token and every secret its owner can see. Two
// separate properties are locked here:
//
//   · token-channel masking of the managed-resource secret fields
//   · an ALL-CHANNEL fix for `tasks.repo_url`, which was leaking credentials to
//     everyone — session included — long before tokens existed
//
// The second is deliberately not conditioned on the actor: it closes an
// existing leak rather than adding a token-only gate, and writing the test that
// way is what keeps a future refactor from "restoring" the plaintext for
// sessions on the grounds that only tokens needed it.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { redactGitUrl } from '@agent-workflow/shared'
import {
  REDACTED,
  redactErrorText,
  redactMcpRecord,
  redactRepoUrl,
  redactStdout,
  shouldRedactFor,
} from '@/services/tokenRedaction'

describe('RFC-247 — redaction applies to the token channel only', () => {
  test('pat is redacted; session and daemon are untouched', () => {
    expect(shouldRedactFor('pat')).toBe(true)
    // A human who can already open the MCP editor gains nothing from having the
    // same bytes hidden; changing that would be a UX regression dressed up as
    // security.
    expect(shouldRedactFor('session')).toBe(false)
    expect(shouldRedactFor('daemon')).toBe(false)
  })
})

describe('RFC-247 AC-12 — MCP secret fields are masked, keys survive', () => {
  const record = {
    id: 'm1',
    name: 'ctx7',
    config: {
      type: 'local',
      command: ['npx', 'ctx7'],
      env: { API_KEY: 'sk-live-abc', OTHER: 'plain' },
      timeoutMs: 5000,
    },
  }

  test('env values are masked but the key names remain', () => {
    const out = redactMcpRecord(record) as typeof record
    // Key names must survive: an operator needs to see WHICH variables a server
    // wants configured, and the generated docs list them.
    expect(Object.keys(out.config.env)).toEqual(['API_KEY', 'OTHER'])
    expect(out.config.env.API_KEY).toBe(REDACTED)
    expect(out.config.env.OTHER).toBe(REDACTED)
  })

  test('non-secret config fields are left alone', () => {
    const out = redactMcpRecord(record) as typeof record
    expect(out.config.command).toEqual(['npx', 'ctx7'])
    expect(out.config.timeoutMs).toBe(5000)
    expect(out.name).toBe('ctx7')
  })

  test('remote headers are masked — Authorization lives there', () => {
    const remote = {
      id: 'm2',
      config: { type: 'remote', url: 'https://x/mcp', headers: { Authorization: 'Bearer s3cret' } },
    }
    const out = redactMcpRecord(remote) as typeof remote
    expect(Object.keys(out.config.headers)).toEqual(['Authorization'])
    expect(out.config.headers.Authorization).toBe(REDACTED)
  })

  test('oauth.clientSecret is masked, clientId is not', () => {
    const oauthed = {
      id: 'm3',
      config: {
        type: 'remote',
        url: 'https://x/mcp',
        oauth: { clientId: 'public-id', clientSecret: 'sh-secret', scope: 'read' },
      },
    }
    const out = redactMcpRecord(oauthed) as typeof oauthed
    expect(out.config.oauth.clientSecret).toBe(REDACTED)
    expect(out.config.oauth.clientId).toBe('public-id')
    expect(out.config.oauth.scope).toBe('read')
  })

  test('the input object is not mutated — callers may still hold the real one', () => {
    const before = JSON.stringify(record)
    redactMcpRecord(record)
    expect(JSON.stringify(record)).toBe(before)
  })

  test('a record without config, or a non-object, passes through unharmed', () => {
    expect(redactMcpRecord({ id: 'x' })).toEqual({ id: 'x' })
    expect(redactMcpRecord(null)).toBe(null)
    expect(redactMcpRecord('nope')).toBe('nope')
  })
})

describe('RFC-247 AC-38 — repo URL credentials never reach the wire', () => {
  test('userinfo credentials are stripped', () => {
    // StartTaskSchema only rejects credentials in the QUERY STRING, so this
    // exact shape is accepted at launch, stored, and previously handed straight
    // back by every task read.
    const dirty = 'https://someone:ghp_realtokenvalue@github.com/acme/repo.git'
    const out = redactRepoUrl(dirty)
    expect(out).not.toContain('ghp_realtokenvalue')
    expect(out).toBe(redactGitUrl(dirty))
  })

  test('a clean URL is preserved so the UI still shows something useful', () => {
    const clean = 'https://github.com/acme/repo.git'
    expect(redactRepoUrl(clean)).toBe(redactGitUrl(clean))
    expect(redactRepoUrl(clean)).toContain('github.com/acme/repo')
  })

  test('null and empty stay null-ish rather than becoming a string', () => {
    expect(redactRepoUrl(null)).toBe(null)
    expect(redactRepoUrl(undefined)).toBe(null)
    expect(redactRepoUrl('')).toBe(null)
  })
})

describe('RFC-247 AC-39 — free-form output is best-effort redacted', () => {
  test('stdout goes through the same helper the plugin installer uses', () => {
    const noisy = 'cloning https://u:ghp_abcdefghijklmno@github.com/x/y.git ...'
    expect(redactStdout(noisy)).not.toContain('ghp_abcdefghijklmno')
  })

  test('error text is redacted — opencode puts it in the model context', () => {
    // mcp/catalog.ts concatenates a failed tool call's text content and throws
    // it, so an unredacted message does not merely get logged: it lands in the
    // model's conversation and travels with it.
    const err = 'failed to reach https://u:ghp_abcdefghijklmno@host/repo.git'
    expect(redactErrorText(err)).not.toContain('ghp_abcdefghijklmno')
  })
})

// -----------------------------------------------------------------------------
// AC-39 — WIRING, not just the rule.
//
// This RFC shipped two redactors that were defined, unit-tested, and called by
// nobody (`redactMcpRecord`, then `redactStdout`). A unit test proves the
// FUNCTION works; it says nothing about whether any outlet uses it. These are
// the source-level assertions that the outlets exist — cheap, and they are what
// would have caught both.
// -----------------------------------------------------------------------------

describe('RFC-247 — every redactor has an outlet', () => {
  const SRC = resolve(import.meta.dir, '..', 'src')

  function read(rel: string): string {
    return readFileSync(resolve(SRC, rel), 'utf8')
  }

  test('redactStdout is applied on the node-run stdout route (AC-39)', () => {
    const tasks = read('routes/tasks.ts')
    expect(tasks).toContain('redactStdout(text)')
    expect(tasks).toContain('shouldRedactFor(actor.source)')
  })

  test('redactMcpRecord is applied through serializeMcpFor on every mcps read (AC-12)', () => {
    const mcps = read('routes/mcps.ts')
    // Five serialization points; each must go through the single outlet.
    const uses = mcps.split('serializeMcpFor(').length - 1
    expect(uses).toBeGreaterThanOrEqual(5)
    expect(read('services/tokenRedaction.ts')).toContain('return shouldRedactFor(source)')
  })

  test('redactRepoUrl reaches rowToTask (AC-38)', () => {
    // AC-38 is explicitly ALL channels, not token-only: a repo URL with an
    // embedded credential has no reader who benefits from seeing it.
    const task = read('services/task.ts')
    expect(task.split('redactGitUrl(row.repoUrl)').length - 1).toBeGreaterThanOrEqual(4)
  })

  test('no redactor in tokenRedaction.ts is left with zero callers', () => {
    // The generalized form of the two misses. Every exported redactor must be
    // referenced somewhere OUTSIDE its own module.
    const moduleSource = read('services/tokenRedaction.ts')
    // `<T>` sits between the name and `(` on the generic ones, so the pattern
    // has to allow it — without that this test silently checks a subset, which
    // is the same class of miss it exists to catch.
    const exported = [
      ...moduleSource.matchAll(/export function (redact\w+|serialize\w+)(?:<[^>]*>)?\(/g),
    ].map((m) => m[1])
    expect(exported.length).toBeGreaterThanOrEqual(5)

    const callers = walkSrc(SRC).filter((f) => !f.endsWith(join('services', 'tokenRedaction.ts')))
    const haystack = callers.map((f) => readFileSync(f, 'utf8')).join('\n')
    const unwired = exported.filter((name) => !haystack.includes(`${name}(`))
    expect(unwired).toEqual([])
  })
})

function walkSrc(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walkSrc(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

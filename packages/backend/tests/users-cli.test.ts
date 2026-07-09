import { rimrafDir } from './helpers/cleanup'
// RFC-036 — CLI happy paths via `userCommand`. AGENT_WORKFLOW_HOME isolates
// the temp $HOME so the daemon DB lands in a tmp dir.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let prevHome: string | undefined
let homeDir: string

beforeEach(() => {
  prevHome = process.env.AGENT_WORKFLOW_HOME
  homeDir = mkdtempSync(join(tmpdir(), 'aw-cli-'))
  process.env.AGENT_WORKFLOW_HOME = homeDir
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = prevHome
  rimrafDir(homeDir)
})

describe('user CLI', () => {
  test('create + list + reset-password + disable round-trip', async () => {
    // Re-import for each test so the path module re-reads AGENT_WORKFLOW_HOME.
    const { userCommand } = await import('../src/cli/user')

    const created = await userCommand([
      'create',
      '--username',
      'alice',
      '--admin',
      '--password',
      'correctPw123',
    ])
    expect(created.status).toBe('ok')
    expect(created.output).toMatch(/created user alice/)

    // Idempotency guard: same username again → error.
    const dup = await userCommand([
      'create',
      '--username',
      'alice',
      '--admin',
      '--password',
      'correctPw123',
    ])
    expect(dup.status).toBe('error')
    expect(dup.output).toMatch(/already exists/)

    const list = await userCommand(['list'])
    expect(list.status).toBe('ok')
    expect(list.output).toMatch(/__system__/)
    expect(list.output).toMatch(/alice/)

    const reset = await userCommand([
      'reset-password',
      '--username',
      'alice',
      '--new-password',
      'newPwAbcdef',
    ])
    expect(reset.status).toBe('ok')
    expect(reset.output).toMatch(/reset password/)

    // Disable __system__ → refused (immutability + last-admin protection).
    const disableSys = await userCommand(['disable', '--username', '__system__'])
    expect(disableSys.status).toBe('error')
  })

  test('disable + enable round-trip on a non-admin user', async () => {
    const { userCommand } = await import('../src/cli/user')
    await userCommand(['create', '--username', 'alice', '--admin', '--password', 'correctPw123'])
    await userCommand(['create', '--username', 'bob', '--password', 'correctPw123'])

    const disabled = await userCommand(['disable', '--username', 'bob'])
    expect(disabled.status).toBe('ok')
    expect(disabled.output).toMatch(/disabled bob/)
    expect((await userCommand(['list'])).output).toMatch(/bob\tuser\tdisabled/)

    const enabled = await userCommand(['enable', '--username', 'bob'])
    expect(enabled.status).toBe('ok')
    expect(enabled.output).toMatch(/enabled bob/)
    expect((await userCommand(['list'])).output).toMatch(/bob\tuser\tactive/)
  })

  test('enable on a missing user errors out', async () => {
    const { userCommand } = await import('../src/cli/user')
    const r = await userCommand(['enable', '--username', 'ghost'])
    expect(r.status).toBe('error')
    expect(r.output).toMatch(/not found/)
  })

  test('user create without --username errors out', async () => {
    const { userCommand } = await import('../src/cli/user')
    const r = await userCommand(['create', '--admin'])
    expect(r.status).toBe('error')
    expect(r.output).toMatch(/--username/)
  })

  test('unknown subcommand surfaces usage error', async () => {
    const { userCommand } = await import('../src/cli/user')
    const r = await userCommand(['nope'])
    expect(r.status).toBe('error')
  })

  test('user create with no password lands as invited', async () => {
    const { userCommand } = await import('../src/cli/user')
    const r = await userCommand(['create', '--username', 'bob', '--display', 'Bob'])
    expect(r.status).toBe('ok')
    expect(r.output).toMatch(/invited/)
  })
})

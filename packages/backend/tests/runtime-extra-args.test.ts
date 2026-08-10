// 2026-08-04 — per-runtime extraArgs (fork-private CLI flags).
//
// Incident context: the CodeAgent fork (claude-code protocol, GLM gateway)
// prints a per-run "Quick safety check … Continue? [y/N]" because the platform
// hands it a FRESH private config dir every spawn (trust never persists), and
// its private silencer flag `--skip-safe-check` had no platform surface — the
// claude driver ignored runtime params entirely and official claude would hard
// -error on an unconditionally-injected unknown option. extraArgs gives the
// runtime row an explicit, validated argv seam instead.
//
// Locks:
//  (a) validateExtraArgs is fail-closed: claude-code protocol only; platform-
//      owned flags rejected (exact and `=`-joined); a bare token that is not a
//      long-flag value is rejected (it would be consumed as claude's PROMPT
//      positional and break the stdin prompt contract); control chars / caps.
//  (b) create/update persist + round-trip extraArgs, and an update CHANGES the
//      execution profile (cached probe invalidated via probeFence semantics).
//  (c) the frozen runtime snapshot carries extraArgs and later row edits do
//      NOT re-route an already-frozen run (same invariant as RFC-154 configDir).
//  (d) buildClaudeSpawn appends extraArgs LAST; absent extraArgs leaves the
//      argv byte-identical (golden-lock safety).
//  (e) CLAUDE_PLATFORM_OWNED_FLAGS covers every flag literal the spawn module
//      itself emits — the reserved set cannot silently fall behind the argv.

import { describe, expect, test } from 'bun:test'
import { canonicalBinaryPath } from './fixtures/platformPaths'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  createRuntime,
  getRuntime,
  parseRuntimeExtraArgs,
  resolveRuntimeByName,
  runtimeRowToView,
  seedBuiltinRuntimes,
  updateRuntime,
  validateExtraArgs,
} from '../src/services/runtimeRegistry'
import { resolveFrozenRuntime } from '../src/services/nodeRunMint'
import { getRuntimeDriver } from '../src/services/runtime'
import {
  buildClaudeSpawn,
  CLAUDE_PLATFORM_OWNED_FLAGS,
} from '../src/services/runtime/claudeCode/spawn'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedRun(db: DbClient): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/r',
    worktreePath: '/w',
    baseBranch: 'main',
    branch: 'b',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const id = ulid()
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'n1', status: 'pending' })
  return id
}

describe('validateExtraArgs — fail-closed write gate', () => {
  test('capability declaration: claude driver opts in, opencode stays fail-closed', () => {
    expect(getRuntimeDriver('claude-code').acceptsExtraArgs).toBe(true)
    expect(getRuntimeDriver('opencode').acceptsExtraArgs).toBeUndefined()
    expect(getRuntimeDriver('claude-code').acceptsSandboxCompatibilityMarker).toBe(true)
    expect(getRuntimeDriver('opencode').acceptsSandboxCompatibilityMarker).toBeUndefined()
  })

  test('null / empty → NULL (no column value)', () => {
    expect(validateExtraArgs('claude-code', null)).toBeNull()
    expect(validateExtraArgs('claude-code', undefined)).toBeNull()
    expect(validateExtraArgs('claude-code', [])).toBeNull()
  })

  test('opencode protocol rejects extraArgs entirely', () => {
    expect(() => validateExtraArgs('opencode', ['--skip-safe-check'])).toThrow(
      /extra-args|not supported/i,
    )
  })

  test('transport/product-owned flags are rejected — exact and =-joined', () => {
    for (const bad of [
      ['--model', 'x'],
      ['--permission-mode', 'bypassPermissions'],
      ['--mcp-config', '/tmp/m.json'],
      ['--dangerously-skip-permissions'],
      ['-p'],
    ]) {
      expect(() => validateExtraArgs('claude-code', bad)).toThrow(/platform-owned/)
    }
    expect(validateExtraArgs('claude-code', ['--settings=/tmp/s.json'])).toBe(
      '["--settings=/tmp/s.json"]',
    )
  })

  test('a bare leading token is rejected (would become the prompt positional)', () => {
    expect(() => validateExtraArgs('claude-code', ['oops'])).toThrow(/prompt positional/)
    // A bare token after a SHORT flag is rejected too — only a long `--flag`
    // opens a value slot.
    expect(() => validateExtraArgs('claude-code', ['-x', 'value'])).toThrow(/prompt positional/)
    // `--flag=value` closes the slot — the next token must be a flag again.
    expect(() => validateExtraArgs('claude-code', ['--a=b', 'value'])).toThrow(/prompt positional/)
  })

  test('a value directly after a long flag is legal', () => {
    expect(validateExtraArgs('claude-code', ['--profile', 'work'])).toBe(
      JSON.stringify(['--profile', 'work']),
    )
  })

  test('caps and control characters are rejected', () => {
    expect(() =>
      validateExtraArgs(
        'claude-code',
        Array.from({ length: 17 }, (_, i) => `--f${i}`),
      ),
    ).toThrow(/at most/)
    expect(() => validateExtraArgs('claude-code', [`--${'x'.repeat(220)}`])).toThrow(/exceeds/)
    expect(() => validateExtraArgs('claude-code', ['--ok\nbad'])).toThrow(/control characters/)
  })

  test('the observed fork flag round-trips', () => {
    const json = validateExtraArgs('claude-code', ['--skip-safe-check'])
    expect(json).toBe('["--skip-safe-check"]')
    expect(parseRuntimeExtraArgs(json)).toEqual(['--skip-safe-check'])
  })
})

describe('registry persistence + frozen snapshot', () => {
  test('create persists extraArgs; view + resolve expose it; opencode create rejects it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db)
    await createRuntime(db, {
      name: 'codeagent',
      protocol: 'claude-code',
      binaryPath: canonicalBinaryPath('codeagentcli'),
      model: 'GLM-5.1-NN',
      extraArgs: ['--skip-safe-check'],
    })
    const row = await getRuntime(db, 'codeagent')
    expect(row?.extraArgsJson).toBe('["--skip-safe-check"]')
    const view = runtimeRowToView(row!, null, canonicalBinaryPath('codeagentcli'))
    expect(view.extraArgs).toEqual(['--skip-safe-check'])
    const resolved = await resolveRuntimeByName(db, 'codeagent')
    expect(resolved.extraArgs).toEqual(['--skip-safe-check'])

    await expect(
      createRuntime(db, {
        name: 'oc-fork',
        protocol: 'opencode',
        extraArgs: ['--flag'],
      }),
    ).rejects.toThrow(/not supported/i)
  })

  test('update validates against the ROW protocol and flips the execution profile', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db)
    await createRuntime(db, {
      name: 'codeagent',
      protocol: 'claude-code',
      binaryPath: canonicalBinaryPath('codeagentcli'),
    })
    const before = await getRuntime(db, 'codeagent')
    const updated = await updateRuntime(db, 'codeagent', {
      extraArgs: ['--skip-safe-check'],
    })
    expect(updated.extraArgsJson).toBe('["--skip-safe-check"]')
    // executionProfileChanged semantics: the probe fence must advance so a
    // long-running probe against the OLD argv cannot cache onto the new row.
    expect(updated.probeFence).toBeGreaterThan(before!.probeFence)
    // clearing back to null is a change too
    const cleared = await updateRuntime(db, 'codeagent', { extraArgs: null })
    expect(cleared.extraArgsJson).toBeNull()
    expect(cleared.probeFence).toBeGreaterThan(updated.probeFence)
    // and an update on an opencode row rejects extraArgs
    await expect(updateRuntime(db, 'opencode', { extraArgs: ['--x'] })).rejects.toThrow(
      /not supported/i,
    )
  })

  test('frozen runtime snapshot carries extraArgs and isSandbox; later row edits do not re-route', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db)
    await createRuntime(db, {
      name: 'codeagent',
      protocol: 'claude-code',
      extraArgs: ['--skip-safe-check'],
      isSandbox: true,
    })
    const runId = await seedRun(db)
    const first = await resolveFrozenRuntime(db, runId, 'codeagent', null)
    expect(first.params.extraArgs).toEqual(['--skip-safe-check'])
    expect(first.params.isSandbox).toBe(true)
    await updateRuntime(db, 'codeagent', { extraArgs: ['--other-flag'], isSandbox: false })
    const resumed = await resolveFrozenRuntime(db, runId, 'codeagent', null)
    expect(resumed.params.extraArgs).toEqual(['--skip-safe-check'])
    expect(resumed.params.isSandbox).toBe(true)
  })
})

describe('buildClaudeSpawn argv', () => {
  const baseCtx = () => ({
    prompt: 'hi',
    systemPromptText: 'persona',
    attemptDir: mkdtempSync(join(tmpdir(), 'aw-extra-args-')),
    worktreePath: '/tmp',
  })

  test('extraArgs are appended LAST', () => {
    const plan = buildClaudeSpawn({
      ...baseCtx(),
      model: 'GLM-5.1-NN',
      extraArgs: ['--skip-safe-check'],
    })
    expect(plan.cmd[plan.cmd.length - 1]).toBe('--skip-safe-check')
    // and never before the platform's own flag groups
    expect(plan.cmd.indexOf('--skip-safe-check')).toBeGreaterThan(plan.cmd.indexOf('--model'))
  })

  test('absent extraArgs leaves the argv byte-identical (golden safety)', () => {
    const a = buildClaudeSpawn(baseCtx())
    const b = buildClaudeSpawn({ ...baseCtx(), extraArgs: [] })
    // Strip the attempt-dir-dependent system-prompt-file path before comparing.
    const scrub = (cmd: readonly string[]) =>
      cmd.map((t) => (t.includes('aw-extra-args-') ? '<attempt>' : t))
    expect(scrub(b.cmd)).toEqual(scrub(a.cmd))
  })
})

describe('CLAUDE_PLATFORM_OWNED_FLAGS covers the spawn module argv surface', () => {
  test('every --flag literal emitted by spawn.ts is reserved', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runtime', 'claudeCode', 'spawn.ts'),
      'utf8',
    )
    // Flag literals the module can push into cmd (quoted '--…' tokens outside
    // the reserved-set definition itself).
    const withoutSet = src.replace(/CLAUDE_PLATFORM_OWNED_FLAGS[\s\S]*?\]\)/, '')
    const emitted = new Set(
      [...withoutSet.matchAll(/'(--[a-zA-Z][a-zA-Z-]*)'/g)].map((m) => m[1] as string),
    )
    expect(emitted.size).toBeGreaterThan(5)
    for (const flag of emitted) {
      expect(CLAUDE_PLATFORM_OWNED_FLAGS.has(flag)).toBe(true)
    }
  })
})

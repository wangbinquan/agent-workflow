// RFC-028 T7 — locks the runner's inline-MCP injection. The translation
// from our DB shape (env / timeoutMs) to opencode's wire shape
// (environment / timeout) is the single most fragile glue in this RFC:
// if a refactor accidentally emits `env` or `timeoutMs`, opencode's Effect
// Schema rejects the config and the whole spawn aborts.
//
// We also lock:
//   - mcp key absent when no MCPs passed (don't pollute inline JSON)
//   - enabled=false MCPs are skipped
//   - oauth=false is preserved as literal false (NOT { false: ... })
//   - dedupe by name across the closure
//   - no `cwd` field ever sneaks through

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Agent, Mcp } from '@agent-workflow/shared'
import { buildInlineConfig } from '../src/services/runner'

function agent(name: string): Agent {
  return {
    id: 'agent-' + name,
    name,
    description: '',
    outputs: [],
    readonly: false,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function localMcp(name: string, partial: Partial<Mcp['config']> = {}): Mcp {
  return {
    id: 'mcp-' + name,
    name,
    description: '',
    type: 'local',
    config: {
      command: ['uvx', name + '-mcp'],
      ...partial,
    } as Extract<Mcp, { type: 'local' }>['config'],
    enabled: true,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function remoteMcp(name: string, partial: Partial<Mcp['config']> = {}): Mcp {
  return {
    id: 'mcp-' + name,
    name,
    description: '',
    type: 'remote',
    config: {
      url: 'https://' + name + '.io/mcp',
      ...partial,
    } as Extract<Mcp, { type: 'remote' }>['config'],
    enabled: true,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('RFC-028 buildInlineConfig MCP injection', () => {
  test('empty mcps[] → output omits `mcp` key entirely', () => {
    const out = buildInlineConfig(agent('a'), undefined, [], [])
    expect('mcp' in out).toBe(false)
  })

  test('local mcp: command kept; env → environment; timeoutMs → timeout', () => {
    const m = localMcp('pg', {
      command: ['uvx', 'pg-mcp'],
      env: { PG_URL: 'postgresql://localhost/x' },
      timeoutMs: 5000,
    })
    const out = buildInlineConfig(agent('a'), undefined, [], [m])
    expect(out.mcp).toBeDefined()
    const entry = out.mcp!['pg']
    expect(entry).toEqual({
      type: 'local',
      enabled: true,
      command: ['uvx', 'pg-mcp'],
      environment: { PG_URL: 'postgresql://localhost/x' },
      timeout: 5000,
    })
    // Defensive: confirm the opencode-wire names are present and the
    // platform-side names are NOT.
    expect('env' in entry!).toBe(false)
    expect('timeoutMs' in entry!).toBe(false)
    expect('cwd' in entry!).toBe(false)
  })

  test('local mcp: undefined env / timeoutMs are stripped (not emitted as null)', () => {
    const m = localMcp('pg')
    const out = buildInlineConfig(agent('a'), undefined, [], [m])
    const entry = out.mcp!['pg']
    expect(entry).toEqual({
      type: 'local',
      enabled: true,
      command: ['uvx', 'pg-mcp'],
    })
  })

  test('remote mcp: url + headers + oauth pass through; timeoutMs → timeout', () => {
    const m = remoteMcp('sentry', {
      url: 'https://sentry.io/mcp',
      headers: { Authorization: 'Bearer xxx' },
      oauth: { clientId: 'abc', scope: 'read' },
      timeoutMs: 10_000,
    })
    const out = buildInlineConfig(agent('a'), undefined, [], [m])
    expect(out.mcp!['sentry']).toEqual({
      type: 'remote',
      enabled: true,
      url: 'https://sentry.io/mcp',
      headers: { Authorization: 'Bearer xxx' },
      oauth: { clientId: 'abc', scope: 'read' },
      timeout: 10_000,
    })
  })

  test('remote mcp: oauth=false survives as literal false (NOT coerced)', () => {
    const m = remoteMcp('s', { url: 'https://s.io', oauth: false })
    const out = buildInlineConfig(agent('a'), undefined, [], [m])
    expect(out.mcp!['s']!.oauth).toBe(false)
  })

  test('enabled=false → entry omitted entirely from inline output', () => {
    const enabled = localMcp('on')
    const disabled = { ...localMcp('off'), enabled: false } as Mcp
    const out = buildInlineConfig(agent('a'), undefined, [], [enabled, disabled])
    expect(Object.keys(out.mcp ?? {})).toEqual(['on'])
  })

  test('dedupe: same name appearing twice (closure union) collapses to one entry', () => {
    const a = localMcp('shared')
    const b = localMcp('shared')
    const out = buildInlineConfig(agent('a'), undefined, [], [a, b])
    expect(Object.keys(out.mcp ?? {})).toEqual(['shared'])
  })

  test('field-name regression guard: serialized JSON contains "environment" / "timeout", not "env"/"timeoutMs"', () => {
    const m = localMcp('m', {
      command: ['x'],
      env: { K: 'v' },
      timeoutMs: 1234,
    })
    const out = buildInlineConfig(agent('a'), undefined, [], [m])
    const serialized = JSON.stringify(out)
    expect(serialized).toContain('"environment"')
    expect(serialized).toContain('"timeout":1234')
    // The platform-side names MUST NOT appear in the inline shape.
    expect(serialized).not.toContain('"timeoutMs"')
    // Note: "env" by itself can appear in other contexts; we check the JSON
    // does not have it as a key wrapping the env map.
    expect(serialized).not.toContain('"env":{')
  })

  test('source-code lock: buildInlineConfig in runner.ts emits the opencode wire names', () => {
    // Locks the WHY of the test above: a reader who refactors runner.ts can
    // grep for these literal strings to confirm the translation is in place
    // (the test above only catches it in the output of one snapshot input).
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
      'utf-8',
    )
    expect(src).toContain('entry.environment = m.config.env')
    expect(src).toContain('entry.timeout = m.config.timeoutMs')
  })
})

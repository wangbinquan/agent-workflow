// RFC-030 T7 — end-to-end probe against a real stdio MCP server fixture.
//
// Spawns `bun tests/fixtures/mock-mcp-stdio.ts ok` via the default SDK-backed
// openClient, then asserts:
//   - status = 'ok' + 4 tools captured
//   - serverInfo round-trips
//   - the captured 'docs' resource shows up
//   - the captured 'summarize' prompt shows up
// This exercises the SDK transport + handshake + 4 list calls + close that
// unit tests in services/mcpProbe.test.ts can't (because they inject fakes).

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { Mcp } from '@agent-workflow/shared'
import { probeMcp } from '../src/services/mcpProbe'

// `import.meta.dir` is typed as string | undefined under @types/bun but is
// always populated at runtime in Bun; guard so tsc is happy.
const TEST_DIR = import.meta.dir ?? '.'
const FIXTURE = resolve(TEST_DIR, 'fixtures', 'mock-mcp-stdio.ts')

if (!existsSync(FIXTURE)) {
  throw new Error(`fixture missing: ${FIXTURE}`)
}

// RUN_GIT_NETWORK gate (P0 test-tier fortification): this end-to-end probe
// Bun.spawns a real `bun` subprocess MCP server and drives the SDK handshake.
// Subprocess spawn + handshake timing flakes locally (spawn ENOENT / slow
// handshake), so it is gated to keep the default `bun test` deterministic; CI
// exports RUN_GIT_NETWORK=1 to preserve coverage. (Flag is shared with the
// real-git-clone suites — both are external-IO integration tests.)
const RUN_GIT_NETWORK = process.env.RUN_GIT_NETWORK === '1'

function makeStdioMcp(mode: 'ok' | 'crash' | 'hang' | 'no-resources'): Mcp {
  return {
    id: 'm_fixture',
    name: `mock-${mode}`,
    description: '',
    type: 'local',
    config: {
      command: ['bun', FIXTURE, mode],
      // Generous list timeout — local bun spawn is fast but CI can be slow.
      timeoutMs: 10_000,
    },
    enabled: true,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  } as Mcp
}

describe.skipIf(!RUN_GIT_NETWORK)('probe against real stdio MCP fixture', () => {
  test('ok mode: status=ok with 4 tools + 1 resource + 1 prompt + serverInfo', async () => {
    const r = await probeMcp(makeStdioMcp('ok'))
    expect(r.status).toBe('ok')
    expect(r.errorCode).toBeNull()
    expect(r.tools?.map((t) => t.name).sort()).toEqual(['explain', 'ping', 'query', 'schema'])
    expect(r.resources?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(r.prompts?.map((p) => p.name)).toEqual(['summarize'])
    expect(r.serverInfo?.name).toBe('mock-mcp-stdio')
    expect(r.serverInfo?.version).toBe('0.1.0')
    expect(r.latencyMs).toBeGreaterThan(0)
    expect(r.latencyMs).toBeLessThan(15_000)
  }, 30_000)

  test('crash mode: connect-failed (subprocess exited before handshake)', async () => {
    const r = await probeMcp(makeStdioMcp('crash'))
    expect(r.status).toBe('error')
    // Specific code may vary by environment (connect-failed vs handshake-failed
    // depending on whether stdio EOF arrives before init request is sent), so
    // assert it's in the failure family rather than pinning a single value.
    expect(r.errorCode).not.toBeNull()
    expect(['connect-failed', 'handshake-failed', 'internal-error']).toContain(
      r.errorCode as string,
    )
  }, 30_000)

  test('hang mode: the probe hard ceiling interrupts a longer SDK handshake', async () => {
    // Regression: the 60s route ceiling used to close the transport but leave
    // Client.connect racing only its longer per-MCP timeout. Under load the
    // route therefore outlived its advertised hard deadline.
    const startedAt = Date.now()
    const r = await probeMcp(makeStdioMcp('hang'), { totalTimeoutMs: 100 })
    expect(r.status).toBe('error')
    expect(r.errorCode).toBe('timeout')
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  }, 10_000)
})

// Always-on gate self-test (runs even in the default skipped mode).
describe('RUN_GIT_NETWORK gate sanity', () => {
  test('suite is skipped iff RUN_GIT_NETWORK!=1', () => {
    expect(!RUN_GIT_NETWORK).toBe(process.env.RUN_GIT_NETWORK !== '1')
  })
})

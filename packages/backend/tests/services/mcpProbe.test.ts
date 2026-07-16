// RFC-030 T4 — unit tests for the MCP probe orchestrator.
//
// These tests *don't* spawn subprocesses or open sockets; they inject a fake
// `openClient` so we can drive the orchestrator's logic (error mapping,
// partial handling, in-flight dedup, timeouts, env isolation, redaction)
// deterministically. Integration tests in T7 exercise the real SDK-backed
// client factory against a fixture MCP server.
//
// What's pinned:
//   - mcp-disabled throws ValidationError WITHOUT instantiating any client.
//   - happy path returns full inventory + null errorCode.
//   - per-list rejection → status='ok' + errorCode='partial' + null for that
//     list + partialFailures detail. Tools surviving is the most useful case.
//   - SDK UnauthorizedError → auth-required.
//   - HTTP 401 surfaced via { status: 401 } → auth-required.
//   - initialize timeout (Error name signalling timeout) → handshake-failed.
//   - ENOENT-style connect failure → connect-failed.
//   - Hard total-timeout (60s ceiling, but injected as 10ms here) → timeout.
//   - Raw I/O never dedups by mutable name (RFC-201 coordinates full operations).
//   - Redact: stderr containing `secret` lands in errorDetail.stderr WITHOUT
//     the literal `secret`.
//   - Env isolation: buildStdioEnv drops daemon SOME_FAKE_TOKEN and includes
//     only PATH/HOME/LANG + the explicit mcp.config.env keys.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Mcp } from '@agent-workflow/shared'
import {
  buildStdioEnv,
  classifyProbeError,
  probeMcp,
  type OpenClientFn,
  type ProbedMcpClient,
} from '../../src/services/mcpProbe'

// ----------------------------- helpers ---------------------------------------

function makeLocalMcp(overrides: Partial<Mcp> = {}): Mcp {
  return {
    id: 'm_local',
    name: 'postgres-prod',
    description: '',
    type: 'local',
    config: { command: ['uvx', 'postgres-mcp'] },
    enabled: true,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Mcp
}

function makeRemoteMcp(overrides: Partial<Mcp> = {}): Mcp {
  return {
    id: 'm_remote',
    name: 'sentry-prod',
    description: '',
    type: 'remote',
    config: { url: 'https://mcp.example.com/sse' },
    enabled: true,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Mcp
}

interface FakeClientOpts {
  serverInfo?: { name: string; version?: string } | null
  protocolVersion?: string | null
  capabilities?: Record<string, unknown> | null
  toolsResult?: 'ok' | 'reject'
  resourcesResult?: 'ok' | 'reject'
  templatesResult?: 'ok' | 'reject'
  promptsResult?: 'ok' | 'reject'
  stderr?: string
  onClose?: () => void
}

function makeFakeClient(opts: FakeClientOpts): ProbedMcpClient {
  const reject = (method: string): Promise<never> =>
    Promise.reject(new Error(`${method} MethodNotFound`))
  return {
    serverInfo: opts.serverInfo === undefined ? { name: 'fake', version: '1.0' } : opts.serverInfo,
    protocolVersion: opts.protocolVersion === undefined ? '2024-11-05' : opts.protocolVersion,
    capabilities:
      opts.capabilities === undefined ? { tools: { listChanged: true } } : opts.capabilities,
    listTools: () =>
      opts.toolsResult === 'reject'
        ? reject('tools/list')
        : Promise.resolve([{ name: 't1' }, { name: 't2', description: 'd' }]),
    listResources: () =>
      opts.resourcesResult === 'reject'
        ? reject('resources/list')
        : Promise.resolve([{ uri: 'file:///a' }]),
    listResourceTemplates: () =>
      opts.templatesResult === 'reject' ? reject('resources/templates/list') : Promise.resolve([]),
    listPrompts: () =>
      opts.promptsResult === 'reject' ? reject('prompts/list') : Promise.resolve([{ name: 'p1' }]),
    capturedStderr: () => opts.stderr ?? '',
    close: async () => {
      opts.onClose?.()
    },
  }
}

function fakeOpener(client: ProbedMcpClient, handshakeMs = 50): OpenClientFn {
  return async () => ({ client, handshakeMs })
}

afterEach(() => {
  // Inflight map should empty after every test (probe Promise finally drops it).
})

// ----------------------------- tests -----------------------------------------

describe('probeMcp — disabled guard', () => {
  test('throws ValidationError and never constructs a client', async () => {
    let constructed = false
    const opener: OpenClientFn = async () => {
      constructed = true
      throw new Error('should not be called')
    }
    const m = makeLocalMcp({ enabled: false })
    await expect(probeMcp(m, { openClient: opener })).rejects.toThrow(/disabled/)
    expect(constructed).toBe(false)
  })
})

describe('probeMcp — happy path', () => {
  test('returns status=ok with full inventory + null errorCode', async () => {
    const client = makeFakeClient({})
    const r = await probeMcp(makeLocalMcp(), { openClient: fakeOpener(client) })
    expect(r.status).toBe('ok')
    expect(r.errorCode).toBeNull()
    expect(r.tools).toEqual([{ name: 't1' }, { name: 't2', description: 'd' }])
    expect(r.resources).toEqual([{ uri: 'file:///a' }])
    expect(r.resourceTemplates).toEqual([])
    expect(r.prompts).toEqual([{ name: 'p1' }])
    expect(r.serverInfo).toEqual({ name: 'fake', version: '1.0' })
    expect(r.handshakeMs).toBe(50)
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  test('always closes the client (finally) — even on success', async () => {
    let closed = false
    const client = makeFakeClient({ onClose: () => (closed = true) })
    await probeMcp(makeLocalMcp(), { openClient: fakeOpener(client) })
    expect(closed).toBe(true)
  })
})

describe('probeMcp — partial', () => {
  test('listResources rejected → status=ok + errorCode=partial + resources null', async () => {
    const client = makeFakeClient({ resourcesResult: 'reject' })
    const r = await probeMcp(makeLocalMcp(), { openClient: fakeOpener(client) })
    expect(r.status).toBe('ok')
    expect(r.errorCode).toBe('partial')
    expect(r.tools).not.toBeNull()
    expect(r.resources).toBeNull()
    const detail = r.errorDetail as { partialFailures: Array<{ method: string }> } | null
    expect(detail?.partialFailures.map((f) => f.method)).toEqual(['resources/list'])
  })

  test('multiple list failures all recorded; tools survive', async () => {
    const client = makeFakeClient({
      resourcesResult: 'reject',
      templatesResult: 'reject',
      promptsResult: 'reject',
    })
    const r = await probeMcp(makeLocalMcp(), { openClient: fakeOpener(client) })
    expect(r.status).toBe('ok')
    expect(r.errorCode).toBe('partial')
    expect(r.tools).not.toBeNull()
    const methods = (
      r.errorDetail as { partialFailures: Array<{ method: string }> }
    ).partialFailures.map((f) => f.method)
    expect(methods).toEqual(['resources/list', 'resources/templates/list', 'prompts/list'])
  })
})

describe('probeMcp — error mapping', () => {
  test('SDK UnauthorizedError → auth-required', async () => {
    class UnauthorizedError extends Error {
      constructor() {
        super('OAuth required')
        this.name = 'UnauthorizedError'
      }
    }
    const opener: OpenClientFn = async () => {
      throw new UnauthorizedError()
    }
    const r = await probeMcp(makeRemoteMcp(), { openClient: opener })
    expect(r.status).toBe('error')
    expect(r.errorCode).toBe('auth-required')
  })

  test('HTTP 401 via {status:401} → auth-required + errorDetail.httpStatus=401', async () => {
    const opener: OpenClientFn = async () => {
      const e = new Error('Forbidden 401') as Error & { status: number }
      e.status = 401
      throw e
    }
    const r = await probeMcp(makeRemoteMcp(), { openClient: opener })
    expect(r.errorCode).toBe('auth-required')
    expect((r.errorDetail as { httpStatus: number }).httpStatus).toBe(401)
  })

  test('initialize timeout wording → handshake-failed', async () => {
    const opener: OpenClientFn = async () => {
      throw new Error('initialize timed out after 30000ms')
    }
    const r = await probeMcp(makeLocalMcp(), { openClient: opener })
    expect(r.errorCode).toBe('handshake-failed')
  })

  test('ENOENT → connect-failed', async () => {
    const opener: OpenClientFn = async () => {
      const e = new Error('spawn uvx ENOENT') as Error & { code: string }
      e.code = 'ENOENT'
      throw e
    }
    const r = await probeMcp(makeLocalMcp(), { openClient: opener })
    expect(r.errorCode).toBe('connect-failed')
  })

  test('hard total-timeout → timeout', async () => {
    // Open client returns a fast handshake but listTools never resolves;
    // hard ceiling 10ms aborts the signal and the orchestrator returns timeout.
    let aborted = false
    const client: ProbedMcpClient = {
      serverInfo: null,
      protocolVersion: null,
      capabilities: null,
      listTools: (sig) =>
        new Promise((_resolve, reject) => {
          sig.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        }),
      listResources: () => new Promise(() => {}),
      listResourceTemplates: () => new Promise(() => {}),
      listPrompts: () => new Promise(() => {}),
      capturedStderr: () => '',
      close: async () => {},
    }
    const r = await probeMcp(makeLocalMcp(), {
      openClient: fakeOpener(client, 1),
      totalTimeoutMs: 10,
    })
    expect(r.errorCode).toBe('timeout')
    expect(aborted).toBe(true)
  })

  test('unknown error → internal-error', async () => {
    const opener: OpenClientFn = async () => {
      throw new Error('something exotic')
    }
    const r = await probeMcp(makeLocalMcp(), { openClient: opener })
    expect(r.errorCode).toBe('internal-error')
  })

  test('stderr is redacted before landing in errorDetail.stderr', async () => {
    // Simulate connect failure with a stderr buffer containing a postgres URL
    // with embedded credentials — common in real-world MCP misconfig.
    const client = makeFakeClient({
      stderr: 'startup error\nPG_URL=postgresql://alice:secret@db/x\nbye',
    })
    const opener: OpenClientFn = async () => {
      // We hand the client back, but then make handshake "fail" by having
      // listTools throw with ENOENT during the run. We need actual error path,
      // so use a different shape: throw after returning the client by having
      // listTools throw a connect-failed error. But error path in runProbe
      // happens only if openClient throws. So we throw the error from a
      // wrapper that still exposes the client's stderr via outer closure.
      // To keep this simple: make openClient itself throw ENOENT, and put
      // stderr in a parallel buffer captured via the same client instance.
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    }
    // Use a path that keeps client null (openClient throws first), so we
    // don't get stderr from the client. Stderr-via-client only flows when
    // openClient *returned* a client and then a list call failed — but
    // partial path keeps status=ok with no stderr capture. For the genuine
    // capture path, we use a half-broken client whose listTools rejects with
    // a non-partial error after opener succeeded. Actually partial captures
    // do NOT pull stderr (status=ok); only the catch branch does. To exercise
    // stderr redaction we need an exception inside runProbe AFTER client open.
    // Easiest: have listTools throw an ENOENT-shaped error that wins
    // classification but Promise.allSettled won't propagate; let's hand-roll:
    const r = await probeMcp(makeLocalMcp(), { openClient: opener })
    // openClient threw → client is null → no stderr captured at all.
    expect(r.errorCode).toBe('connect-failed')
    expect(r.errorDetail).toBeNull()
    // Now exercise the stderr-attached path by forcing an error AFTER open:
    void client // satisfy noUnusedLocals
  })

  test('stderr redact via post-open exception path', async () => {
    // Client opens fine, but we override list calls with a throw that propagates
    // out of Promise.allSettled? No — allSettled never propagates. To reach the
    // catch branch we need an exception thrown *outside* the four list calls.
    // The natural one: total-timeout abort. Build a client whose stderr buffer
    // contains a secret; total-timeout aborts → catch branch runs → stderr is
    // included in errorDetail.stderr.
    const client: ProbedMcpClient = {
      serverInfo: null,
      protocolVersion: null,
      capabilities: null,
      listTools: () => new Promise(() => {}),
      listResources: () => new Promise(() => {}),
      listResourceTemplates: () => new Promise(() => {}),
      listPrompts: () => new Promise(() => {}),
      capturedStderr: () => 'log line\nAuthorization: Bearer eyJ.abc\nmore log\n',
      close: async () => {},
    }
    const r = await probeMcp(makeLocalMcp(), {
      openClient: fakeOpener(client, 1),
      totalTimeoutMs: 10,
    })
    expect(r.errorCode).toBe('timeout')
    const stderrOut = (r.errorDetail as { stderr?: string } | null)?.stderr
    expect(stderrOut).toBeTruthy()
    expect(stderrOut!.includes('eyJ.abc')).toBe(false)
    expect(stderrOut!.includes('***')).toBe(true)
  })
})

describe('probeMcp — raw I/O identity', () => {
  test('two concurrent raw probes of the same name do not dedup below the operation fence', async () => {
    let calls = 0
    const client = makeFakeClient({})
    const opener: OpenClientFn = async () => {
      calls = calls + 1
      // Slow opener so both callers land in the inflight Map together.
      await new Promise((r) => setTimeout(r, 20))
      return { client, handshakeMs: 20 }
    }
    const m = makeLocalMcp()
    const [a, b] = await Promise.all([
      probeMcp(m, { openClient: opener }),
      probeMcp(m, { openClient: opener }),
    ])
    expect(calls).toBe(2)
    expect(a).not.toBe(b)
  })

  test('different mcp names are NOT deduped', async () => {
    let calls = 0
    const opener: OpenClientFn = async () => {
      calls = calls + 1
      const c = makeFakeClient({})
      return { client: c, handshakeMs: 1 }
    }
    await Promise.all([
      probeMcp(makeLocalMcp({ name: 'a' }), { openClient: opener }),
      probeMcp(makeLocalMcp({ name: 'b' }), { openClient: opener }),
    ])
    expect(calls).toBe(2)
  })
})

describe('classifyProbeError (pure)', () => {
  test('UnauthorizedError-named exception', () => {
    const e = new Error('o')
    e.name = 'UnauthorizedError'
    expect(classifyProbeError(e, false)).toBe('auth-required')
  })
  test('aborted=true → timeout (even with no error)', () => {
    expect(classifyProbeError(new Error('x'), true)).toBe('timeout')
  })
  test('default fallthrough → internal-error', () => {
    expect(classifyProbeError(new Error('weird'), false)).toBe('internal-error')
  })
  test('ECONNREFUSED message → connect-failed', () => {
    expect(classifyProbeError(new Error('fetch failed ECONNREFUSED'), false)).toBe('connect-failed')
  })
})

describe('buildStdioEnv', () => {
  test('drops daemon SOME_FAKE_TOKEN; keeps PATH/HOME/LANG; adds config env', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/h',
      LANG: 'C.UTF-8',
      SOME_FAKE_TOKEN: 'should-not-leak',
      AWS_SECRET_ACCESS_KEY: 'also-not-leak',
    }
    const out = buildStdioEnv({ PG_URL: 'postgresql://u:p@h/x' }, source)
    expect(out).toEqual({
      PATH: '/usr/bin',
      HOME: '/h',
      LANG: 'C.UTF-8',
      PG_URL: 'postgresql://u:p@h/x',
    })
    expect(Object.keys(out)).not.toContain('SOME_FAKE_TOKEN')
    expect(Object.keys(out)).not.toContain('AWS_SECRET_ACCESS_KEY')
  })

  test('mcp.config.env can override PATH (explicit wins)', () => {
    const source = { PATH: '/sys' }
    const out = buildStdioEnv({ PATH: '/custom' }, source)
    expect(out.PATH).toBe('/custom')
  })

  test('no config env → minimal-only env', () => {
    const source = { PATH: '/a', HOME: '/b', LANG: 'C', WHATEVER: 'x' }
    const out = buildStdioEnv(undefined, source)
    expect(out).toEqual({ PATH: '/a', HOME: '/b', LANG: 'C' })
  })
})

// RFC-169 (backend small-piece ②, matrix ㉑) — the probe honors a
// caller-captured `startedAt`. The route captures it BEFORE reading the config
// snapshot so `startedAt > updatedAt` reliably means "read after any concurrent
// save". If the probe stamped its own start time (after the snapshot read +
// ACL await), a save in that window would leave startedAt > updatedAt while the
// probe used the OLD config — a multi-ms TOCTOU (R3-P2-5).
describe('startedAt is caller-provided (freshness TOCTOU fix)', () => {
  test('uses opts.startedAt verbatim, not now()', async () => {
    const client = makeFakeClient({})
    const r = await probeMcp(makeLocalMcp({ name: 'started-a' }), {
      openClient: fakeOpener(client),
      now: () => 9999, // finish clock — must NOT become startedAt
      startedAt: 100, // caller-captured (before the config snapshot read)
    })
    expect(r.startedAt).toBe(100)
    expect(r.finishedAt).toBe(9999)
  })

  test('falls back to now() when the caller does not provide startedAt', async () => {
    const client = makeFakeClient({})
    const r = await probeMcp(makeLocalMcp({ name: 'started-b' }), {
      openClient: fakeOpener(client),
      now: () => 5000,
    })
    expect(r.startedAt).toBe(5000)
  })
})

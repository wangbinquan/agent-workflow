// RFC-234 §1 (T2) — behavior lock for the runSystemAgent primitive:
// scratch lifecycle under an app-home parent (success removes, failure
// RETAINS — design §1.2 / Codex design-gate P1-7), platform-side seed files,
// seed path traversal rejection, envelope-source event text accumulation,
// timeout/abort escalation, and diagnostics masking. Uses the shared
// mock-opencode fixture via testOnlyUnverifiedRuntime (runtime-smoke.test.ts
// precedent).

import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assertSafeSeedPath,
  releaseSystemAgentScratch,
  runSystemAgent,
} from '../src/services/systemAgentRun'
import type { SystemAgentEventSinkV1 } from '../src/services/sessionEventSink'
import type { Logger } from '../src/util/log'

const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const MOCK_CLAUDE = resolve(import.meta.dir, 'fixtures', 'mock-claude.ts')

// RFC-254: a full spawn command head `[bun, run, <mock>]` (baseOpts routes an
// array through opencodeCmd, a string through runtimeBinary). This WAS a
// `#!/bin/sh` wrapper file — unspawnable on Windows; spawning bun directly
// streams natively on every OS (runtime-smoke.test.ts precedent).
function wrapperFor(mockFile: string): readonly string[] {
  return [process.execPath, 'run', mockFile]
}

// RFC-254: a runtime whose DIRECT child exits 0 but leaves a detached grandchild
// holding the inherited stdout pipe open — runSystemAgent must see the child exit
// yet still hit a post-exit-flush-timeout. Was `#!/bin/sh\n(sleep 3; echo …) &`
// (POSIX backgrounding); the portable form spawns an unref'd grandchild that
// writes after 3s with inherited stdout, then the parent exits immediately.
function wrapperHoldingStdoutOpen(): readonly string[] {
  const dir = mkdtempSync(join(tmpdir(), 'aw-sysrun-bin-'))
  const grandchild = join(dir, 'late-writer.ts')
  writeFileSync(grandchild, "setTimeout(() => process.stdout.write('late-evidence\\n'), 3000)\n")
  const holder = join(dir, 'hold-stdout.ts')
  writeFileSync(
    holder,
    [
      `const child = Bun.spawn([process.execPath, 'run', ${JSON.stringify(grandchild)}], { stdout: 'inherit', stdin: 'ignore', stderr: 'ignore' })`,
      'child.unref()',
      'process.exit(0)',
      '',
    ].join('\n'),
  )
  return [process.execPath, 'run', holder]
}

const SET_ENV_KEYS = [
  'MOCK_OPENCODE_ECHO_PROMPT',
  'MOCK_OPENCODE_EMIT_SESSION_ID',
  'MOCK_OPENCODE_EXIT_CODE',
  'MOCK_OPENCODE_DELAY_MS',
  'MOCK_OPENCODE_STDERR',
  'MOCK_OPENCODE_EVENTS',
  'MOCK_OPENCODE_RAW_AGENT_TEXT',
  'MOCK_OPENCODE_SKIP_ENVELOPE',
  'MOCK_CLAUDE_SESSION_ID',
  'MOCK_CLAUDE_NON_INIT_SESSION_ID',
  'MOCK_CLAUDE_RESET_SESSION_ID',
  'MOCK_CLAUDE_RESET_CONVERSATION_ID',
  'MOCK_CLAUDE_STOP_AFTER_RESET',
  'MOCK_CLAUDE_SKIP_ASSISTANT',
  'MOCK_CLAUDE_PARALLEL_SUBAGENT_SESSION_IDS',
  'MOCK_CLAUDE_ECHO_PROMPT',
]
const testUnlessWindows = test.skipIf(process.platform === 'win32')

afterEach(() => {
  for (const k of SET_ENV_KEYS) delete process.env[k]
})

function scratchParentDir(): string {
  return mkdtempSync(join(tmpdir(), 'aw-sysrun-scratch-'))
}

const baseOpts = (scratchParent: string, binary: string | readonly string[]) => ({
  feature: 'intent-builder',
  agentName: 'aw-intent-builder',
  systemPrompt: 'You are a test system agent.',
  prompt: 'echo this back: sysrun-nonce-42',
  protocol: 'opencode' as const,
  // RFC-254: a command-array binary (wrapperFor → [bun, run, mock]) rides the
  // opencodeCmd seam (Windows-spawnable); a plain path stays runtimeBinary. An
  // UNBRANDED opencodeCmd + testOnlyUnverifiedRuntime is the same legacy
  // buildSpawn branch as runtimeBinary (systemAgentRun.ts:463/479 both feed
  // driver.buildSpawn; opencode driver prefers opencodeCmd) — byte-identical
  // behavior, only the head becomes Windows-spawnable.
  ...(typeof binary === 'string' ? { runtimeBinary: binary } : { binaryOverride: binary }),
  scratchParent,
  testOnlyUnverifiedRuntime: true,
  timeoutMs: 20_000,
})

describe('runSystemAgent', () => {
  test('ok path: event text accumulated, scratch removed', async () => {
    process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
    process.env.MOCK_OPENCODE_EMIT_SESSION_ID = 'sysrun-sess-1'
    const scratchParent = scratchParentDir()
    const r = await runSystemAgent({
      ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
      scratchName: 'turn-ok',
    })
    expect(r.status).toBe('ok')
    expect(r.exitCode).toBe(0)
    expect(r.eventText).toContain('sysrun-nonce-42')
    expect(r.capturedSessionId).toBe('sysrun-sess-1')
    expect(r.scratchRetained).toBe(false)
    expect(r.outputEvidence).toMatchObject({
      assistantTextSeen: true,
      eventTextCapHit: false,
      lastNormalizedEventKind: 'text',
      lastRuntimeEventType: 'text',
      terminalResult: 'not-observed',
    })
    expect(r.outputEvidence.observedAssistantTextBytes).toBe(
      r.outputEvidence.retainedAssistantTextBytes,
    )
    expect(existsSync(join(scratchParent, 'turn-ok'))).toBe(false)
  })

  test('Claude parallel subagent ids stay event-local in the system-agent path', async () => {
    process.env.MOCK_CLAUDE_SESSION_ID = 'system-parallel-root'
    process.env.MOCK_CLAUDE_PARALLEL_SUBAGENT_SESSION_IDS = JSON.stringify([
      'system-child-a',
      'system-child-b',
      'system-child-c',
    ])
    process.env.MOCK_CLAUDE_ECHO_PROMPT = '1'
    const roots: Array<[string, string | undefined]> = []
    const payloads: string[] = []
    const terminals: string[] = []
    const sink: SystemAgentEventSinkV1 = {
      append: async (event) => {
        payloads.push(event.payload)
      },
      setRootSessionId: async (id, previous) => {
        roots.push([id, previous])
      },
      markTerminal: async (state) => {
        terminals.push(state)
      },
    }

    const result = await runSystemAgent({
      ...baseOpts(scratchParentDir(), wrapperFor(MOCK_CLAUDE)),
      protocol: 'claude-code',
      eventSink: sink,
    })

    expect(result.status).toBe('ok')
    expect(result.capturedSessionId).toBe('system-parallel-root')
    expect(roots).toEqual([['system-parallel-root', undefined]])
    expect(payloads.some((payload) => payload.includes('system-child-a'))).toBe(true)
    expect(terminals).toEqual(['complete'])
  })

  test('Claude conversation_reset rotates the system-agent root and completes on B', async () => {
    process.env.MOCK_CLAUDE_SESSION_ID = 'system-reset-a'
    process.env.MOCK_CLAUDE_RESET_SESSION_ID = 'system-reset-b'
    process.env.MOCK_CLAUDE_RESET_CONVERSATION_ID = 'system-ui-key'
    process.env.MOCK_CLAUDE_ECHO_PROMPT = '1'
    const calls: string[] = []
    const sink: SystemAgentEventSinkV1 = {
      append: async (event) => {
        const frame = JSON.parse(event.payload) as { type?: string }
        calls.push(`append:${frame.type ?? event.kind}`)
      },
      setRootSessionId: async (id, previous) => {
        calls.push(`root:${previous ?? '-'}->${id}`)
      },
      markRootSessionResetPending: async (id) => {
        calls.push(`pending:${id}`)
      },
      markTerminal: async (state) => {
        calls.push(`terminal:${state}`)
      },
    }

    const result = await runSystemAgent({
      ...baseOpts(scratchParentDir(), wrapperFor(MOCK_CLAUDE)),
      protocol: 'claude-code',
      eventSink: sink,
    })

    expect(result.status).toBe('ok')
    expect(result.capturedSessionId).toBe('system-reset-b')
    expect(result.nativeSessionIntegrityFailed).toBeUndefined()
    expect(calls).toEqual([
      'root:-->system-reset-a',
      'append:system',
      'pending:system-reset-a',
      'append:conversation_reset',
      'root:system-reset-a->system-reset-b',
      'append:assistant',
      'append:result',
      'terminal:complete',
    ])
  })

  test('Claude reset can resolve directly from the replacement result without a second init', async () => {
    process.env.MOCK_CLAUDE_SESSION_ID = 'system-result-only-a'
    process.env.MOCK_CLAUDE_RESET_SESSION_ID = 'system-result-only-b'
    process.env.MOCK_CLAUDE_RESET_CONVERSATION_ID = 'system-result-only-ui-key'
    process.env.MOCK_CLAUDE_SKIP_ASSISTANT = '1'
    const calls: string[] = []
    const sink: SystemAgentEventSinkV1 = {
      append: async (event) => {
        const frame = JSON.parse(event.payload) as { type?: string }
        calls.push(`append:${frame.type ?? event.kind}`)
      },
      setRootSessionId: async (id, previous) => {
        calls.push(`root:${previous ?? '-'}->${id}`)
      },
      markRootSessionResetPending: async (id) => {
        calls.push(`pending:${id}`)
      },
      markTerminal: async (state) => {
        calls.push(`terminal:${state}`)
      },
    }

    const result = await runSystemAgent({
      ...baseOpts(scratchParentDir(), wrapperFor(MOCK_CLAUDE)),
      protocol: 'claude-code',
      eventSink: sink,
    })

    expect(result.status).toBe('ok')
    expect(result.capturedSessionId).toBe('system-result-only-b')
    expect(calls).toEqual([
      'root:-->system-result-only-a',
      'append:system',
      'pending:system-result-only-a',
      'append:conversation_reset',
      'root:system-result-only-a->system-result-only-b',
      'append:result',
      'terminal:complete',
    ])
  })

  test('Claude reset EOF returns no stale id and settles capture incomplete', async () => {
    process.env.MOCK_CLAUDE_SESSION_ID = 'system-reset-stale'
    process.env.MOCK_CLAUDE_RESET_SESSION_ID = 'system-reset-never-observed'
    process.env.MOCK_CLAUDE_STOP_AFTER_RESET = '1'
    const terminals: string[] = []
    const sink: SystemAgentEventSinkV1 = {
      append: async () => {},
      setRootSessionId: async () => {},
      markRootSessionResetPending: async () => {},
      markTerminal: async (state) => {
        terminals.push(state)
      },
    }

    const result = await runSystemAgent({
      ...baseOpts(scratchParentDir(), wrapperFor(MOCK_CLAUDE)),
      protocol: 'claude-code',
      eventSink: sink,
    })

    expect(result.status).toBe('exit-nonzero')
    expect(result.capturedSessionId).toBeUndefined()
    expect(result.nativeSessionIntegrityFailed).toBe(true)
    expect(terminals).toEqual(['incomplete'])
  })

  test('Claude root id change without reset fails integrity and returns no resumable id', async () => {
    process.env.MOCK_CLAUDE_SESSION_ID = 'system-root-before-mismatch'
    process.env.MOCK_CLAUDE_NON_INIT_SESSION_ID = 'system-root-after-mismatch'
    const terminals: string[] = []
    const sink: SystemAgentEventSinkV1 = {
      append: async () => {},
      setRootSessionId: async () => {},
      markTerminal: async (state) => {
        terminals.push(state)
      },
    }

    const result = await runSystemAgent({
      ...baseOpts(scratchParentDir(), wrapperFor(MOCK_CLAUDE)),
      protocol: 'claude-code',
      eventSink: sink,
    })

    expect(result.status).toBe('exit-nonzero')
    expect(result.capturedSessionId).toBeUndefined()
    expect(result.nativeSessionIntegrityFailed).toBe(true)
    expect(result.stderrTail).toContain('without a conversation reset')
    expect(terminals).toEqual(['incomplete'])
  })

  test('auxiliary sink claim failure does not change the system-agent business result', async () => {
    process.env.MOCK_CLAUDE_SESSION_ID = 'system-auxiliary-root'
    process.env.MOCK_CLAUDE_ECHO_PROMPT = '1'
    const terminals: string[] = []
    const sink: SystemAgentEventSinkV1 = {
      append: async () => {},
      setRootSessionId: async () => {
        throw new Error('auxiliary evidence database unavailable')
      },
      markTerminal: async (state) => {
        terminals.push(state)
      },
    }

    const result = await runSystemAgent({
      ...baseOpts(scratchParentDir(), wrapperFor(MOCK_CLAUDE)),
      protocol: 'claude-code',
      eventSink: sink,
    })

    expect(result.status).toBe('ok')
    expect(result.capturedSessionId).toBe('system-auxiliary-root')
    expect(result.nativeSessionIntegrityFailed).toBeUndefined()
    expect(terminals).toEqual(['incomplete'])
  })

  test('authoritative sink claim failure aborts the child and invalidates resume identity', async () => {
    process.env.MOCK_CLAUDE_SESSION_ID = 'system-authoritative-root'
    process.env.MOCK_CLAUDE_ECHO_PROMPT = '1'
    const terminals: string[] = []
    const sink: SystemAgentEventSinkV1 = {
      append: async () => {},
      setRootSessionId: async () => {
        throw new Error('native session owner conflict')
      },
      markTerminal: async (state) => {
        terminals.push(state)
      },
    }

    const result = await runSystemAgent({
      ...baseOpts(scratchParentDir(), wrapperFor(MOCK_CLAUDE)),
      protocol: 'claude-code',
      eventSink: sink,
      nativeIdentityAuthoritative: true,
    })

    expect(result.status).toBe('exit-nonzero')
    expect(result.capturedSessionId).toBeUndefined()
    expect(result.nativeSessionIntegrityFailed).toBe(true)
    expect(result.stderrTail).toContain('runtime native session claim failed')
    expect(terminals).toEqual(['incomplete'])
  })

  test('authoritative reset rotation still runs after reset evidence persistence fails', async () => {
    process.env.MOCK_CLAUDE_SESSION_ID = 'system-authoritative-reset-a'
    process.env.MOCK_CLAUDE_RESET_SESSION_ID = 'system-authoritative-reset-b'
    process.env.MOCK_CLAUDE_RESET_CONVERSATION_ID = 'system-authoritative-reset-ui'
    process.env.MOCK_CLAUDE_ECHO_PROMPT = '1'
    const calls: string[] = []
    const sink: SystemAgentEventSinkV1 = {
      append: async (event) => {
        const frame = JSON.parse(event.payload) as { type?: string }
        calls.push(`append:${frame.type ?? event.kind}`)
        if (frame.type === 'conversation_reset') {
          throw new Error('reset evidence database unavailable')
        }
      },
      setRootSessionId: async (id, previous) => {
        calls.push(`root:${previous ?? '-'}->${id}`)
      },
      markRootSessionResetPending: async (id) => {
        calls.push(`pending:${id}`)
      },
      markTerminal: async (state) => {
        calls.push(`terminal:${state}`)
      },
    }

    const result = await runSystemAgent({
      ...baseOpts(scratchParentDir(), wrapperFor(MOCK_CLAUDE)),
      protocol: 'claude-code',
      eventSink: sink,
      nativeIdentityAuthoritative: true,
    })

    expect(result.status).toBe('ok')
    expect(result.capturedSessionId).toBe('system-authoritative-reset-b')
    expect(result.nativeSessionIntegrityFailed).toBeUndefined()
    expect(calls).toEqual([
      'root:-->system-authoritative-reset-a',
      'append:system',
      'pending:system-authoritative-reset-a',
      'append:conversation_reset',
      'terminal:incomplete',
      'root:system-authoritative-reset-a->system-authoritative-reset-b',
    ])
  })

  test('output evidence distinguishes cap truncation and a terminal event without text', async () => {
    process.env.MOCK_OPENCODE_RAW_AGENT_TEXT = 'ééé'
    const capped = await runSystemAgent({
      ...baseOpts(scratchParentDir(), wrapperFor(MOCK_OPENCODE)),
      maxEventTextBytes: 5,
    })
    expect(capped.eventText).toBe('')
    expect(capped.outputEvidence).toMatchObject({
      assistantTextSeen: true,
      observedAssistantTextBytes: 6,
      retainedAssistantTextBytes: 0,
      eventTextCapHit: true,
    })

    delete process.env.MOCK_OPENCODE_RAW_AGENT_TEXT
    process.env.MOCK_OPENCODE_SKIP_ENVELOPE = '1'
    process.env.MOCK_OPENCODE_EVENTS = JSON.stringify([{ type: 'step_finish' }])
    const terminal = await runSystemAgent({
      ...baseOpts(scratchParentDir(), wrapperFor(MOCK_OPENCODE)),
    })
    expect(terminal.outputEvidence).toMatchObject({
      assistantTextSeen: false,
      lastRuntimeEventType: 'step_finish',
      lastNormalizedEventKind: 'step_finish',
      terminalResult: 'success',
    })
  })

  test('seed files land in worktree before spawn; failure retains scratch', async () => {
    process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
    process.env.MOCK_OPENCODE_EXIT_CODE = '3'
    const scratchParent = scratchParentDir()
    const r = await runSystemAgent({
      ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
      scratchName: 'turn-fail',
      seedFiles: [
        { path: 'INTENT.md', content: '# intent' },
        { path: 'mounted/res.agent.1.md', content: '---\nname: a\n---\n' },
      ],
    })
    expect(r.status).toBe('exit-nonzero')
    expect(r.exitCode).toBe(3)
    // Failure path retains the scratch dir (deterministic GC owner cleans later)
    // — and the retained tree proves the seeds were written before spawn.
    expect(r.scratchRetained).toBe(true)
    const worktree = join(scratchParent, 'turn-fail', 'worktree')
    expect(readFileSync(join(worktree, 'INTENT.md'), 'utf8')).toBe('# intent')
    expect(readFileSync(join(worktree, 'mounted', 'res.agent.1.md'), 'utf8')).toContain('name: a')
  })

  test('seed path traversal / absolute paths are rejected before any spawn', async () => {
    const scratchParent = scratchParentDir()
    for (const path of ['../escape.md', '/abs.md', 'a/../../x']) {
      const r = await runSystemAgent({
        ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
        seedFiles: [{ path, content: 'x' }],
      })
      expect(r.status).toBe('spawn-failed')
      expect(r.stderrTail).toContain('unsafe seed path')
    }
    // Nothing leaked outside the (removed) scratch dirs.
    expect(readdirSync(scratchParent)).toEqual([])
    // RFC-254: use a host-resolved worktree root. A bare '/tmp/wt' has no drive
    // letter, but resolve() adds the CWD drive to the seed path on Windows, so the
    // lexical-inside check compared two different roots and rejected every path.
    const wt = resolve('/tmp/wt')
    expect(() => assertSafeSeedPath(wt, '../up')).toThrow(/unsafe seed path/)
    expect(assertSafeSeedPath(wt, 'ok/nested.md')).toBe(resolve(wt, 'ok/nested.md'))
  })

  test('timeout escalates TERM→KILL and retains scratch', async () => {
    process.env.MOCK_OPENCODE_DELAY_MS = '30000'
    const scratchParent = scratchParentDir()
    const r = await runSystemAgent({
      ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
      scratchName: 'turn-timeout',
      timeoutMs: 500,
    })
    expect(r.status).toBe('timeout')
    expect(r.scratchRetained).toBe(true)
    expect(existsSync(join(scratchParent, 'turn-timeout'))).toBe(true)
  }, 20_000)

  test('abort signal maps to aborted', async () => {
    process.env.MOCK_OPENCODE_DELAY_MS = '30000'
    const scratchParent = scratchParentDir()
    const controller = new AbortController()
    const runPromise = runSystemAgent({
      ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
      abortSignal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const r = await runPromise
    expect(r.status).toBe('aborted')
  }, 20_000)

  test('spawn failure (missing binary) reports masked diagnostics', async () => {
    const scratchParent = scratchParentDir()
    const r = await runSystemAgent({
      ...baseOpts(scratchParent, '/nonexistent/bin/opencode-missing'),
    })
    expect(r.status).toBe('spawn-failed')
    expect(r.exitCode).toBeNull()
    expect(r.outputEvidence).toEqual({
      assistantTextSeen: false,
      observedAssistantTextBytes: 0,
      retainedAssistantTextBytes: 0,
      eventTextCapHit: false,
      unparsedStdoutSeen: false,
      lastNormalizedEventKind: null,
      lastRuntimeEventType: null,
      terminalResult: 'not-observed',
    })
  })

  test('scratch release requires the exact canonical owned child', () => {
    const parent = scratchParentDir()
    const owned = join(parent, 'turn-owned')
    mkdirSync(owned)
    expect(
      releaseSystemAgentScratch({
        scratchDir: owned,
        expectedParent: parent,
        expectedName: 'turn-owned',
      }),
    ).toEqual({ removed: true })
    expect(existsSync(owned)).toBe(false)

    const outside = scratchParentDir()
    expect(
      releaseSystemAgentScratch({
        scratchDir: outside,
        expectedParent: parent,
        expectedName: '../outside',
      }),
    ).toEqual({ removed: false, reason: 'unsafe-path' })
    expect(existsSync(outside)).toBe(true)
  })

  testUnlessWindows('scratch release refuses a symlink leaf', () => {
    const parent = scratchParentDir()
    const target = scratchParentDir()
    const link = join(parent, 'turn-link')
    symlinkSync(target, link, 'dir')
    expect(
      releaseSystemAgentScratch({
        scratchDir: link,
        expectedParent: parent,
        expectedName: 'turn-link',
      }),
    ).toEqual({ removed: false, reason: 'unsafe-path' })
    expect(existsSync(target)).toBe(true)
  })

  test('plan cleanup failure is a spawn failure even when scratch is intentionally retained', async () => {
    const scratchParent = scratchParentDir()
    const r = await runSystemAgent({
      ...baseOpts(scratchParent, '/bin/sh'),
      scratchName: 'turn-cleanup-failure',
      retainScratchOnSuccess: true,
      testPlanOverride: async () => ({
        // RFC-254: cross-platform no-op child — /bin/sh does not exist on Windows.
        // buildPlan supplies the whole cmd (no driver flags appended), so bun -e
        // is safe here (unlike a driver head, where trailing --flags break -e).
        cmd: [process.execPath, '-e', 'process.exit(0)'],
        env: { PATH: '/usr/bin:/bin' },
        stdin: { mode: 'ignore' },
        cleanup: async () => {
          throw new Error('store remained locked')
        },
      }),
    })
    expect(r).toMatchObject({
      status: 'spawn-failed',
      stderrTail: 'runtime cleanup failed',
      scratchRetained: true,
    })
    expect(existsSync(join(scratchParent, 'turn-cleanup-failure'))).toBe(true)
  })

  test('stderr tail is credential-masked', async () => {
    process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
    process.env.MOCK_OPENCODE_EXIT_CODE = '1'
    process.env.MOCK_OPENCODE_STDERR =
      'fetch failed https://u:sk-live-AAAABBBBCCCCDDDDEEEEFFFF11112222@api.example.com/x'
    const scratchParent = scratchParentDir()
    const r = await runSystemAgent({
      ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
    })
    expect(r.status).toBe('exit-nonzero')
    expect(r.stderrTail).not.toContain('sk-live-AAAABBBBCCCCDDDDEEEEFFFF11112222')
    expect(r.stderrTail).toContain('api.example.com')
  })

  test('ordered event sink observes stdout/stderr and settles independently', async () => {
    process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
    process.env.MOCK_OPENCODE_STDERR = 'runtime diagnostic'
    const events: Array<Parameters<SystemAgentEventSinkV1['append']>[0]> = []
    const roots: string[] = []
    const terminals: string[] = []
    const sink: SystemAgentEventSinkV1 = {
      append: async (event) => {
        events.push(event)
      },
      setRootSessionId: async (sessionId) => {
        roots.push(sessionId)
      },
      markTerminal: async (state) => {
        terminals.push(state)
      },
    }
    const scratchParent = scratchParentDir()
    const result = await runSystemAgent({
      ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
      eventSink: sink,
    })

    expect(result.status).toBe('ok')
    expect(events.some((event) => event.kind === 'text' && event.source === 'stream')).toBe(true)
    expect(events.some((event) => event.kind === 'stderr' && event.source === 'stream')).toBe(true)
    expect(roots).toEqual([])
    expect(terminals).toEqual(['complete'])
  })

  // RFC-254: skipped on Windows — this test needs a runtime whose DIRECT child
  // exits while a detached grandchild keeps the inherited stdout pipe open, so the
  // framework hits post-exit-flush-timeout ('incomplete'). On Windows the pipe
  // reaches EOF when the parent exits regardless of an unref'd grandchild (no
  // POSIX-style handle inheritance across the detached boundary), so the condition
  // is not reproducible here ('complete'). The production flush cap it exercises is
  // platform-agnostic (a plain timer on the stdout drain); only the repro diverges.
  testUnlessWindows(
    'inherited pipe timeout settles capture incomplete without changing business result',
    async () => {
      const terminals: Array<{ state: string; reason?: string }> = []
      const sink: SystemAgentEventSinkV1 = {
        append: async () => {},
        setRootSessionId: async () => {},
        markTerminal: async (state, reason) => {
          terminals.push({ state, ...(reason === undefined ? {} : { reason }) })
        },
      }
      const scratchParent = scratchParentDir()
      const result = await runSystemAgent({
        ...baseOpts(scratchParent, wrapperHoldingStdoutOpen()),
        eventSink: sink,
      })

      expect(result.status).toBe('ok')
      expect(terminals).toEqual([{ state: 'incomplete', reason: 'post-exit-flush-timeout' }])
    },
    10_000,
  )

  test('transient terminal failure retries the remembered incomplete state', async () => {
    process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
    const credentialPieces = ['sk-live-', 'AAAABBBB', 'CCCCDDDD', 'EEEEFFFF', '11112222']
    const secret = credentialPieces.join('')
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
    const log: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message, fields) => warnings.push({ message, fields }),
      error: () => {},
      child: () => log,
    }
    const terminals: Array<{ state: string; reason?: string }> = []
    let terminalAttempts = 0
    const sink: SystemAgentEventSinkV1 = {
      append: async () => {
        throw new Error(`transient append failure https://u:${secret}@api.example.com/x`)
      },
      setRootSessionId: async () => {},
      markTerminal: async (state, reason) => {
        terminalAttempts += 1
        terminals.push({ state, ...(reason === undefined ? {} : { reason }) })
        if (terminalAttempts === 1) {
          throw new Error(`transient terminal failure https://u:${secret}@api.example.com/x`)
        }
      },
    }
    const result = await runSystemAgent({
      ...baseOpts(scratchParentDir(), wrapperFor(MOCK_OPENCODE)),
      eventSink: sink,
      log,
    })

    expect(result.status).toBe('ok')
    expect(terminals).toEqual([
      { state: 'incomplete', reason: 'stream-persist-failed' },
      { state: 'incomplete', reason: 'stream-persist-failed' },
    ])
    expect(JSON.stringify(warnings)).not.toContain(secret)
    expect(JSON.stringify(warnings)).toContain('‹redacted›')
  })

  test('an explicit OpenCode command head follows the ordinary system path', async () => {
    process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
    const scratchParent = scratchParentDir()
    const binary = wrapperFor(MOCK_OPENCODE)

    const result = await runSystemAgent({
      ...baseOpts(scratchParent, binary),
      binaryOverride: binary,
      scratchName: 'turn-explicit-head',
    })
    expect(result.status).toBe('ok')
  })
})

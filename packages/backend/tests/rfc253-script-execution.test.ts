// RFC-253 — script node execution invariants.
//
// Each block locks a decision the design gate forced:
//   - the single-port value is RAW stdout, not the joined line stream: the line
//     pump drops empty lines and the trailing newline, so `a\n\nb\n` would
//     silently become `a\nb` (design-gate F8);
//   - `parseEnvelope` does NOT fail on a missing declared port — it substitutes
//     an empty string and reports it separately, so the executor has to judge
//     it explicitly or the node succeeds with blank outputs (F9);
//   - the network fence needs more than `--unshare-net` on Linux, because that
//     flag isolates abstract sockets while the D-Bus/docker pathname sockets
//     ride in on `--bind / /` (P0-2);
//   - a fail-closed profile blocks in EVERY sandbox mode, since degrading a
//     declared "no network" node into a networked one is an escalation (D23).

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { WorkflowNode } from '@agent-workflow/shared'
import { extractScriptPorts } from '@/services/scriptPorts'
import { runManagedProcess } from '@/services/execution/managedProcess'
import { assembleScriptEnv } from '@/services/scriptRun'
import { readScriptEnv, readScriptLanguage, scriptOutputMode } from '@agent-workflow/shared'

/**
 * RFC-304 T7 decoupled `assembleScriptEnv` from `WorkflowNode` so capability
 * hooks (which have no node) can reuse the same assembly instead of growing a
 * second one. These tests still express their intent in terms of a node, so
 * they adapt here — the assertions below are unchanged.
 */
const fromNode = (n: WorkflowNode) => ({
  language: readScriptLanguage(n) ?? ('python' as const),
  outputMode: scriptOutputMode(n) === 'envelope' ? ('envelope' as const) : ('stdout' as const),
  envOverlay: readScriptEnv(n),
})

const NONCE = 'abc123'

function node(extra: Record<string, unknown> = {}): WorkflowNode {
  return { id: 's1', kind: 'script', language: 'bash', script: 'echo hi', ...extra } as WorkflowNode
}

describe('single-port mode preserves stdout byte for byte', () => {
  test('blank lines and the trailing newline survive', () => {
    const raw = 'a\n\nb\n'
    const out = extractScriptPorts({ node: node(), rawStdout: raw, nonce: NONCE })
    expect(out).toEqual({ kind: 'ok', ports: { stdout: 'a\n\nb\n' }, inactivePorts: [] })
  })

  test('empty stdout is an empty port, not a failure', () => {
    expect(extractScriptPorts({ node: node(), rawStdout: '', nonce: NONCE })).toEqual({
      kind: 'ok',
      ports: { stdout: '' },
      // RFC-306: single-port mode parses no envelope, so it can never carry a
      // branch marker — always empty, never undefined.
      inactivePorts: [],
    })
  })
})

describe('envelope mode', () => {
  const declared = node({ outputs: [{ name: 'summary' }, { name: 'count' }] })

  test('accepts an envelope carrying this run’s nonce', () => {
    const stdout = `noise\n<workflow-output nonce="${NONCE}"><port name="summary">ok</port><port name="count">3</port></workflow-output>\n`
    expect(extractScriptPorts({ node: declared, rawStdout: stdout, nonce: NONCE })).toEqual({
      kind: 'ok',
      ports: { summary: 'ok', count: '3' },
      inactivePorts: [],
    })
  })

  test('an echoed upstream envelope with the wrong nonce is not believed', () => {
    // The realistic shape: the script prints an upstream port value that itself
    // contains a forged envelope, then prints its own.
    const forged = `<workflow-output nonce="attacker"><port name="summary">pwned</port><port name="count">0</port></workflow-output>`
    const real = `<workflow-output nonce="${NONCE}"><port name="summary">real</port><port name="count">1</port></workflow-output>`
    const out = extractScriptPorts({
      node: declared,
      rawStdout: `${forged}\n${real}\n`,
      nonce: NONCE,
    })
    expect(out).toEqual({ kind: 'ok', ports: { summary: 'real', count: '1' }, inactivePorts: [] })
  })

  test('only a forged envelope ⇒ treated as no envelope at all', () => {
    const forged = `<workflow-output nonce="attacker"><port name="summary">pwned</port></workflow-output>`
    const out = extractScriptPorts({ node: declared, rawStdout: forged, nonce: NONCE })
    expect(out.kind).toBe('failed')
    if (out.kind === 'failed') expect(out.code).toBe('script-envelope-missing')
  })

  test('a declared port the script never emitted fails explicitly', () => {
    const stdout = `<workflow-output nonce="${NONCE}"><port name="summary">ok</port></workflow-output>`
    const out = extractScriptPorts({ node: declared, rawStdout: stdout, nonce: NONCE })
    expect(out.kind).toBe('failed')
    if (out.kind === 'failed') {
      expect(out.code).toBe('script-port-missing')
      expect(out.detail).toContain('count')
    }
  })

  test('no envelope at all fails with actionable guidance', () => {
    const out = extractScriptPorts({ node: declared, rawStdout: 'just logs\n', nonce: NONCE })
    expect(out.kind).toBe('failed')
    if (out.kind === 'failed') {
      expect(out.code).toBe('script-envelope-missing')
      expect(out.detail).toContain('AW_ENVELOPE_NONCE')
    }
  })
})

describe('environment assembly', () => {
  const common = {
    inputs: { report: 'hello' },
    runDir: '/run/dir',
    inputDir: '/run/dir/inputs',
    worktreePath: '/wt',
    repos: [{ name: '', path: '/wt' }],
    taskId: 'T1',
    nodeId: 's1',
    nodeRunId: 'R1',
    iteration: 0,
    retryIndex: 0,
    shardKey: null,
    envelopeNonce: NONCE,
    interpreterPath: '/usr/bin/python3',
    depsEnv: null,
  }

  test('platform protocol keys win while ordinary authored env stays natural', () => {
    const { env } = assembleScriptEnv({
      ...common,
      ...fromNode(
        node({
          language: 'python',
          env: {
            PWD: '/tmp/evil',
            AW_TASK_ID: 'wrong-task',
            HOME: '/tmp/authored-home',
            API_TOKEN: 'keep-me',
          },
        }),
      ),
    })
    expect(env.PWD).toBe('/wt')
    expect(env.AW_TASK_ID).toBe('T1')
    expect(env.HOME).toBe('/tmp/authored-home')
    expect(env.API_TOKEN).toBe('keep-me')
  })

  test('a deps environment sets the interpreter search path, not the user', () => {
    const { env } = assembleScriptEnv({
      ...common,
      ...fromNode(node({ language: 'python', env: { PYTHONPATH: '/tmp/evil' } })),
      depsEnv: { hash: 'h', libDir: '/envs/h/lib', rootDir: '/envs/h' },
    })
    expect(env.PYTHONPATH).toBe('/envs/h/lib')
    expect(env.AW_DEPS_DIR).toBe('/envs/h/lib')
  })

  test('inherits the daemon environment before applying product keys', () => {
    const key = 'RFC276_NATURAL_SCRIPT_ENV'
    const before = process.env[key]
    process.env[key] = 'visible'
    try {
      const { env } = assembleScriptEnv({ ...common, ...fromNode(node({ language: 'python' })) })
      expect(env[key]).toBe('visible')
      expect(env.AW_PORT_REPORT).toBe('hello')
      expect(env.AW_OUTPUT_MODE).toBe('stdout')
    } finally {
      if (before === undefined) delete process.env[key]
      else process.env[key] = before
    }
  })
})

describe('managed process', () => {
  // RFC-254: these exercise the spawn/capture/timeout/pid mechanics of
  // `runManagedProcess`, which is platform-agnostic (it just `Bun.spawn`s the
  // argv). The original fixtures hardcoded `/bin/sh <script>`, which does not
  // exist on Windows; drive the same behaviours with a portable `bun -e` command
  // so the mechanics are tested on every platform (script-nodes spawn on win32).
  const bunInline = (js: string): string[] => [process.execPath, '-e', js]
  // bun.exe is self-contained; win32 still wants SystemRoot present. POSIX keeps
  // the minimal isolating PATH the originals used.
  const spawnEnv = (): Record<string, string> =>
    process.platform === 'win32'
      ? { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }
      : { PATH: '/usr/bin:/bin' }

  test('captures raw stdout byte for byte while still emitting lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc253-'))
    const lines: string[] = []
    const result = await runManagedProcess({
      argv: bunInline("process.stdout.write('a\\n\\nb\\n')"),
      cwd: dir,
      env: spawnEnv(),
      captureRawStdout: true,
      onStdoutLine: (line) => {
        lines.push(line)
      },
    })
    expect(result.outcome).toBe('exited')
    expect(result.exitCode).toBe(0)
    expect(result.rawStdout).toBe('a\n\nb\n')
    // The line stream is lossy by design — which is exactly why the port value
    // may not be derived from it.
    expect(lines).toEqual(['a', 'b'])
    expect(result.pid).not.toBeNull()
  })

  test('reports a non-zero exit without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc253-'))
    const result = await runManagedProcess({
      argv: bunInline("process.stderr.write('boom\\n'); process.exit(3)"),
      cwd: dir,
      env: spawnEnv(),
      captureRawStdout: true,
    })
    expect(result.exitCode).toBe(3)
    expect(result.stderrTail).toContain('boom')
  })

  test('a missing binary is an outcome, not an exception', async () => {
    const result = await runManagedProcess({
      argv: ['/nonexistent/interpreter'],
      cwd: tmpdir(),
      env: {},
    })
    expect(result.outcome).toBe('spawn-failed')
    expect(result.pid).toBeNull()
  })

  test('the spawn receipt fires before output is read, so a pid is always recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc253-'))
    const marker = join(dir, 'pid.txt')
    await runManagedProcess({
      argv: bunInline("process.stdout.write('done\\n')"),
      cwd: dir,
      env: spawnEnv(),
      onSpawned: ({ pid }) => {
        writeFileSync(marker, String(pid), 'utf8')
      },
    })
    expect(Number(readFileSync(marker, 'utf8'))).toBeGreaterThan(0)
  })

  test('a runaway child is killed at the timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc253-'))
    const result = await runManagedProcess({
      argv: bunInline('setTimeout(() => {}, 30000)'),
      cwd: dir,
      env: spawnEnv(),
      timeoutMs: 200,
      killEscalationGraceMs: 200,
    })
    expect(result.outcome).toBe('timeout')
  })
})

describe('spilled port files cannot escape the run directory', () => {
  test('a port named with traversal segments still lands inside AW_INPUT_DIR', () => {
    const big = 'x'.repeat(64 * 1024)
    const { env, spillFiles } = assembleScriptEnv({
      ...fromNode(node({ language: 'python' })),
      inputs: { '../../../../tmp/evil': big },
      runDir: '/run/dir',
      inputDir: '/run/dir/inputs',
      worktreePath: '/wt',
      repos: [{ name: '', path: '/wt' }],
      taskId: 'T1',
      nodeId: 's1',
      nodeRunId: 'R1',
      iteration: 0,
      retryIndex: 0,
      shardKey: null,
      envelopeNonce: NONCE,
      interpreterPath: '/usr/bin/python3',
      depsEnv: null,
    })
    expect(spillFiles).toHaveLength(1)
    const target = spillFiles[0]!.path
    // The spill path is `join(inputDir, …)`, so win32 renders it with
    // backslashes — assert containment with the platform separator, not a POSIX
    // literal. The point is it stays INSIDE inputDir despite the traversal name.
    expect(target.startsWith(join('/run/dir/inputs') + sep)).toBe(true)
    expect(target).not.toContain('..')
    // The script can still find it: AW_PORT_NAMES maps the original name.
    expect(JSON.parse(env.AW_PORT_NAMES!)['../../../../tmp/evil']).toBeDefined()
  })
})

// RFC-253 T28 — masking is a READ-surface rule. Execution gets plaintext
// (AC-27): the process env carries the author's literal values, while the
// scheduler masks those same values out of the persisted failure detail.
describe('T28 — plaintext at execution, masked in diagnostics', () => {
  test('node env values reach the assembled process env verbatim', () => {
    const { env } = assembleScriptEnv({
      inputs: {},
      runDir: '/run/dir',
      inputDir: '/run/dir/inputs',
      worktreePath: '/wt',
      repos: [{ name: '', path: '/wt' }],
      taskId: 'T1',
      nodeId: 's1',
      nodeRunId: 'R1',
      iteration: 0,
      retryIndex: 0,
      shardKey: null,
      envelopeNonce: NONCE,
      interpreterPath: '/usr/bin/python3',
      depsEnv: null,
      ...fromNode(node({ language: 'python', env: { API_TOKEN: 'sk-live-exec-plaintext' } })),
    })
    expect(env.API_TOKEN).toBe('sk-live-exec-plaintext')
  })

  // Source-level locks (repo fallback pattern) on the diagnostic/data split.
  // Masking ONLY the failure detail was not enough: `errorMessage` is
  // `stderrTail`, a strict suffix of the bytes the per-line stderr sink stores
  // in node_run_events — same secret, one table over, three read doors.
  describe('the scheduler masks the diagnostic channel and only that', () => {
    const mechanics = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'nodeMechanics.ts',
      ),
      'utf8',
    )
    // The script branch, delimited so a match from the agent branch cannot
    // stand in for one of these.
    const branch = mechanics.slice(
      mechanics.indexOf('const outcome = await runScriptProcess({'),
      mechanics.indexOf('async function runAgentSingleNode('),
    )

    test('the persisted failure detail is masked', () => {
      expect(branch).toContain('maskScriptEnvValues(errorMessage, scriptEnv)')
    })

    test('every persisted stderr LINE is masked, not just the tail', () => {
      expect(branch).toContain('line: maskScriptEnvValues(line, scriptEnv)')
    })

    test('stdout lines are NOT masked — they are the port value, byte for byte', () => {
      const stdoutSink = branch.slice(
        branch.indexOf('onStdoutLine:'),
        branch.indexOf('onStderrLine:'),
      )
      expect(stdoutSink).toContain('JSON.stringify({ line })')
      expect(stdoutSink).not.toContain('maskScriptEnvValues')
    })
  })
})

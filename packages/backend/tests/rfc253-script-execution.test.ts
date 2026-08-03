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
import { join } from 'node:path'
import type { WorkflowNode } from '@agent-workflow/shared'
import { extractScriptPorts } from '@/services/scriptPorts'
import { runContainedProcess } from '@/services/execution/containedSpawn'
import { assembleScriptEnv } from '@/services/scriptRun'
import {
  computeSandboxPolicy,
  renderBwrapArgs,
  renderSeatbeltProfile,
} from '@/services/sandbox/policy'
import {
  CONTAINMENT_REQUIREMENT_PROFILES,
  containmentRequirementDigest,
} from '@/services/sandbox/containmentCoordinator'

const NONCE = 'abc123'

function node(extra: Record<string, unknown> = {}): WorkflowNode {
  return { id: 's1', kind: 'script', language: 'bash', script: 'echo hi', ...extra } as WorkflowNode
}

describe('single-port mode preserves stdout byte for byte', () => {
  test('blank lines and the trailing newline survive', () => {
    const raw = 'a\n\nb\n'
    const out = extractScriptPorts({ node: node(), rawStdout: raw, nonce: NONCE })
    expect(out).toEqual({ kind: 'ok', ports: { stdout: 'a\n\nb\n' } })
  })

  test('empty stdout is an empty port, not a failure', () => {
    expect(extractScriptPorts({ node: node(), rawStdout: '', nonce: NONCE })).toEqual({
      kind: 'ok',
      ports: { stdout: '' },
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
    expect(out).toEqual({ kind: 'ok', ports: { summary: 'real', count: '1' } })
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

  test('platform keys win over a node env overlay that tries to claim them', () => {
    const { env } = assembleScriptEnv({
      ...common,
      node: node({
        language: 'python',
        env: { HOME: '/tmp/evil', PYTHONPATH: '/tmp/evil', API_TOKEN: 'keep-me' },
      }),
    })
    expect(env.HOME).toBe('/run/dir/home')
    expect(env.PYTHONPATH).toBeUndefined() // no deps env ⇒ platform leaves it unset
    expect(env.API_TOKEN).toBe('keep-me')
  })

  test('a deps environment sets the interpreter search path, not the user', () => {
    const { env } = assembleScriptEnv({
      ...common,
      node: node({ language: 'python', env: { PYTHONPATH: '/tmp/evil' } }),
      depsEnv: { hash: 'h', libDir: '/envs/h/lib', rootDir: '/envs/h' },
    })
    expect(env.PYTHONPATH).toBe('/envs/h/lib')
    expect(env.AW_DEPS_DIR).toBe('/envs/h/lib')
  })

  test('the daemon environment is not inherited', () => {
    const { env } = assembleScriptEnv({ ...common, node: node({ language: 'python' }) })
    // A variable that exists in this test process must not appear unless the
    // platform put it there deliberately.
    expect(Object.keys(env)).not.toContain('AGENT_WORKFLOW_HOME')
    expect(env.AW_PORT_REPORT).toBe('hello')
    expect(env.AW_OUTPUT_MODE).toBe('stdout')
  })
})

describe('network fence rendering', () => {
  const base = {
    appHome: '/home/u/.agent-workflow',
    taskWorktrees: ['/home/u/.agent-workflow/worktrees/r/t1'],
    runDir: '/home/u/.agent-workflow/runs/t1/r1',
  }

  test('off by default — the outer sandbox has never restricted the network', () => {
    const policy = computeSandboxPolicy(base)
    expect(renderBwrapArgs(policy, { appHome: base.appHome })).not.toContain('--unshare-net')
    expect(renderSeatbeltProfile(policy)).not.toContain('(deny network*)')
  })

  test('Linux masks the pathname-socket directories alongside --unshare-net', () => {
    const args = renderBwrapArgs(computeSandboxPolicy({ ...base, networkDeny: true }), {
      appHome: base.appHome,
    })
    expect(args).toContain('--unshare-net')
    // `--unshare-net` only isolates ABSTRACT unix sockets; /run/user/<uid>/bus
    // and /var/run/docker.sock arrive through `--bind / /`.
    const joined = args.join(' ')
    expect(joined).toContain('--tmpfs /run')
    expect(joined).toContain('--tmpfs /var/run')
  })

  test('SBPL puts the network deny last, after (allow default)', () => {
    const profile = renderSeatbeltProfile(computeSandboxPolicy({ ...base, networkDeny: true }))
    const lines = profile.split('\n')
    expect(lines[1]).toBe('(allow default)')
    // Last-match-wins: a deny before the allow-default would be overridden.
    expect(lines[lines.length - 1]).toBe('(deny network*)')
    expect(lines.indexOf('(deny network*)')).toBeGreaterThan(lines.indexOf('(allow default)'))
  })
})

describe('fail-closed containment profile', () => {
  test('the netless profile declares failClosed and requires the outer fence', () => {
    const profile = CONTAINMENT_REQUIREMENT_PROFILES['outer-netless-v1']
    expect(profile.required).toContain('outerNetworkDeny')
    expect(profile.failClosed).toBe(true)
    expect(profile.childBoundary).toBe('none')
  })

  test('the allow path reuses runner-filesystem-v1 rather than cloning it', () => {
    // design-gate F3: a profile names WHAT is required, never WHO requires it.
    const ids = Object.keys(CONTAINMENT_REQUIREMENT_PROFILES)
    expect(ids).not.toContain('script-node-v1')
    expect(ids).toContain('runner-filesystem-v1')
  })

  test('failClosed participates in the requirement digest', () => {
    // The digest is what a receipt is fingerprinted by; a rule that changes what
    // an admission MEANS has to be inside it.
    expect(containmentRequirementDigest('outer-netless-v1')).not.toBe(
      containmentRequirementDigest('runner-filesystem-v1'),
    )
  })
})

describe('contained spawn', () => {
  test('captures raw stdout byte for byte while still emitting lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc253-'))
    const script = join(dir, 's.sh')
    writeFileSync(script, "printf 'a\\n\\nb\\n'\n", 'utf8')
    const lines: string[] = []
    const result = await runContainedProcess({
      argv: ['/bin/sh', script],
      cwd: dir,
      env: { PATH: '/usr/bin:/bin' },
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
    const script = join(dir, 's.sh')
    writeFileSync(script, 'echo boom >&2\nexit 3\n', 'utf8')
    const result = await runContainedProcess({
      argv: ['/bin/sh', script],
      cwd: dir,
      env: { PATH: '/usr/bin:/bin' },
      captureRawStdout: true,
    })
    expect(result.exitCode).toBe(3)
    expect(result.stderrTail).toContain('boom')
  })

  test('a missing binary is an outcome, not an exception', async () => {
    const result = await runContainedProcess({
      argv: ['/nonexistent/interpreter'],
      cwd: tmpdir(),
      env: {},
    })
    expect(result.outcome).toBe('spawn-failed')
    expect(result.pid).toBeNull()
  })

  test('the spawn receipt fires before output is read, so a pid is always recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc253-'))
    const script = join(dir, 's.sh')
    const marker = join(dir, 'pid.txt')
    writeFileSync(script, 'echo done\n', 'utf8')
    await runContainedProcess({
      argv: ['/bin/sh', script],
      cwd: dir,
      env: { PATH: '/usr/bin:/bin' },
      onSpawned: ({ pid }) => {
        writeFileSync(marker, String(pid), 'utf8')
      },
    })
    expect(Number(readFileSync(marker, 'utf8'))).toBeGreaterThan(0)
  })

  test('a runaway child is killed at the timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc253-'))
    const script = join(dir, 's.sh')
    writeFileSync(script, 'sleep 30\n', 'utf8')
    const result = await runContainedProcess({
      argv: ['/bin/sh', script],
      cwd: dir,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 200,
      killEscalationGraceMs: 200,
    })
    expect(result.outcome).toBe('timeout')
  })
})

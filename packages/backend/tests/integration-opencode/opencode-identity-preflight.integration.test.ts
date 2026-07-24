// RFC-224 T29 — official v1.18.3, no-LLM execution-identity preflight.
//
// This test deliberately stops at root-session creation. It proves the real
// binary's config/provider/agent/skill/session shapes against the exact
// production comparators without posting a message or spending provider
// tokens. Unlike the legacy live-LLM cases, it therefore runs whenever the
// integration workflow is enabled, even when repository secrets are absent.

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCreateSessionRequest,
  validateSessionIdentity,
} from '@/services/runtime/opencode/directApiSchemas'
import { OpencodeDirectClient } from '@/services/runtime/opencode/directClient'
import { verifyExecutionIdentity } from '@/services/runtime/opencode/executionIdentity'
import {
  buildControlledOpencodeConfig,
  buildHermeticServerEnv,
  buildStrictProviderAuth,
  prepareHermeticOpencodeLayout,
  removeHermeticOpencodeLayout,
} from '@/services/runtime/opencode/hermetic'
import {
  materializeFffCapabilityProbe,
  runFffCapabilityProbe,
} from '@/services/runtime/opencode/fffCapability'
import { withOfficialOpencodeSnapshot } from '@/services/runtime/opencode/officialBuilds'
import { removeSealedTree } from '@/services/runtime/opencode/sealedInputs'
import { requireRootOwnedBwrap } from '@/services/runtime/opencode/sealedSubprocess'
import {
  verifyPinnedSkillInventory,
  verifySelectedProviderInventory,
} from '@/services/runtime/opencode/verifiedLauncher'

const RUN_INTEGRATION = process.env.RUN_OPENCODE_INTEGRATION === '1'
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? 'opencode'
const PINNED_MODEL = Object.freeze({ providerID: 'openai', modelID: 'gpt-5' })
const LISTEN_LINE = /^opencode server listening on http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/
const ORPHAN_READY_TIMEOUT_MS = 5_000
const ORPHAN_STOP_GRACE_MS = 250
const ORPHAN_REAP_TIMEOUT_MS = 2_000
const ORPHAN_HARD_TIMEOUT_MS = 25_000
const ORPHAN_WATCHDOG_SECONDS = 20
const ORPHAN_STOP_POLL_MS = 20
const SERVER_SUPERVISOR_WATCHDOG_SECONDS = 45
const NANOSECONDS_PER_MILLISECOND = 1_000_000n

const GROUP_OWNERSHIP_SUPERVISOR_SCRIPT = String.raw`
import os
import signal
import sys

nonce, watchdog_seconds, command = sys.argv[1], int(sys.argv[2]), sys.argv[3:]

def watchdog(_signum, _frame):
    try:
        os.write(1, f"RFC224 WATCHDOG {nonce}\n".encode())
    finally:
        os.killpg(os.getpgrp(), signal.SIGKILL)
        os._exit(72)

signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGALRM, watchdog)
signal.alarm(watchdog_seconds)

child = os.fork()
if child == 0:
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    for signal_name in ("SIGXFZ", "SIGXFSZ"):
        if hasattr(signal, signal_name):
            signal.signal(getattr(signal, signal_name), signal.SIG_DFL)
    signal.alarm(0)
    os.execv(command[0], command)

# Stay as the process-group identity anchor even after bwrap exits. The host
# always escalates to group SIGKILL, so a numeric PGID is never signaled after
# its direct leader has settled or released ownership.
while True:
    signal.pause()
`

const BWRAP_CANCELLATION_SUPERVISOR_SCRIPT = String.raw`
import os
import select
import signal
import sys
import time

nonce, watchdog_seconds, command = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
group_id = os.getpgrp()

def frame(kind, *fields):
    payload = " ".join(["RFC224_ANCHOR", nonce, kind, *[str(field) for field in fields]]) + "\n"
    os.write(1, payload.encode())

def kill_owned_group():
    os.killpg(group_id, signal.SIGKILL)
    os._exit(72)

def fail(kind, *fields):
    try:
        frame(kind, *fields)
    finally:
        kill_owned_group()

def watchdog(_signum, _frame):
    try:
        os.write(1, f"RFC224 WATCHDOG {nonce}\n".encode())
    finally:
        kill_owned_group()

signal.signal(signal.SIGHUP, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGALRM, watchdog)
signal.alarm(watchdog_seconds)

command_read, command_write = os.pipe()
child = os.fork()
if child == 0:
    signal.signal(signal.SIGHUP, signal.SIG_DFL)
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    for signal_name in ("SIGXFZ", "SIGXFSZ"):
        if hasattr(signal, signal_name):
            signal.signal(getattr(signal, signal_name), signal.SIG_DFL)
    signal.alarm(0)
    if hasattr(signal, "pthread_sigmask"):
        signal.pthread_sigmask(signal.SIG_SETMASK, [])
    os.close(command_write)
    os.dup2(command_read, 0)
    if command_read != 0:
        os.close(command_read)
    os.execv(command[0], command)

os.close(command_read)

control_buffer = b""

def report_child_exit(phase):
    try:
        waited, status = os.waitpid(child, os.WNOHANG)
    except ChildProcessError:
        fail("TARGET_EXIT", phase, "REAPED")
    if waited == 0:
        return
    if os.WIFSIGNALED(status):
        fail("TARGET_EXIT", phase, "SIGNAL", os.WTERMSIG(status))
    if os.WIFEXITED(status):
        fail("TARGET_EXIT", phase, "CODE", os.WEXITSTATUS(status))
    fail("ERROR", phase, "WAIT_STATUS")

def read_control(expected, exit_phase):
    global control_buffer
    wanted = f"RFC224_CTL {nonce} {expected}\n".encode()
    while b"\n" not in control_buffer:
        report_child_exit(exit_phase)
        readable, _, _ = select.select([0], [], [], 0.01)
        if not readable:
            continue
        chunk = os.read(0, 512)
        if not chunk:
            fail("ERROR", expected, "CONTROL_EOF")
        control_buffer += chunk
        if len(control_buffer) > 512:
            fail("ERROR", expected, "CONTROL_BOUND")
    line, control_buffer = control_buffer.split(b"\n", 1)
    if line + b"\n" != wanted:
        fail("ERROR", expected, "CONTROL")

read_control("ARM", "PREARM")
try:
    os.write(command_write, f"RFC224 ARM {nonce}\n".encode())
except OSError:
    fail("ERROR", "ARM", "PIPE")

read_control("PREPARE_TERM", "PRETERM")
try:
    if os.getpgid(child) != group_id:
        fail("ERROR", "PREPARE_TERM", "GROUP_DRIFT")
    os.kill(child, signal.SIGSTOP)
except ProcessLookupError:
    fail("TARGET_EXIT", "PRETERM", "MISSING")

freeze_deadline = time.monotonic() + 2.0
while True:
    try:
        waited, status = os.waitpid(child, os.WUNTRACED | os.WNOHANG)
    except ChildProcessError:
        fail("TARGET_EXIT", "PRETERM", "REAPED")
    if waited == child:
        if os.WIFSTOPPED(status) and os.WSTOPSIG(status) == signal.SIGSTOP:
            break
        if os.WIFSIGNALED(status):
            fail("TARGET_EXIT", "PRETERM", "SIGNAL", os.WTERMSIG(status))
        if os.WIFEXITED(status):
            fail("TARGET_EXIT", "PRETERM", "CODE", os.WEXITSTATUS(status))
        fail("ERROR", "PREPARE_TERM", "WAIT_STATUS")
    if time.monotonic() >= freeze_deadline:
        fail("ERROR", "PREPARE_TERM", "FREEZE_TIMEOUT")
    time.sleep(0.01)

try:
    frozen_group = os.getpgid(child)
except ProcessLookupError:
    fail("TARGET_EXIT", "PRETERM", "MISSING_AFTER_STOP")
if frozen_group != group_id:
    fail("ERROR", "PREPARE_TERM", "GROUP_DRIFT_AFTER_STOP")
frame("FROZEN", child, frozen_group)

read_control("TERM_COMMITTED", "COMMIT")
try:
    if os.getpgid(child) != group_id:
        fail("ERROR", "TERM_COMMITTED", "GROUP_DRIFT")
    os.kill(child, signal.SIGCONT)
    frame("TERM_RELEASED", child)
    waited, status = os.waitpid(child, 0)
except (ChildProcessError, ProcessLookupError):
    fail("TARGET_EXIT", "COMMIT", "MISSING")

if waited != child:
    fail("ERROR", "TERM_COMMITTED", "WAIT_PID")
if not os.WIFSIGNALED(status) or os.WTERMSIG(status) != signal.SIGTERM:
    if os.WIFSIGNALED(status):
        fail("TARGET_EXIT", "POSTTERM", "SIGNAL", os.WTERMSIG(status))
    if os.WIFEXITED(status):
        fail("TARGET_EXIT", "POSTTERM", "CODE", os.WEXITSTATUS(status))
    fail("ERROR", "TERM_COMMITTED", "WAIT_STATUS")
frame("TERM_OBSERVED", child, signal.SIGTERM)

# Keep the exact process-group identity anchored until the host performs its
# grace-period escalation. The watchdog is the final cleanup authority if the
# host disappears before that handoff completes.
while True:
    signal.pause()
`

const DOUBLE_FORK_SCRIPT = String.raw`
import os
import signal
import sys

nonce, watchdog_seconds = sys.argv[1], int(sys.argv[2])

def watchdog(_signum, _frame):
    try:
        os.write(1, f"RFC224 WATCHDOG {nonce}\n".encode())
    finally:
        os._exit(72)

signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGALRM, watchdog)
signal.alarm(watchdog_seconds)

first = os.fork()
if first == 0:
    os.setsid()
    signal.alarm(watchdog_seconds)
    second = os.fork()
    if second == 0:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.alarm(watchdog_seconds)
        os.write(1, f"RFC224 READY {nonce}\n".encode())
        arm = sys.stdin.readline()
        if arm != f"RFC224 ARM {nonce}\n":
            os.write(1, f"RFC224 SURVIVED {nonce}\n".encode())
            os._exit(70)
        os.write(1, f"RFC224 ARMED {nonce}\n".encode())
        sys.stdin.read()
        os.write(1, f"RFC224 SURVIVED {nonce}\n".encode())
        os._exit(71)
    os.close(0)
    os.close(1)
    os._exit(0)

os.waitpid(first, 0)
while True:
    signal.pause()
`

const SELF_EXIT_AFTER_ARM_SCRIPT = String.raw`
import os
import sys

nonce = sys.argv[1]
os.write(1, f"RFC224 READY {nonce}\n".encode())
arm = sys.stdin.readline()
if arm != f"RFC224 ARM {nonce}\n":
    os._exit(70)
os.write(1, f"RFC224 ARMED {nonce}\n".encode())
os._exit(0)
`

interface RunningServer {
  child: ReturnType<typeof Bun.spawn>
  exited: Promise<number>
  childExited: () => boolean
  port: Promise<number>
  stdoutDone: Promise<void>
  stderrDone: Promise<void>
}

function boundedDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

function monotonicDeadline(milliseconds: number): bigint {
  return process.hrtime.bigint() + BigInt(milliseconds) * NANOSECONDS_PER_MILLISECOND
}

function phaseDeadline(hardDeadline: bigint, milliseconds: number): bigint {
  const candidate = monotonicDeadline(milliseconds)
  return candidate < hardDeadline ? candidate : hardDeadline
}

function remainingMilliseconds(deadline: bigint): number {
  const remaining = deadline - process.hrtime.bigint()
  if (remaining <= 0n) return 0
  return Math.max(
    1,
    Number((remaining + NANOSECONDS_PER_MILLISECOND - 1n) / NANOSECONDS_PER_MILLISECOND),
  )
}

async function waitUntilDeadline<T>(
  promise: Promise<T>,
  deadline: bigint,
  timeoutMessage: string,
): Promise<T> {
  const remaining = remainingMilliseconds(deadline)
  if (remaining === 0) throw new Error(timeoutMessage)
  return Promise.race([
    promise,
    boundedDelay(remaining).then(() => {
      throw new Error(timeoutMessage)
    }),
  ])
}

async function settlesBy(promise: Promise<unknown>, deadline: bigint): Promise<boolean> {
  const remaining = remainingMilliseconds(deadline)
  if (remaining === 0) return false
  return Promise.race([
    promise.then(
      () => true,
      () => false,
    ),
    boundedDelay(remaining).then(() => false),
  ])
}

function processGroupAlive(groupLeaderPid: number): boolean {
  try {
    process.kill(-groupLeaderPid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function signalProcessGroup(
  groupLeaderPid: number,
  signal: NodeJS.Signals,
): 'delivered' | 'absent' {
  try {
    process.kill(-groupLeaderPid, signal)
    return 'delivered'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'absent'
    throw error
  }
}

interface BwrapStopOutcome {
  termSent: boolean
  killSent: boolean
  leaderReaped: boolean
  groupExited: boolean
}

async function stopOwnedProcessGroup(input: {
  groupLeaderPid: number
  childExited: () => boolean
  hardDeadline: bigint
  termAlreadySent?: boolean
}): Promise<BwrapStopOutcome> {
  let groupExited = false
  let termSent = input.termAlreadySent ?? false
  let killSent = false

  const snapshot = (): Pick<BwrapStopOutcome, 'leaderReaped' | 'groupExited'> => {
    const leaderReaped = input.childExited()
    if (!groupExited) {
      groupExited = !processGroupAlive(input.groupLeaderPid)
    }
    return { leaderReaped, groupExited }
  }

  const observe = async (deadline: bigint) => {
    for (;;) {
      const current = snapshot()
      if (current.leaderReaped && current.groupExited) return current
      const remaining = remainingMilliseconds(deadline)
      if (remaining === 0) return snapshot()
      await boundedDelay(Math.min(ORPHAN_STOP_POLL_MS, remaining))
    }
  }

  if (!termSent && !input.childExited()) {
    const term = signalProcessGroup(input.groupLeaderPid, 'SIGTERM')
    termSent = term === 'delivered'
    groupExited = term === 'absent'
  }

  let outcome = await observe(phaseDeadline(input.hardDeadline, ORPHAN_STOP_GRACE_MS))
  // Once the direct leader has settled, the old numeric PGID is no longer an
  // owned signaling handle. A still-live observation is ambiguous (including
  // immediate PGID reuse), so fail closed and let the fixture control/watchdog
  // path drain without sending another signal.
  if (!outcome.leaderReaped && !outcome.groupExited) {
    const killed = signalProcessGroup(input.groupLeaderPid, 'SIGKILL')
    killSent = killed === 'delivered'
    groupExited = killed === 'absent'
  }
  outcome = await observe(phaseDeadline(input.hardDeadline, ORPHAN_REAP_TIMEOUT_MS))

  return {
    termSent,
    killSent,
    leaderReaped: outcome.leaderReaped,
    groupExited: outcome.groupExited,
  }
}

interface DoubleForkOutputObserver {
  ready: Promise<void>
  armed: Promise<void>
  frozen: Promise<void>
  termReleased: Promise<void>
  termObserved: Promise<void>
  closed: Promise<void>
  failure: () => Error | null
  survived: () => boolean
}

function observeDoubleForkOutput(
  stream: ReadableStream<Uint8Array>,
  nonce: string,
  expectedGroupId: number,
): DoubleForkOutputObserver {
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  let resolveArmed!: () => void
  let rejectArmed!: (error: Error) => void
  let resolveFrozen!: () => void
  let rejectFrozen!: (error: Error) => void
  let resolveTermReleased!: () => void
  let rejectTermReleased!: (error: Error) => void
  let resolveTermObserved!: () => void
  let rejectTermObserved!: (error: Error) => void
  let stage: 'ready' | 'armed' | 'frozen' | 'term-released' | 'term-observed' | 'drain' = 'ready'
  let failure: Error | null = null
  let survived = false
  let frozenChild = ''
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const armed = new Promise<void>((resolve, reject) => {
    resolveArmed = resolve
    rejectArmed = reject
  })
  const frozen = new Promise<void>((resolve, reject) => {
    resolveFrozen = resolve
    rejectFrozen = reject
  })
  const termReleased = new Promise<void>((resolve, reject) => {
    resolveTermReleased = resolve
    rejectTermReleased = reject
  })
  const termObserved = new Promise<void>((resolve, reject) => {
    resolveTermObserved = resolve
    rejectTermObserved = reject
  })
  void ready.catch(() => undefined)
  void armed.catch(() => undefined)
  void frozen.catch(() => undefined)
  void termReleased.catch(() => undefined)
  void termObserved.catch(() => undefined)

  const recordFailure = (error: Error) => {
    failure ??= error
    if (stage === 'ready') rejectReady(error)
    if (stage === 'ready' || stage === 'armed') rejectArmed(error)
    if (stage === 'ready' || stage === 'armed' || stage === 'frozen') rejectFrozen(error)
    if (stage !== 'term-observed' && stage !== 'drain') rejectTermReleased(error)
    if (stage !== 'drain') rejectTermObserved(error)
  }

  const consumeLine = (line: string) => {
    if (line === `RFC224 WATCHDOG ${nonce}`) {
      recordFailure(new Error('real bwrap orphan probe watchdog expired'))
      return
    }
    if (line === `RFC224 SURVIVED ${nonce}`) {
      survived = true
      recordFailure(new Error('real bwrap orphan probe emitted a survivor frame'))
      return
    }
    if (
      line.startsWith(`RFC224_ANCHOR ${nonce} ERROR `) ||
      line.startsWith(`RFC224_ANCHOR ${nonce} TARGET_EXIT `)
    ) {
      recordFailure(new Error(`real bwrap orphan probe supervisor failure: ${line}`))
      return
    }
    if (stage === 'ready') {
      if (line !== `RFC224 READY ${nonce}`) {
        recordFailure(new Error(`unexpected real bwrap orphan probe frame: ${line}`))
        return
      }
      stage = 'armed'
      resolveReady()
      return
    }
    if (stage === 'armed') {
      if (line !== `RFC224 ARMED ${nonce}`) {
        recordFailure(new Error(`unexpected real bwrap orphan probe frame: ${line}`))
        return
      }
      stage = 'frozen'
      resolveArmed()
      return
    }
    if (stage === 'frozen') {
      const match = new RegExp(`^RFC224_ANCHOR ${nonce} FROZEN ([1-9][0-9]*) ([1-9][0-9]*)$`).exec(
        line,
      )
      if (
        match?.[1] === undefined ||
        match[2] === undefined ||
        match[2] !== String(expectedGroupId)
      ) {
        recordFailure(new Error(`unexpected real bwrap orphan probe frame: ${line}`))
        return
      }
      frozenChild = match[1]
      stage = 'term-released'
      resolveFrozen()
      return
    }
    if (stage === 'term-released') {
      if (line !== `RFC224_ANCHOR ${nonce} TERM_RELEASED ${frozenChild}`) {
        recordFailure(new Error(`unexpected real bwrap orphan probe frame: ${line}`))
        return
      }
      stage = 'term-observed'
      resolveTermReleased()
      return
    }
    if (
      stage !== 'term-observed' ||
      line !== `RFC224_ANCHOR ${nonce} TERM_OBSERVED ${frozenChild} 15`
    ) {
      recordFailure(new Error(`unexpected real bwrap orphan probe frame: ${line}`))
      return
    }
    stage = 'drain'
    resolveTermObserved()
  }

  const closed = (async () => {
    let reader: ReturnType<typeof stream.getReader> | undefined
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffered = ''
    try {
      const acquiredReader = stream.getReader()
      reader = acquiredReader
      for (;;) {
        const next = await acquiredReader.read()
        if (next.done) break
        buffered += decoder.decode(next.value, { stream: true })
        if (buffered.length > 4_096) {
          recordFailure(new Error('real bwrap orphan probe output exceeded its bound'))
          buffered = ''
        }
        for (;;) {
          const newline = buffered.indexOf('\n')
          if (newline < 0) break
          consumeLine(buffered.slice(0, newline).replace(/\r$/, ''))
          buffered = buffered.slice(newline + 1)
        }
      }
      buffered += decoder.decode()
      if (buffered !== '') {
        recordFailure(new Error('real bwrap orphan probe emitted a partial frame'))
      }
      const finalStage = (): typeof stage => stage
      if (finalStage() !== 'drain') {
        recordFailure(new Error('real bwrap orphan probe closed before proving SIGTERM delivery'))
      }
    } catch (error) {
      recordFailure(
        error instanceof Error ? error : new Error('real bwrap orphan probe output failed'),
      )
    } finally {
      if (reader !== undefined) {
        try {
          reader.releaseLock()
        } catch (error) {
          recordFailure(
            error instanceof Error
              ? error
              : new Error('real bwrap orphan probe reader release failed'),
          )
        }
      }
    }
  })()

  return {
    ready,
    armed,
    frozen,
    termReleased,
    termObserved,
    closed,
    failure: () => failure,
    survived: () => survived,
  }
}

async function verifyRealBwrapCancellation(bwrapPath: string): Promise<void> {
  const hardDeadline = monotonicDeadline(ORPHAN_HARD_TIMEOUT_MS)
  const nonce = randomUUID()
  const child = Bun.spawn({
    cmd: [
      '/usr/bin/python3',
      '-c',
      BWRAP_CANCELLATION_SUPERVISOR_SCRIPT,
      nonce,
      String(ORPHAN_WATCHDOG_SECONDS),
      bwrapPath,
      '--die-with-parent',
      '--new-session',
      '--unshare-net',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--ro-bind',
      '/',
      '/',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--clearenv',
      '--',
      '/usr/bin/python3',
      '-c',
      DOUBLE_FORK_SCRIPT,
      nonce,
      String(ORPHAN_WATCHDOG_SECONDS),
    ],
    cwd: '/',
    env: {},
    stdin: 'pipe',
    stdout: 'pipe',
    // Keep bwrap/Python diagnostics in the Actions step log. The production
    // identity boundary still exposes only stable failure codes.
    stderr: 'inherit',
    detached: true,
  })
  let childExited = false
  let exitFailure: unknown = null
  const exited = child.exited.then(
    (code) => {
      childExited = true
      return code
    },
    (error: unknown) => {
      childExited = true
      exitFailure = error
      throw error
    },
  )
  void exited.catch(() => undefined)

  const output = observeDoubleForkOutput(child.stdout, nonce, child.pid)
  let primaryFailure: { error: unknown } | null = null
  let termSent = false
  let termProven = false
  try {
    const readiness = await waitUntilDeadline(
      Promise.race([
        output.ready.then(() => ({ kind: 'ready' as const })),
        exited.then((code) => ({ kind: 'exit' as const, code })),
      ]),
      phaseDeadline(hardDeadline, ORPHAN_READY_TIMEOUT_MS),
      'real bwrap orphan probe readiness timed out',
    )
    if (readiness.kind === 'exit') {
      throw new Error(`real bwrap orphan probe exited before readiness: ${readiness.code}`)
    }

    await child.stdin.write(`RFC224_CTL ${nonce} ARM\n`)
    await child.stdin.flush()
    const arming = await waitUntilDeadline(
      Promise.race([
        output.armed.then(() => ({ kind: 'armed' as const })),
        exited.then((code) => ({ kind: 'exit' as const, code })),
      ]),
      phaseDeadline(hardDeadline, ORPHAN_READY_TIMEOUT_MS),
      'real bwrap orphan probe arming timed out',
    )
    if (arming.kind === 'exit') {
      throw new Error(`real bwrap orphan probe exited before arming: ${arming.code}`)
    }

    await child.stdin.write(`RFC224_CTL ${nonce} PREPARE_TERM\n`)
    await child.stdin.flush()
    const freezing = await waitUntilDeadline(
      Promise.race([
        output.frozen.then(() => ({ kind: 'frozen' as const })),
        exited.then((code) => ({ kind: 'exit' as const, code })),
      ]),
      phaseDeadline(hardDeadline, ORPHAN_READY_TIMEOUT_MS),
      'real bwrap orphan probe freeze lease timed out',
    )
    if (freezing.kind === 'exit') {
      throw new Error(`real bwrap orphan probe exited before freeze lease: ${freezing.code}`)
    }

    const term = signalProcessGroup(child.pid, 'SIGTERM')
    if (term !== 'delivered') {
      throw new Error('real bwrap orphan probe lost its owned process group before SIGTERM')
    }
    termSent = true
    await child.stdin.write(`RFC224_CTL ${nonce} TERM_COMMITTED\n`)
    await child.stdin.flush()
    await waitUntilDeadline(
      Promise.all([output.termReleased, output.termObserved]),
      phaseDeadline(hardDeadline, ORPHAN_READY_TIMEOUT_MS),
      'real bwrap orphan probe did not prove target SIGTERM delivery',
    )
    termProven = true
  } catch (error) {
    primaryFailure = { error }
  }

  let stopped: BwrapStopOutcome | null = null
  let cleanupFailure: { error: unknown } | null = null
  try {
    stopped = await stopOwnedProcessGroup({
      groupLeaderPid: child.pid,
      childExited: () => childExited,
      hardDeadline,
      termAlreadySent: termSent,
    })
  } catch (error) {
    cleanupFailure = { error }
  }

  let containedClosure = false
  if (primaryFailure === null && stopped !== null) {
    containedClosure = await settlesBy(
      output.closed,
      phaseDeadline(hardDeadline, ORPHAN_REAP_TIMEOUT_MS),
    )
    if (!termProven || !stopped.termSent) {
      primaryFailure = {
        error: new Error('real bwrap orphan probe never proved target SIGTERM delivery'),
      }
    } else if (!stopped.killSent) {
      primaryFailure = {
        error: new Error('real bwrap orphan probe never delivered supervisor SIGKILL'),
      }
    } else if (!stopped.leaderReaped || !stopped.groupExited) {
      primaryFailure = {
        error: new Error('real bwrap orphan probe did not reap its outer process group'),
      }
    } else if (!containedClosure) {
      primaryFailure = {
        error: new Error('real bwrap orphan probe descendant survived namespace cancellation'),
      }
    }
  }

  try {
    await child.stdin.end()
  } catch (error) {
    cleanupFailure ??= { error }
  }

  if (!containedClosure) {
    const drained = await settlesBy(output.closed, hardDeadline)
    if (!drained) {
      cleanupFailure = {
        error: new Error('real bwrap orphan probe watchdog did not drain its descendants'),
      }
    }
  }
  if (!childExited) {
    const reaped = await settlesBy(exited, hardDeadline)
    if (!reaped) {
      cleanupFailure = {
        error: new Error('real bwrap orphan probe did not reap its bwrap leader'),
      }
    }
  }

  const outputFailure = output.failure()
  if (outputFailure !== null) {
    primaryFailure ??= { error: outputFailure }
  }
  if (output.survived()) {
    primaryFailure ??= {
      error: new Error('real bwrap orphan probe emitted a survivor frame'),
    }
  }
  if (exitFailure !== null) {
    cleanupFailure ??= { error: exitFailure }
  }

  if (cleanupFailure !== null) throw cleanupFailure.error
  if (primaryFailure !== null) throw primaryFailure.error
}

function startServer(
  binaryPath: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
): RunningServer {
  const nonce = randomUUID()
  const child = Bun.spawn({
    cmd: [
      '/usr/bin/python3',
      '-c',
      GROUP_OWNERSHIP_SUPERVISOR_SCRIPT,
      nonce,
      String(SERVER_SUPERVISOR_WATCHDOG_SECONDS),
      binaryPath,
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '0',
      '--no-mdns',
    ],
    cwd,
    env: { ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })
  let childExited = false
  const exited = child.exited.then(
    (code) => {
      childExited = true
      return code
    },
    (error: unknown) => {
      childExited = true
      throw error
    },
  )
  void exited.catch(() => undefined)
  let resolvePort!: (port: number) => void
  let rejectPort!: (error: Error) => void
  let settled = false
  const port = new Promise<number>((resolve, reject) => {
    resolvePort = resolve
    rejectPort = reject
  })
  let stderrText = ''
  const stdoutDone = (async () => {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffered = ''
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        buffered += decoder.decode(next.value, { stream: true })
        for (;;) {
          const newline = buffered.indexOf('\n')
          if (newline < 0) break
          const line = buffered.slice(0, newline).replace(/\r$/, '')
          buffered = buffered.slice(newline + 1)
          const match = LISTEN_LINE.exec(line)
          if (settled || match === null) {
            throw new Error('unexpected official OpenCode listen output')
          }
          settled = true
          resolvePort(Number(match[1]))
        }
      }
      buffered += decoder.decode()
      if (buffered !== '' || !settled) {
        throw new Error(
          `official OpenCode exited before a complete listen line: stdout=${JSON.stringify(buffered)} stderr=${JSON.stringify(stderrText)}`,
        )
      }
    } catch (error) {
      if (!settled) {
        settled = true
        rejectPort(error instanceof Error ? error : new Error('listen monitor failed'))
      }
      throw error
    } finally {
      reader.releaseLock()
    }
  })()
  void stdoutDone.catch(() => {})
  const stderrDone = (async () => {
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        if (stderrText.length < 8_192) {
          stderrText += decoder.decode(next.value, { stream: true })
        }
        // The no-LLM preflight has no diagnostic contract on server stderr;
        // drain it so the child cannot block on a full pipe.
      }
      if (stderrText.length < 8_192) stderrText += decoder.decode()
    } finally {
      reader.releaseLock()
    }
  })()
  void stderrDone.catch(() => {})
  return {
    child,
    exited,
    childExited: () => childExited,
    port,
    stdoutDone,
    stderrDone,
  }
}

async function stopServer(server: RunningServer): Promise<void> {
  const hardDeadline = monotonicDeadline(5_000)
  const stopped = await stopOwnedProcessGroup({
    groupLeaderPid: server.child.pid,
    childExited: server.childExited,
    hardDeadline,
  })
  if (!stopped.termSent || !stopped.killSent || !stopped.leaderReaped || !stopped.groupExited) {
    throw new Error('official OpenCode server process group did not stop cleanly')
  }
  await waitUntilDeadline(
    Promise.all([server.exited, server.stdoutDone, server.stderrDone]).then(() => undefined),
    hardDeadline,
    'official OpenCode server pipe drain timed out',
  )
}

describe('RFC-224 Linux cancellation oracle protocol', () => {
  test('rejects a target that self-exits after ARMED but before the TERM freeze lease', async () => {
    const nonce = randomUUID()
    const hardDeadline = monotonicDeadline(ORPHAN_HARD_TIMEOUT_MS)
    const child = Bun.spawn({
      cmd: [
        '/usr/bin/python3',
        '-c',
        BWRAP_CANCELLATION_SUPERVISOR_SCRIPT,
        nonce,
        String(ORPHAN_WATCHDOG_SECONDS),
        '/usr/bin/python3',
        '-c',
        SELF_EXIT_AFTER_ARM_SCRIPT,
        nonce,
      ],
      cwd: '/',
      env: {},
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      detached: true,
    })
    const output = observeDoubleForkOutput(child.stdout, nonce, child.pid)
    let leaderReaped = false
    let groupExited = false
    const exited = child.exited.then(
      (code) => {
        leaderReaped = true
        return code
      },
      (error: unknown) => {
        leaderReaped = true
        throw error
      },
    )
    void exited.catch(() => undefined)

    let primaryFailure: { error: unknown } | null = null
    try {
      await waitUntilDeadline(
        output.ready,
        phaseDeadline(hardDeadline, ORPHAN_READY_TIMEOUT_MS),
        'self-exit oracle fixture readiness timed out',
      )
      await child.stdin.write(`RFC224_CTL ${nonce} ARM\n`)
      await child.stdin.flush()
      await waitUntilDeadline(
        output.armed,
        phaseDeadline(hardDeadline, ORPHAN_READY_TIMEOUT_MS),
        'self-exit oracle fixture arming timed out',
      )

      // The anchor concurrently waits the exact unreaped child and emits the
      // failure frame itself. No wall-clock delay or host PID observation is
      // allowed to stand in for this causal kernel outcome.
      await expect(
        waitUntilDeadline(
          output.frozen,
          phaseDeadline(hardDeadline, ORPHAN_READY_TIMEOUT_MS),
          'self-exit oracle fixture did not reject before freeze',
        ),
      ).rejects.toThrow('supervisor failure')
      expect(output.failure()?.message).toContain('TARGET_EXIT PRETERM')
      await expect(exited).resolves.toBe(137)
      expect(await settlesBy(output.closed, hardDeadline)).toBe(true)
      expect(processGroupAlive(child.pid)).toBe(false)
      groupExited = true
    } catch (error) {
      primaryFailure = { error }
    }

    try {
      await child.stdin.end()
    } catch {
      // The expected supervisor SIGKILL closes the control pipe first.
    }
    let cleanupFailure: { error: unknown } | null = null
    try {
      if (!leaderReaped) {
        const stopped = await stopOwnedProcessGroup({
          groupLeaderPid: child.pid,
          childExited: () => leaderReaped,
          hardDeadline,
        })
        leaderReaped = stopped.leaderReaped
        groupExited ||= stopped.groupExited
      }
      if (!leaderReaped || !groupExited) {
        cleanupFailure = {
          error: new Error('self-exit oracle fixture cleanup did not reap its owned process group'),
        }
      }
      if (!(await settlesBy(output.closed, hardDeadline))) {
        cleanupFailure ??= {
          error: new Error('self-exit oracle fixture output did not close'),
        }
      }
    } catch (error) {
      cleanupFailure = { error }
    }

    if (cleanupFailure !== null) throw cleanupFailure.error
    if (primaryFailure !== null) throw primaryFailure.error
  })
})

describe.skipIf(!RUN_INTEGRATION)('RFC-224 official no-LLM execution identity', () => {
  test('attests config, provider, agent, skill, and root-session contracts on one instance', async () => {
    const canonicalTmp = await realpath(tmpdir())
    const root = await mkdtemp(join(canonicalTmp, 'aw-rfc224-official-preflight-'))
    const worktree = join(root, 'worktree')
    const storeRoot = join(root, 'store')
    await mkdir(worktree, { recursive: true, mode: 0o700 })
    await writeFile(join(worktree, 'README.md'), '# official no-LLM preflight\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 'rfc224@example.invalid'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'RFC-224'], { cwd: worktree })
    execFileSync('git', ['add', 'README.md'], { cwd: worktree })
    execFileSync('git', ['commit', '-qm', 'init fixture'], { cwd: worktree })

    const layout = await prepareHermeticOpencodeLayout(storeRoot)
    const fffProbeRoot = join(root, 'fff-probe')
    const controlledConfig = buildControlledOpencodeConfig({
      name: 'aw-rfc224-official',
      prompt: 'RFC-224 no-LLM identity preflight',
      description: 'RFC-224 no-LLM identity preflight',
      model: `${PINNED_MODEL.providerID}/${PINNED_MODEL.modelID}`,
      options: {},
      userPermission: {},
      toolOutputPattern: join(layout.xdgData, 'opencode', 'tool-output', '*'),
      shellPath: '/bin/false',
      allowShell: false,
      mcp: {},
    })
    const auth = buildStrictProviderAuth(PINNED_MODEL.providerID, {
      OPENAI_API_KEY: 'rfc224-local-schema-only-key',
    })
    const username = 'aw-rfc224-preflight'
    const password = 'aw-rfc224-preflight-password'
    const serverEnv = buildHermeticServerEnv({
      layout,
      providerID: PINNED_MODEL.providerID,
      auth,
      config: controlledConfig,
      username,
      password,
      sourceEnv: {},
    })
    serverEnv.PWD = worktree

    try {
      await withOfficialOpencodeSnapshot([OPENCODE_BIN], async (binaryPath) => {
        if (process.platform === 'linux') {
          const bwrapPath = await requireRootOwnedBwrap()
          await verifyRealBwrapCancellation(bwrapPath)
          const capability = await materializeFffCapabilityProbe({
            probeRoot: fffProbeRoot,
            bwrapPath,
          })
          await runFffCapabilityProbe({
            binaryPath,
            runRoot: root,
            probe: capability.probe,
            timeoutMs: 10_000,
          })
        }
        const server = startServer(binaryPath, worktree, serverEnv)
        try {
          const port = await Promise.race([
            server.port,
            boundedDelay(10_000).then(() => {
              throw new Error('official OpenCode listen timeout')
            }),
          ])
          const client = new OpencodeDirectClient({
            origin: `http://127.0.0.1:${port}`,
            directory: worktree,
            username,
            password,
            budgets: { maxJsonBytes: 4 * 1024 * 1024, requestTimeoutMs: 10_000 },
          })

          const effectiveConfig = await client.getConfig()
          const providers = await client.getConfigProviders()
          const agents = await client.getAgents()
          const skills = await client.getSkills()
          const secondAgents = await client.getAgents()
          const proof = verifyExecutionIdentity({
            expectedInlineConfig: controlledConfig,
            effectiveConfig,
            agents,
            secondAgents,
            selectedAgentName: 'aw-rfc224-official',
            permissionHome: layout.home,
          })
          expect(proof.controlledAgentNames).toEqual(['aw-rfc224-official'])
          verifySelectedProviderInventory(providers, PINNED_MODEL)
          verifyPinnedSkillInventory(skills)

          const title = 'agent-workflow:rfc224:official-no-llm-preflight'
          const created = await client.createSession(
            buildCreateSessionRequest({
              title,
              agent: 'aw-rfc224-official',
              model: PINNED_MODEL,
            }),
          )
          const session = validateSessionIdentity(
            created,
            {
              directory: worktree,
              path: '',
              title,
              agent: 'aw-rfc224-official',
              model: PINNED_MODEL,
              version: '1.18.3',
            },
            'create-response',
          )
          expect(session.projectID).not.toBe('global')
          expect(session.parentID).toBeUndefined()
          expect(session.workspaceID).toBeUndefined()
          expect(session.share).toBeUndefined()
          expect(session.revert).toBeUndefined()
          expect(session.metadata).toBeUndefined()
        } finally {
          await stopServer(server)
        }
      })
    } finally {
      await removeSealedTree(fffProbeRoot).catch(() => undefined)
      await removeHermeticOpencodeLayout(storeRoot).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

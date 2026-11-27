// RFC-625: PID reuse must not block restart; the same live incarnation must remain exclusive.
import { afterEach, describe, expect, test } from 'bun:test'
import { dlopen, type Pointer } from 'bun:ffi'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireLock,
  adoptCurrentProcessLock,
  createCurrentProcessLockOwner,
  DaemonLockHeldError,
  isDaemonLockOwnerAlive,
  parseDaemonLockOwner,
  readDaemonLockOwner,
  readLivePidFromLock,
  readPidFromLock,
  serializeDaemonLockOwner,
  writePidFileForTest,
} from '../src/platform/execution/local/daemonLock'
import {
  isWindowsCreationTime,
  readWindowsProcessIdentity,
  type WindowsProcessIdentity,
  type WindowsProcessIdentityApi,
} from '../src/platform/execution/local/windowsProcessIdentity'
import { isProcessAlive } from '../src/platform/execution/local/process'
import { createAutoUpgradeSessionLock } from '../src/modules/system-operations/infrastructure/local/autoUpgradeSessionLock'
import { statusCommand } from '../src/cli/status'
import { stopCommand } from '../src/cli/stop'

const roots: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'aw-rfc625-lock-'))
  roots.push(home)
  return { home, path: join(home, '.daemon.lock') }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const birth = '134235874392237181'
// The syscall seam never dereferences this synthetic handle; real FFI handles use Pointer.
const simulatedHandle = 42 as Pointer
function observer(identity: WindowsProcessIdentity, alive = true) {
  return { platform: 'win32' as const, alive: () => alive, identity: () => identity }
}

describe('daemon owner incarnation and legacy compatibility', () => {
  test('the same live PID and creation identity remains exclusive, including this process', () => {
    const owner = { pid: process.pid, token: 'current', creationTime: birth }
    expect(isDaemonLockOwnerAlive(owner, observer({ state: 'running', creationTime: birth }))).toBe(
      true,
    )
    expect(
      isDaemonLockOwnerAlive(
        owner,
        observer({ state: 'running', creationTime: String(BigInt(birth) + 1n) }),
      ),
    ).toBe(false)
    expect(isDaemonLockOwnerAlive(owner, observer({ state: 'dead' }))).toBe(false)
    expect(isDaemonLockOwnerAlive(owner, observer({ state: 'unknown' }, false))).toBe(true)
  })

  test('legacy and POSIX owners keep their original process liveness rule', () => {
    expect(isDaemonLockOwnerAlive({ pid: 19 }, observer({ state: 'dead' }))).toBe(true)
    expect(
      isDaemonLockOwnerAlive(
        { pid: 19 },
        observer({ state: 'running', creationTime: birth }, false),
      ),
    ).toBe(false)
    expect(
      isDaemonLockOwnerAlive(
        { pid: 19, creationTime: birth },
        { ...observer({ state: 'dead' }), platform: 'linux' },
      ),
    ).toBe(true)
  })

  test('64-bit FILETIME and PID first line survive the complete owner roundtrip', () => {
    const owner = { pid: process.pid, token: 'roundtrip', creationTime: '18446744073709551615' }
    const text = serializeDaemonLockOwner(owner)
    expect(text.split('\n')[0]).toBe(String(process.pid))
    expect(parseDaemonLockOwner(text)).toEqual(owner)
    expect(isWindowsCreationTime('18446744073709551616')).toBe(false)
    expect(isWindowsCreationTime(Number('134235874392237181'))).toBe(false)
    expect(isWindowsCreationTime('1e17')).toBe(false)
  })

  test('partial, malformed and unknown metadata never turn a legacy live PID into stale', () => {
    const records = [
      String(process.pid),
      `${process.pid}\n{`,
      `${process.pid}\nnull`,
      `${process.pid}\n{"version":2,"token":"future","creationTime":"1"}`,
      `${process.pid}\n{"version":1,"token":"bad-time","creationTime":"18446744073709551616"}`,
    ]
    const f = fixture()
    for (const record of records) {
      writeFileSync(f.path, record)
      expect(parseDaemonLockOwner(record)).toEqual({ pid: process.pid })
      expect(() => acquireLock(f.path)).toThrow(DaemonLockHeldError)
      expect(readFileSync(f.path, 'utf8')).toBe(record)
    }
  })

  test('every adoption gets a new token and late release preserves the replacement', () => {
    const f = fixture()
    const first = acquireLock(f.path)
    const initial = readDaemonLockOwner(f.path)!
    const second = adoptCurrentProcessLock(f.path)
    const replacement = readDaemonLockOwner(f.path)!
    expect(replacement.pid).toBe(initial.pid)
    expect(replacement.creationTime).toBe(initial.creationTime)
    expect(replacement.token).not.toBe(initial.token)
    expect(first.isHeld?.()).toBe(false)
    first.release()
    expect(second.isHeld?.()).toBe(true)
    expect(() => acquireLock(f.path)).toThrow(DaemonLockHeldError)
    const third = adoptCurrentProcessLock(f.path)
    second.release()
    expect(third.isHeld?.()).toBe(true)
    third.release()
    expect(existsSync(f.path)).toBe(false)
  })

  test('explicit adoption upgrades a current legacy PID; ordinary acquisition still refuses it', () => {
    const f = fixture()
    writePidFileForTest(f.path, process.pid)
    expect(() => acquireLock(f.path)).toThrow(DaemonLockHeldError)
    const adopted = adoptCurrentProcessLock(f.path)
    expect(readDaemonLockOwner(f.path)?.token).toBeString()
    expect(readPidFromLock(f.path)).toBe(process.pid)
    adopted.release()
    expect(existsSync(f.path)).toBe(false)
  })

  test('a live PID first line remains compatible with action and display readers', () => {
    const f = fixture()
    const own = acquireLock(f.path)
    try {
      expect(readPidFromLock(f.path)).toBe(process.pid)
      expect(readLivePidFromLock(f.path)).toBe(process.pid)
      expect(parseDaemonLockOwner(readFileSync(f.path, 'utf8'))).toMatchObject({ pid: process.pid })
    } finally {
      own.release()
    }
    expect(readLivePidFromLock(f.path)).toBeNull()
  })

  test('auto-upgrade notices a same-process ownership replacement and does not release it', async () => {
    const f = fixture()
    const session = createAutoUpgradeSessionLock({
      appHome: f.home,
      startMonitor: () => ({ stop() {} }),
    })
    await session.acquire()
    await session.assertHeld()
    const replacement = adoptCurrentProcessLock(f.path)
    try {
      await expect(session.assertHeld()).rejects.toThrow('auto-upgrade-session-lock-lost')
      await session.release()
      expect(replacement.isHeld?.()).toBe(true)
    } finally {
      replacement.release()
    }
  })
})

describe('Windows process query handle discipline', () => {
  test('the same handle supplies wait and exact creation time, then closes once', () => {
    const calls: string[] = []
    const api: WindowsProcessIdentityApi = {
      open(pid) {
        calls.push(`open:${pid}`)
        return simulatedHandle
      },
      lastError: () => 0,
      wait(handle) {
        calls.push(`wait:${handle}`)
        return 258
      },
      creationTime(handle) {
        calls.push(`time:${handle}`)
        return birth
      },
      close(handle) {
        calls.push(`close:${handle}`)
      },
    }
    expect(readWindowsProcessIdentity(15, api)).toEqual({ state: 'running', creationTime: birth })
    expect(calls).toEqual(['open:15', 'wait:42', 'time:42', 'wait:42', 'close:42'])
  })

  test('absent PID differs from unavailable query; neither closes an unowned handle', () => {
    let closed = 0
    const api: WindowsProcessIdentityApi = {
      open: () => null,
      lastError: () => 87,
      wait: () => 258,
      creationTime: () => birth,
      close() {
        closed++
      },
    }
    expect(readWindowsProcessIdentity(15, api)).toEqual({ state: 'dead' })
    expect(readWindowsProcessIdentity(15, { ...api, lastError: () => 5 })).toEqual({
      state: 'unknown',
    })
    expect(readWindowsProcessIdentity(15, null)).toEqual({ state: 'unknown' })
    // Import-time platform binding remains unavailable on POSIX; invalid PIDs never query it.
    if (process.platform !== 'win32')
      expect(readWindowsProcessIdentity(process.pid)).toEqual({ state: 'unknown' })
    for (const pid of [0, -1, 1.5, 0x100000000, Number.NaN])
      expect(readWindowsProcessIdentity(pid)).toEqual({ state: 'unknown' })
    expect(closed).toBe(0)
  })

  test('exit, query failure and exception always close the acquired handle', () => {
    for (const variant of [
      'dead',
      'wait-failed',
      'time-failed',
      'exception',
      'exit-during-query',
    ] as const) {
      let closed = 0
      let waits = 0
      const api: WindowsProcessIdentityApi = {
        open: () => simulatedHandle,
        lastError: () => 0,
        wait() {
          waits++
          return variant === 'dead' || (variant === 'exit-during-query' && waits === 2)
            ? 0
            : variant === 'wait-failed'
              ? 0xffffffff
              : 258
        },
        creationTime() {
          if (variant === 'exception') throw new Error('query failed')
          return variant === 'time-failed' ? null : birth
        },
        close() {
          closed++
        },
      }
      expect(readWindowsProcessIdentity(15, api)).toEqual({
        state: variant === 'dead' || variant === 'exit-during-query' ? 'dead' : 'unknown',
      })
      expect(closed).toBe(1)
    }
  })
})

describe.skipIf(process.platform !== 'win32')('native Windows process incarnation', () => {
  test('the current process identity is stable and is published in its lock', () => {
    const identity = readWindowsProcessIdentity(process.pid)
    expect(identity.state).toBe('running')
    // A per-call unavailable adapter must not replace the immutable native binding.
    expect(readWindowsProcessIdentity(process.pid, null)).toEqual({ state: 'unknown' })
    expect(readWindowsProcessIdentity(process.pid)).toEqual(identity)
    const f = fixture(),
      lock = acquireLock(f.path)
    try {
      const owner = readDaemonLockOwner(f.path)!
      expect(owner.creationTime).toBe(
        identity.state === 'running' ? identity.creationTime : 'missing',
      )
      expect(() => acquireLock(f.path)).toThrow(DaemonLockHeldError)
    } finally {
      lock.release()
    }
  })

  test('a known old creation identity at this live PID is reclaimable but cannot be adopted', () => {
    const f = fixture(),
      current = createCurrentProcessLockOwner()
    expect(current.creationTime).toBeString()
    writeFileSync(f.path, serializeDaemonLockOwner({ ...current, creationTime: '1' }))
    expect(readPidFromLock(f.path)).toBe(process.pid)
    expect(readLivePidFromLock(f.path)).toBeNull()
    expect(() => adoptCurrentProcessLock(f.path)).toThrow('not owned by current process')
    const reclaimed = acquireLock(f.path)
    try {
      expect(readDaemonLockOwner(f.path)?.creationTime).toBe(current.creationTime)
      expect(() => acquireLock(f.path)).toThrow(DaemonLockHeldError)
    } finally {
      reclaimed.release()
    }
  })

  test('status and stop treat the recorded old incarnation as stale without stopping the reused PID', async () => {
    const f = fixture(),
      previousHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = f.home
    try {
      const current = createCurrentProcessLockOwner()
      expect(current.creationTime).toBeString()
      writeFileSync(f.path, serializeDaemonLockOwner({ ...current, creationTime: '1' }))
      expect(
        await statusCommand({
          readCurrent: () => {
            throw new Error('stale owner must not be queried')
          },
        }),
      ).toEqual({ state: 'stale-lock', pid: process.pid })
      expect((await stopCommand()).status).toBe('stale-lock-removed')
      expect(isProcessAlive(process.pid)).toBe(true)
      expect(existsSync(f.path)).toBe(false)
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = previousHome
    }
  })

  test('an exited child remains dead while another process handle is retained', async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, '-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const kernel = dlopen('kernel32.dll', {
      OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'ptr' },
      CloseHandle: { args: ['ptr'], returns: 'i32' },
    })
    let retained: ReturnType<typeof kernel.symbols.OpenProcess> = null
    try {
      const reader = child.stdout.getReader()
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready')
      } finally {
        reader.releaseLock()
      }
      const live = readWindowsProcessIdentity(child.pid)
      expect(live.state).toBe('running')
      retained = kernel.symbols.OpenProcess(0x1000 | 0x100000, 0, child.pid)
      expect(retained).not.toBeNull()
      const f = fixture()
      expect(live.state).toBe('running')
      if (live.state !== 'running') throw new Error('child creation identity unavailable')
      writeFileSync(
        f.path,
        serializeDaemonLockOwner({
          pid: child.pid,
          token: 'child',
          creationTime: live.creationTime,
        }),
      )
      expect(() => acquireLock(f.path)).toThrow(DaemonLockHeldError)
      child.kill('SIGKILL')
      await child.exited
      expect(readWindowsProcessIdentity(child.pid)).toEqual({ state: 'dead' })
      expect(isProcessAlive(child.pid)).toBe(false)
      const reclaimed = acquireLock(f.path)
      reclaimed.release()
      expect(existsSync(f.path)).toBe(false)
    } finally {
      child.kill('SIGKILL')
      await child.exited
      if (retained) kernel.symbols.CloseHandle(retained)
      kernel.close()
    }
  })
})

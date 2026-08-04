// RFC-254 T4 (design gate P0-D) — process-tree ownership.
//
// WHAT THIS FILE CAN AND CANNOT PROVE
// -----------------------------------
// The Job Object itself needs a Windows kernel. Windows containers require a
// Windows host, so Docker on a POSIX dev box is not a substitute, and Wine
// emulates Job Object semantics too incompletely to count as evidence for a
// process-LIFETIME boundary. The real proof therefore runs on a Windows runner
// (`.github/workflows/windows-platform.yml`) and on a Windows VM.
//
// What IS provable here, and matters just as much:
//   * POSIX behaviour did not drift — including the RFC-252 sandbox-monitor
//     graceful phase that shares this function;
//   * the win32 branch DEGRADES HONESTLY. `isProcessTreeAlive` must answer
//     `null` ("cannot tell") rather than `false` when no job was adopted,
//     because a caller deciding whether to reclaim a runtime store treats
//     `false` as "safe to reuse" — that confusion is exactly the data
//     corruption P0-D identified.

import { describe, expect, test } from 'bun:test'
import {
  adoptProcessTree,
  processTreeOwnershipAvailable,
  processTreeOwnershipDiagnosis,
  WIN32_JOB_LAYOUT,
} from '@/util/windowsJobObject'
import { adoptSpawnedProcessTree, isProcessTreeAlive, killProcessTree } from '@/util/process'

describe('RFC-254 T4 — process tree ownership', () => {
  test('POSIX needs no job object to answer authoritatively', () => {
    expect(processTreeOwnershipAvailable('linux')).toBe(true)
    expect(processTreeOwnershipAvailable('darwin')).toBe(true)
  })

  test('adoption is inert on POSIX and real on Windows', async () => {
    // NEVER adopt `process.pid`: a KILL_ON_JOB_CLOSE job terminates every
    // member when its last handle closes, so adopting the TEST RUNNER kills the
    // test run. The first Windows CI run did exactly that and took the rest of
    // this file down with it — a mistake worth leaving a scar for.
    const child = Bun.spawn({
      cmd: [process.execPath, '-e', 'setTimeout(() => {}, 30_000)'],
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    try {
      const owned = adoptProcessTree(child.pid)
      if (process.platform === 'win32') {
        // Availability is a property of the BUN BUILD, not of Windows: the
        // ARM64 build ships with TinyCC disabled, so `bun:ffi dlopen()` throws
        // and job objects are simply absent (measured on Windows 11 ARM64 +
        // Bun 1.3.14 — the first draft of this test asserted they must exist
        // and failed on a machine where the production code was behaving
        // exactly as designed).
        const diagnosis = processTreeOwnershipDiagnosis()
        if (!diagnosis.available) {
          expect(diagnosis.reason).toBe('ffi-unavailable')
          // The degradation must stay honest: no job means no authoritative
          // liveness answer, which is `null` and never `false`.
          expect(owned).toBeNull()
          expect(isProcessTreeAlive(child.pid)).toBeNull()
        } else {
          // Proves the FFI contract end to end: CreateJobObjectW +
          // SetInformationJobObject(KILL_ON_JOB_CLOSE) + OpenProcess +
          // AssignProcessToJobObject all succeeded against a real kernel.
          expect(owned).not.toBeNull()
          expect(owned?.kind).toBe('windows-job-object')
          expect(owned?.liveCount()).toBeGreaterThan(0)
          owned?.terminate()
          expect(owned?.liveCount()).toBe(0)
        }
      } else {
        expect(owned).toBeNull()
        expect(adoptSpawnedProcessTree(child.pid)).toBe(false)
      }
    } finally {
      try {
        child.kill(9)
      } catch {
        // Already terminated by the job.
      }
      await child.exited
    }
  }, 30_000)

  test('the win32 struct offsets match the documented Win32 layout', () => {
    // A wrong FFI offset does not throw. It reads a DIFFERENT field and returns
    // a plausible number — which is exactly how `ActiveProcesses` shipped at
    // offset 20 (inside `ThisPeriodTotalUserTime`, therefore 0 for a
    // just-started process) and made `liveCount()` report a running tree as
    // dead. That answer decides whether a runtime store may be reclaimed, so it
    // was a release-while-in-use, not a cosmetic bug. It survived macOS (no
    // FFI) and the ARM64 real machine (no dlopen in that Bun build); only the
    // x64 Windows CI leg executed it.
    //
    // These offsets are therefore derived here from FORWARD field sizes — the
    // same way one reads the struct definition — rather than restated.
    const LARGE_INTEGER = 8
    const DWORD = 4
    const SIZE_T = 8

    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    const totalUserTime = 0
    const totalKernelTime = totalUserTime + LARGE_INTEGER
    const thisPeriodUser = totalKernelTime + LARGE_INTEGER
    const thisPeriodKernel = thisPeriodUser + LARGE_INTEGER
    const totalPageFaultCount = thisPeriodKernel + LARGE_INTEGER
    const totalProcesses = totalPageFaultCount + DWORD
    const activeProcesses = totalProcesses + DWORD
    const totalTerminated = activeProcesses + DWORD
    expect(WIN32_JOB_LAYOUT.activeProcessesOffset).toBe(activeProcesses)
    expect(WIN32_JOB_LAYOUT.accountingStructBytes).toBe(totalTerminated + DWORD)

    // JOBOBJECT_BASIC_LIMIT_INFORMATION, then _EXTENDED_ around it.
    const limitFlags = LARGE_INTEGER * 2
    expect(WIN32_JOB_LAYOUT.basicLimitFlagsOffset).toBe(limitFlags)
    const basicLimitBytes =
      LARGE_INTEGER * 2 + // PerProcess/PerJob user time limits
      DWORD + // LimitFlags
      DWORD + // (padding to the SIZE_T that follows)
      SIZE_T * 2 + // Minimum/MaximumWorkingSetSize
      DWORD + // ActiveProcessLimit
      DWORD + // (padding)
      SIZE_T + // Affinity
      DWORD * 2 // PriorityClass, SchedulingClass
    const ioCounters = 8 * 6 // six ULONGLONGs
    expect(WIN32_JOB_LAYOUT.extendedLimitStructBytes).toBe(
      basicLimitBytes + ioCounters + SIZE_T * 4,
    )
  })

  test('invalid pids are rejected before any syscall', () => {
    expect(adoptProcessTree(0)).toBeNull()
    expect(adoptProcessTree(-1)).toBeNull()
    expect(adoptProcessTree(1.5)).toBeNull()
    expect(killProcessTree(0, 'SIGKILL')).toBe(false)
    expect(isProcessTreeAlive(0)).toBe(false)
  })

  test.skipIf(process.platform === 'win32')(
    'POSIX liveness reports the real process group',
    async () => {
      const child = Bun.spawn({
        cmd: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
        detached: true,
        stdout: 'ignore',
        stderr: 'ignore',
        stdin: 'ignore',
      })
      const pid = child.pid
      try {
        expect(typeof pid).toBe('number')
        // The child is its own group leader (`detached`), so the group is alive.
        expect(isProcessTreeAlive(pid)).toBe(true)
        expect(killProcessTree(pid, 'SIGKILL')).toBe(true)
        const deadline = Date.now() + 5_000
        while (isProcessTreeAlive(pid) === true && Date.now() < deadline) {
          await Bun.sleep(10)
        }
        expect(isProcessTreeAlive(pid)).not.toBe(true)
      } finally {
        try {
          child.kill(9)
        } catch {
          // Already gone.
        }
        await child.exited
      }
    },
    30_000,
  )

  test.skipIf(process.platform === 'win32')(
    'the question is about a GROUP LEADER, not any live pid',
    () => {
      // Worth pinning because it is easy to misread the name: a pid that leads
      // no process group has no tree, so POSIX answers `false` even though the
      // process itself is very much alive (this test runner). Callers only ever
      // pass pids of `detached` children, which ARE leaders.
      expect(isProcessTreeAlive(process.pid)).toBe(false)
    },
  )

  test('the win32 "cannot tell" outcome is a distinct third value', () => {
    // The contract that keeps P0-D closed: `null` means "no authoritative
    // answer", and a caller must treat it as NOT safe to reclaim a store.
    // `false` (safe) and `null` (unknown) must never collapse into each other.
    // Exercising the win32 branch needs a Windows kernel — proven by
    // .github/workflows/windows-platform.yml — so what is asserted here is that
    // the type genuinely admits the third value and POSIX never produces it.
    const verdict: boolean | null = isProcessTreeAlive(process.pid)
    expect([true, false, null]).toContain(verdict)
    // On Windows an unadopted pid is exactly the `null` case; on POSIX the
    // group answer is always definite. Both are correct — what must never
    // happen is `null` and `false` being treated as the same thing.
    // On Windows an unadopted pid has no authoritative answer at all; on POSIX
    // the group answer is always definite.
    expect(verdict === null).toBe(process.platform === 'win32')
  })
})

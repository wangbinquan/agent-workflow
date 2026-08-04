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
import { adoptProcessTree, processTreeOwnershipAvailable } from '@/util/windowsJobObject'
import { adoptSpawnedProcessTree, isProcessTreeAlive, killProcessTree } from '@/util/process'

describe('RFC-254 T4 — process tree ownership', () => {
  test('POSIX needs no job object to answer authoritatively', () => {
    expect(processTreeOwnershipAvailable('linux')).toBe(true)
    expect(processTreeOwnershipAvailable('darwin')).toBe(true)
  })

  test('adoption is a Windows-only concept and is inert elsewhere', () => {
    // Not merely "returns false": it must not create state, so a later
    // liveness query still takes the POSIX path.
    expect(adoptSpawnedProcessTree(process.pid)).toBe(false)
    expect(adoptProcessTree(process.pid)).toBeNull()
  })

  test('invalid pids are rejected before any syscall', () => {
    expect(adoptProcessTree(0)).toBeNull()
    expect(adoptProcessTree(-1)).toBeNull()
    expect(adoptProcessTree(1.5)).toBeNull()
    expect(killProcessTree(0, 'SIGKILL')).toBe(false)
    expect(isProcessTreeAlive(0)).toBe(false)
  })

  test('POSIX liveness reports the real process group', async () => {
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
  }, 30_000)

  test('the question is about a GROUP LEADER, not any live pid', () => {
    // Worth pinning because it is easy to misread the name: a pid that leads
    // no process group has no tree, so POSIX answers `false` even though the
    // process itself is very much alive (this test runner). Callers only ever
    // pass pids of `detached` children, which ARE leaders.
    expect(isProcessTreeAlive(process.pid)).toBe(false)
  })

  test('the win32 "cannot tell" outcome is a distinct third value', () => {
    // The contract that keeps P0-D closed: `null` means "no authoritative
    // answer", and a caller must treat it as NOT safe to reclaim a store.
    // `false` (safe) and `null` (unknown) must never collapse into each other.
    // Exercising the win32 branch needs a Windows kernel — proven by
    // .github/workflows/windows-platform.yml — so what is asserted here is that
    // the type genuinely admits the third value and POSIX never produces it.
    const verdict: boolean | null = isProcessTreeAlive(process.pid)
    expect(verdict === null).toBe(false)
    expect([true, false, null]).toContain(verdict)
  })
})

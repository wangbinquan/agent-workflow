// RFC-254 T4 (D9, design gate P0-D) — Windows process-tree ownership.
//
// WHY THIS IS REQUIRED FOR v1, not deferred with the containment provider
// ----------------------------------------------------------------------
// The verified launcher treats a POSIX process GROUP as the ownership unit for
// a runtime store: `stopServer` only reports stopped once the child has settled
// AND the group is no longer alive, and the caller then marks the run reaped,
// cleans up, and RELEASES THE SQLITE STORE FOR REUSE
// (`verifiedLauncher.ts:206,928,1237`).
//
// Windows has no process groups. The first draft of this RFC proposed degrading
// `isGroupAlive` to a single-PID check plus `taskkill /T`, and the design gate
// showed why that is not a defence-in-depth trade-off but a data-corruption
// one: a surviving grandchild still holds the store while the platform declares
// it reaped and hands it to the next run. `taskkill` is also enumerative — it
// walks a snapshot of the tree, so anything forked during the walk escapes.
//
// A Job Object is the actual Windows equivalent of the guarantee we need:
//   * every descendant is in the job automatically (they inherit membership,
//     and we forbid breakaway), so there is no snapshot to race;
//   * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates the whole job the moment
//     the last handle closes — including when the DAEMON ITSELF dies, which is
//     strictly stronger than the POSIX status quo;
//   * `QueryInformationJobObject` reports the live process count, which is the
//     authoritative "is this tree still alive" answer the store-reclaim
//     decision needs.
//
// SCOPE: this module is process-lifetime governance only. It is NOT a
// containment provider — it grants no filesystem or network isolation, claims
// no capability, and does not participate in admission (D1 stands).
//
// It uses Bun FFI against kernel32 rather than a native module because the
// product ships as ONE self-contained executable; a `.node` addon cannot ride
// along. OpenCode itself does the same thing for its console handling
// (`packages/tui/src/terminal-win32.ts`).
//
// ⚠️ MEASURED LIMITATION (Windows 11 ARM64, Bun 1.3.14, 2026-08-04)
// -----------------------------------------------------------------
// `bun:ffi`'s `dlopen()` is NOT present in every Bun build. On the Windows
// ARM64 build it throws
//
//     bun:ffi dlopen() is not available in this build (TinyCC is disabled)
//
// so this whole module degrades to unavailable there — verified by running the
// FFI directly on a real VM, not inferred. The consequence is deliberate and
// must stay visible: `adoptSpawnedProcessTree` returns false, the caller falls
// back to `taskkill /T /F`, and — per design gate P0-D — a taskkill-only
// cleanup MUST NOT be treated as proof that a runtime store may be reclaimed.
// `isProcessTreeAlive` therefore answers `null` ("cannot tell"), never `false`.
//
// The x64 Bun build does ship dlopen, which is why the release target
// (windows x86_64, RFC-254 D6) keeps the strong guarantee. Anyone extending
// support to ARM64 has to close this first.

// `bun:ffi` itself is available on every platform Bun runs on — only the
// `dlopen('kernel32.dll')` call is Windows-specific, and that is guarded — so a
// static import is safe and keeps the module free of `require()`.
import { dlopen, ptr } from 'bun:ffi'

/** Ownership handle for one spawned tree. Opaque outside this module. */
export interface ProcessTreeOwnership {
  readonly kind: 'windows-job-object' | 'posix-process-group' | 'none'
  /** Terminate every process in the tree. Idempotent. */
  terminate: () => void
  /** Live process count, or null when this platform cannot answer. */
  liveCount: () => number | null
  /** Release the handle WITHOUT killing (used when ownership transfers). */
  dispose: () => void
}

// --- win32 constants ---------------------------------------------------------

/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION class ordinal. */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
/** JOBOBJECT_BASIC_ACCOUNTING_INFORMATION class ordinal. */
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
/** LimitFlags bit: kill every member when the last handle closes. */
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
/** Access rights for OpenProcess: we only need to assign and query. */
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_TERMINATE = 0x0001

/**
 * Byte offsets inside JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64).
 *
 * The struct starts with JOBOBJECT_BASIC_LIMIT_INFORMATION, whose LimitFlags
 * sits after two LARGE_INTEGERs (PerProcessUserTimeLimit, PerJobUserTimeLimit).
 * Hard-coding the offset rather than describing the whole struct keeps the FFI
 * surface to the two fields we actually set, and the layout is part of the
 * stable Win32 ABI.
 */
const EXTENDED_LIMIT_STRUCT_BYTES = 144
const BASIC_LIMIT_FLAGS_OFFSET = 16

/**
 * Byte offset of ActiveProcesses inside JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
 * (x64): six LARGE_INTEGERs precede it.
 */
const ACCOUNTING_STRUCT_BYTES = 48
const ACTIVE_PROCESSES_OFFSET = 48 - 4 - 8 - 8 - 8

type Kernel32 = {
  symbols: {
    CreateJobObjectW: (a: null, b: null) => number | bigint
    AssignProcessToJobObject: (job: number | bigint, proc: number | bigint) => number
    SetInformationJobObject: (
      job: number | bigint,
      cls: number,
      info: unknown,
      len: number,
    ) => number
    QueryInformationJobObject: (
      job: number | bigint,
      cls: number,
      info: unknown,
      len: number,
      ret: null,
    ) => number
    TerminateJobObject: (job: number | bigint, exitCode: number) => number
    OpenProcess: (access: number, inherit: number, pid: number) => number | bigint
    CloseHandle: (handle: number | bigint) => number
  }
}

let kernel32: Kernel32 | null | undefined

function loadKernel32(): Kernel32 | null {
  if (process.platform !== 'win32') return null
  if (kernel32 !== undefined) return kernel32
  try {
    kernel32 = dlopen('kernel32.dll', {
      CreateJobObjectW: { args: ['ptr', 'ptr'], returns: 'ptr' },
      AssignProcessToJobObject: { args: ['ptr', 'ptr'], returns: 'i32' },
      SetInformationJobObject: { args: ['ptr', 'i32', 'ptr', 'u32'], returns: 'i32' },
      QueryInformationJobObject: { args: ['ptr', 'i32', 'ptr', 'u32', 'ptr'], returns: 'i32' },
      TerminateJobObject: { args: ['ptr', 'u32'], returns: 'i32' },
      OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'ptr' },
      CloseHandle: { args: ['ptr'], returns: 'i32' },
    }) as unknown as Kernel32
  } catch {
    kernel32 = null
  }
  return kernel32
}

/** Test seam: forget the cached handle so a test can re-observe load failure. */
export function resetKernel32CacheForTests(): void {
  kernel32 = undefined
}

/**
 * Put an already-spawned process into a fresh kill-on-close job.
 *
 * Returns null when this platform has no job objects, or when any step fails —
 * callers must then fall back and, crucially, must NOT claim the strong
 * lifetime guarantee in whatever receipt they emit.
 *
 * KNOWN WINDOW: `Bun.spawn` returns after the child already exists, so a
 * process that forks in its very first instants could escape assignment. The
 * window is small but real; it is recorded rather than hidden, and closing it
 * needs CREATE_SUSPENDED support at the spawn layer.
 */
export function adoptProcessTree(pid: number): ProcessTreeOwnership | null {
  const k32 = loadKernel32()
  if (k32 === null || !Number.isInteger(pid) || pid <= 0) return null
  let job: number | bigint | null = null
  let processHandle: number | bigint | null = null
  try {
    job = k32.symbols.CreateJobObjectW(null, null)
    if (!job) return null

    const limits = new Uint8Array(EXTENDED_LIMIT_STRUCT_BYTES)
    new DataView(limits.buffer).setUint32(
      BASIC_LIMIT_FLAGS_OFFSET,
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      true,
    )
    const set = k32.symbols.SetInformationJobObject(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      ptr(limits),
      limits.byteLength,
    )
    if (set === 0) {
      k32.symbols.CloseHandle(job)
      return null
    }

    processHandle = k32.symbols.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid)
    if (!processHandle) {
      k32.symbols.CloseHandle(job)
      return null
    }
    const assigned = k32.symbols.AssignProcessToJobObject(job, processHandle)
    k32.symbols.CloseHandle(processHandle)
    processHandle = null
    if (assigned === 0) {
      k32.symbols.CloseHandle(job)
      return null
    }

    const handle = job
    let closed = false
    return {
      kind: 'windows-job-object',
      terminate: () => {
        if (closed) return
        try {
          k32.symbols.TerminateJobObject(handle, 1)
        } finally {
          closed = true
          k32.symbols.CloseHandle(handle)
        }
      },
      liveCount: () => {
        if (closed) return 0
        const info = new Uint8Array(ACCOUNTING_STRUCT_BYTES)
        const ok = k32.symbols.QueryInformationJobObject(
          handle,
          JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
          ptr(info),
          info.byteLength,
          null,
        )
        if (ok === 0) return null
        return new DataView(info.buffer).getUint32(ACTIVE_PROCESSES_OFFSET, true)
      },
      dispose: () => {
        if (closed) return
        closed = true
        // NOTE: closing the last handle of a KILL_ON_JOB_CLOSE job terminates
        // it. `dispose` therefore means "stop tracking AND stop the tree"; a
        // future transfer-of-ownership would need a duplicated handle first.
        k32.symbols.CloseHandle(handle)
      },
    }
  } catch {
    try {
      if (processHandle) k32.symbols.CloseHandle(processHandle)
      if (job) k32.symbols.CloseHandle(job)
    } catch {
      // Nothing else to do; the handles leak at worst until process exit.
    }
    return null
  }
}

/** True when this platform can provide an authoritative tree-liveness answer. */
export function processTreeOwnershipAvailable(platform: NodeJS.Platform): boolean {
  return platform !== 'win32' || loadKernel32() !== null
}

/**
 * Why job objects are unavailable, for diagnostics that must not conflate
 * "this Bun build cannot do FFI at all" with "kernel32 rejected our calls".
 *
 * The distinction is not hypothetical: on Windows ARM64 the shipped Bun build
 * has TinyCC disabled, so `dlopen` throws before any Win32 call happens. A
 * report of "Job Object setup failed" there would send someone hunting struct
 * offsets that are perfectly correct.
 */
export function processTreeOwnershipDiagnosis(): {
  available: boolean
  reason: 'available' | 'not-windows' | 'ffi-unavailable'
} {
  if (process.platform !== 'win32') return { available: false, reason: 'not-windows' }
  return loadKernel32() === null
    ? { available: false, reason: 'ffi-unavailable' }
    : { available: true, reason: 'available' }
}

// RFC-254 T4 — Windows process-tree ownership.
//
// Windows has no POSIX process groups. `taskkill /T` walks a point-in-time
// process snapshot, so a descendant created during that walk can escape.
// A Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` gives the daemon an
// atomic ownership unit for a spawned tree and an authoritative active-process
// count.
//
// This module is process-lifetime governance only. It grants no filesystem or
// network isolation and must not be described as a sandbox.
//
// Bun's Windows x64 build exposes kernel32 through `bun:ffi`; some ARM64 builds
// do not. When FFI is unavailable, adoption returns null and callers fall back
// to best-effort `taskkill /T /F`. `isProcessTreeAlive` therefore preserves a
// distinct unknown outcome for an unadopted tree.

// `bun:ffi` itself is available on every platform Bun runs on — only the
// `dlopen('kernel32.dll')` call is Windows-specific, and that is guarded — so a
// static import is safe and keeps the module free of `require()`.
import { dlopen, ptr } from 'bun:ffi'

/** Ownership handle for one spawned tree. Opaque outside this module. */
export interface ProcessTreeOwnership {
  readonly kind: 'windows-job-object' | 'posix-process-group' | 'none'
  /** Terminate every process in the tree. Idempotent. Returns false when the
   * syscall itself failed — the caller must not then claim the tree is gone. */
  terminate: () => boolean
  /** Live process count, or null when this platform cannot answer. */
  liveCount: () => number | null
  /**
   * Stop tracking AND stop the tree.
   *
   * NOT "release without killing": this is the only handle, and closing the
   * last handle of a KILL_ON_JOB_CLOSE job terminates every member. A real
   * transfer of ownership would have to duplicate the handle first.
   */
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
 * JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, laid out FORWARDS (x64):
 *
 *   0  LARGE_INTEGER TotalUserTime
 *   8  LARGE_INTEGER TotalKernelTime
 *  16  LARGE_INTEGER ThisPeriodTotalUserTime
 *  24  LARGE_INTEGER ThisPeriodTotalKernelTime
 *  32  DWORD         TotalPageFaultCount
 *  36  DWORD         TotalProcesses
 *  40  DWORD         ActiveProcesses      ← the only field read
 *  44  DWORD         TotalTerminatedProcesses
 *  48  (end)
 *
 * The first version of this computed the offset by SUBTRACTING trailing field
 * sizes from the struct size (`48 - 4 - 8 - 8 - 8`) and landed on 20 — inside
 * `ThisPeriodTotalUserTime`, which reads 0 for a process that has just started.
 * So `liveCount()` said "nothing alive" while the tree was running, allowing
 * cleanup to race a live descendant. It survived every macOS run (no FFI
 * there) and the ARM64 real machine (no dlopen in that Bun build); the x64
 * Windows CI leg caught it on its first execution. Offsets are written out
 * field by field now, and `rfc254-process-tree-ownership.test.ts` asserts each
 * one against this table.
 */
const ACCOUNTING_STRUCT_BYTES = 48
const ACTIVE_PROCESSES_OFFSET = 40

/**
 * The struct offsets above, exported so they can be asserted rather than
 * trusted. A wrong offset does not throw — it returns a plausible number from
 * the wrong field, which is how the `ActiveProcesses` bug survived review.
 */
export const WIN32_JOB_LAYOUT: {
  extendedLimitStructBytes: number
  basicLimitFlagsOffset: number
  accountingStructBytes: number
  activeProcessesOffset: number
} = {
  extendedLimitStructBytes: EXTENDED_LIMIT_STRUCT_BYTES,
  basicLimitFlagsOffset: BASIC_LIMIT_FLAGS_OFFSET,
  accountingStructBytes: ACCOUNTING_STRUCT_BYTES,
  activeProcessesOffset: ACTIVE_PROCESSES_OFFSET,
}

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
        if (closed) return true
        let ok = false
        try {
          ok = k32.symbols.TerminateJobObject(handle, 1) !== 0
        } finally {
          closed = true
          k32.symbols.CloseHandle(handle)
        }
        // The return value is the whole point: a caller that treats a failed
        // syscall as "definitely dead" is making exactly the claim this module
        // exists to make trustworthy. (Closing the last handle of a
        // KILL_ON_JOB_CLOSE job very likely kills the tree anyway — but
        // "likely" is not the answer being asked for.)
        return ok
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

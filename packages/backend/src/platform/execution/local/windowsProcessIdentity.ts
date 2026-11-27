// RFC-625: a PID names a slot; the creation FILETIME names its current incarnation.
import { dlopen, ptr, type Pointer } from 'bun:ffi'

export type WindowsProcessIdentity =
  | { readonly state: 'running'; readonly creationTime: string }
  | { readonly state: 'dead' }
  | { readonly state: 'unknown' }

export function isWindowsCreationTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9]\d{0,19}$/.test(value) &&
    BigInt(value) <= 0xffffffffffffffffn
  )
}

/** Small syscall boundary, also used to exercise all handle cleanup branches. */
type WindowsProcessHandle = Pointer
export interface WindowsProcessIdentityApi {
  open(pid: number): WindowsProcessHandle | null
  lastError(): number
  wait(handle: WindowsProcessHandle): number
  creationTime(handle: WindowsProcessHandle): string | null
  close(handle: WindowsProcessHandle): void
}

let nativeApi: WindowsProcessIdentityApi | null | undefined
function loadApi(): WindowsProcessIdentityApi | null {
  if (process.platform !== 'win32') return null
  if (nativeApi !== undefined) return nativeApi
  try {
    const { symbols } = dlopen('kernel32.dll', {
      OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'ptr' },
      GetLastError: { args: [], returns: 'u32' },
      WaitForSingleObject: { args: ['ptr', 'u32'], returns: 'u32' },
      GetProcessTimes: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
      CloseHandle: { args: ['ptr'], returns: 'i32' },
    })
    nativeApi = {
      // QUERY_LIMITED_INFORMATION | SYNCHRONIZE; all queries use this one handle.
      open: (pid) => symbols.OpenProcess(0x1000 | 0x100000, 0, pid),
      lastError: () => symbols.GetLastError(),
      wait: (handle) => symbols.WaitForSingleObject(handle, 0),
      creationTime(handle) {
        const times = new Uint8Array(32)
        if (
          !symbols.GetProcessTimes(
            handle,
            ptr(times),
            ptr(times, 8),
            ptr(times, 16),
            ptr(times, 24),
          )
        )
          return null
        return new DataView(times.buffer).getBigUint64(0, true).toString()
      },
      close: (handle) => {
        symbols.CloseHandle(handle)
      },
    }
  } catch {
    nativeApi = null
  }
  return nativeApi
}

/** Unknown is not evidence that an owner exited. No floating-point FILETIME conversion. */
export function readWindowsProcessIdentity(
  pid: number,
  api: WindowsProcessIdentityApi | null = loadApi(),
): WindowsProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff || !api)
    return { state: 'unknown' }
  let handle: WindowsProcessHandle | null = null
  try {
    handle = api.open(pid)
    // ERROR_INVALID_PARAMETER is the documented absent-PID result. Other failures are unknown.
    if (!handle) return { state: api.lastError() === 87 ? 'dead' : 'unknown' }
    const wait = api.wait(handle)
    if (wait === 0) return { state: 'dead' }
    if (wait !== 258) return { state: 'unknown' } // WAIT_TIMEOUT means still running.
    const creationTime = api.creationTime(handle)
    if (!isWindowsCreationTime(creationTime)) return { state: 'unknown' }
    // A process can exit during GetProcessTimes; retain the same handle for the final check.
    const after = api.wait(handle)
    if (after === 0) return { state: 'dead' }
    return after === 258 ? { state: 'running', creationTime } : { state: 'unknown' }
  } catch {
    return { state: 'unknown' }
  } finally {
    if (handle) {
      try {
        api?.close(handle)
      } catch {
        /* The query outcome must not become an exception. */
      }
    }
  }
}

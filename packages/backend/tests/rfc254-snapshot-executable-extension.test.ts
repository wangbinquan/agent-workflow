// RFC-254 T39 — a byte-frozen runtime-binary snapshot must be OS-executable
// after it is copied. On Windows a file runs only if its extension is one
// CreateProcess / PATHEXT recognizes; several callers hand `snapshotRuntimeBinary`
// an extensionless basename (`claude-sealed`, the rfc135 status probe's
// `opencode`), so the copy landed inert and the verified launch — and the
// `--version` probe — failed on a file it had just written.
//
// `snapshotExecutableExtension` is the pure decision that fixes it. This locks
// its four cases with the platform INJECTED, so both branches run on any host
// (the copy path itself keys off `process.platform`, so a pure oracle is the
// only way to exercise win32 from POSIX CI — the repo's standard shape).
//
// The load-bearing subtlety is case 3: the verified opencode/system/mcp paths
// ALREADY pre-suffix their snapshot basename via EXECUTABLE_SUFFIX_FOR_HOST
// (`opencode.exe`), so appending again would both double the suffix AND break
// the `snapshotPath === input.binaryPath` admission guard in verifiedPlanCore.
// The rule must return '' there. If this case regresses, the whole verified
// OpenCode launch fails closed on Windows.

import { describe, expect, test } from 'bun:test'
import { snapshotExecutableExtension } from '../src/services/runtime/binarySnapshot'

describe('RFC-254 T39 — snapshotExecutableExtension', () => {
  test('POSIX is always a no-op, whatever the source extension', () => {
    expect(snapshotExecutableExtension('/run/bin/claude-sealed', '/usr/bin/claude', 'linux')).toBe(
      '',
    )
    expect(snapshotExecutableExtension('/run/bin/opencode', '/opt/opencode.exe', 'darwin')).toBe('')
    // A source that happens to have an extension on POSIX still adds nothing —
    // the 0500 mode is what makes the copy executable there.
    expect(snapshotExecutableExtension('/run/seal/oc', '/opt/oc.bin', 'linux')).toBe('')
  })

  test('win32 appends the resolved source extension when the caller path lacks it', () => {
    expect(
      snapshotExecutableExtension('C:\\run\\bin\\claude-sealed', 'C:\\tools\\claude.exe', 'win32'),
    ).toBe('.exe')
    expect(
      snapshotExecutableExtension('C:\\run\\seal\\opencode', 'C:\\npm\\opencode.cmd', 'win32'),
    ).toBe('.cmd')
  })

  test('win32 does NOT double the extension when the caller already pre-suffixed', () => {
    // This is the verified opencode/system/mcp path: `opencode${.exe}` in, source
    // `.exe` — must return '' so the copy stays at the exact admission-guarded
    // path (`opencode.exe`), not `opencode.exe.exe`.
    expect(
      snapshotExecutableExtension(
        'C:\\seal\\bin\\opencode.exe',
        'C:\\tools\\opencode.exe',
        'win32',
      ),
    ).toBe('')
    // Case-insensitive: Windows extensions do not care about case.
    expect(
      snapshotExecutableExtension(
        'C:\\seal\\bin\\opencode.EXE',
        'C:\\tools\\opencode.exe',
        'win32',
      ),
    ).toBe('')
  })

  test('win32 with an extensionless source adds nothing (nothing to carry)', () => {
    expect(
      snapshotExecutableExtension('C:\\run\\bin\\sealed', 'C:\\tools\\opencode', 'win32'),
    ).toBe('')
  })

  test('the appended extension is always source-derived, never caller-derived', () => {
    // Even if the caller path carries a DIFFERENT extension, the result is the
    // SOURCE extension (or '' when already matching) — the copy must match the
    // bytes it holds, and the value never comes from the destination string.
    expect(
      snapshotExecutableExtension('C:\\run\\bin\\sealed.txt', 'C:\\tools\\claude.exe', 'win32'),
    ).toBe('.exe')
  })
})

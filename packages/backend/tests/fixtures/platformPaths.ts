// RFC-254 T32 — host-canonical absolute paths for test fixtures.
//
// WHY THIS EXISTS
// ---------------
// The Windows survey's largest tractable failure cluster was fixtures that
// hardcode a POSIX absolute path — `binaryPath: '/opt/my-cc'` and friends —
// against validators that demand a CANONICAL absolute path.
//
// The trap is that such a path is not simply "rejected as relative" on Windows.
// `path.isAbsolute('/opt/my-cc')` is TRUE there (a leading slash is absolute,
// rooted on the current drive), so the value sails past the absolute check and
// then fails the canonical round-trip, because `path.resolve('/opt/my-cc')`
// returns `D:\opt\my-cc`. The diagnosis the test reports is
// `binaryPath must be a canonical absolute path (no "..", ".", or trailing
// slash)` — which points at traversal, the one thing that is NOT wrong.
//
// Worth stating plainly: the PRODUCTION validator is correct. A real Windows
// path (`D:\tools\opencode.exe`) round-trips and is accepted. Only the POSIX
// fixture is unportable, so the fix belongs in the fixtures.

import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * A canonical absolute path for `name`, spelled the way THIS host spells one.
 *
 * `resolve` is what makes it canonical by construction: whatever it returns
 * round-trips through the validators, on every platform, without the fixture
 * having to know which platform it is on.
 *
 * The path is NOT created — these fixtures configure a binary rather than run
 * one, and the validators are deliberately filesystem-free (existence stays
 * with the advisory probe).
 */
export function canonicalBinaryPath(name: string): string {
  return resolve(tmpdir(), 'aw-fixture-bin', name)
}

// TWO CLASSES THIS HELPER MUST NOT REPLACE — both were converted by a
// too-broad sweep and caught by their own tests:
//
//   1. Paths that must name a REAL executable. `runtime-smoke` points at
//      `/bin/echo` precisely because it exists and emits nothing parseable;
//      a canonical path to a file that is not there proves something else.
//   2. Deliberately MALFORMED literals in negative cases —
//      `/usr/bin/../bin/opencode`, `/usr/local/bin/`, an embedded newline.
//      Canonicalizing the input of a test that asserts non-canonical input is
//      rejected removes the only thing it was testing.
//
// The rule: convert a path that is INCIDENTALLY absolute, never one whose
// exact spelling is the subject.

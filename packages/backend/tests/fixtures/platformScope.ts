// RFC-254 T32 — the one predicate that scopes a test to the platforms whose
// containment provider it is actually about.
//
// WHY A NAMED CONSTANT AND NOT `process.platform === 'win32'` INLINE
// ------------------------------------------------------------------
// Spelled inline, every use looks like "this test does not work on Windows",
// which invites the next person to fix it. What is true is narrower and more
// specific: the SUBJECT of these assertions is a POSIX containment provider —
// a root-owned bwrap namespace trial, a Linux process GROUP and its PGID
// signal ladder, the bwrap bind/mask projection, the macOS Seatbelt profile
// text. RFC-254 v1 ships Windows with NO containment provider at all, so on
// that host those code paths are not merely untested; there is nothing there
// to test.
//
// WHAT KEEPS THIS FROM BECOMING A SILENT HOLE
// -------------------------------------------
// Two things, deliberately:
//
//   1. The unreachability is asserted POSITIVELY and platform-independently by
//      `rfc205-sandbox-probe-wrap.test.ts` ('unsupported platform → null
//      mechanism, unavailable'), which injects 'win32' and therefore runs on
//      every host including POSIX. Windows is not simply missing coverage — it
//      has an assertion that says the provider is absent.
//   2. Every use is counted in `test-suite-policy.test.ts`'s
//      `ALLOWED_SKIP_COUNTS` against an exact number. Guarding one more test is
//      an edit someone has to make on purpose, in a file whose whole job is to
//      make that edit visible.
//
// The rule for reaching for this: the assertion's subject must be the POSIX
// mechanism itself. A test that merely HAPPENS to fail on Windows — a fixture
// with a POSIX path, a `.sh` fake binary, a separator in a key — is a
// portability defect in the test, and those get fixed rather than scoped.
export const NO_POSIX_CONTAINMENT = process.platform === 'win32'

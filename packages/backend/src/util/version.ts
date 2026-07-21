// RFC-213 impl-gate P1-3 (2026-07-22) — a REAL binary version for the
// pre-migration restore gate.
//
// `currentAppVersion()` used to be `process.env.AGENT_WORKFLOW_VERSION ?? '0.0.0'`
// with nothing ever setting the env var — so every two release binaries compared
// equal ('0.0.0' === '0.0.0') and RestorePreMigrationBinaryError was dead code:
// the exact "forward-roll a pre-migration backup onto the binary whose migration
// broke it" scenario the gate exists for sailed straight through.
//
// The single-binary build (scripts/build-binary.ts) injects `AW_BUILD_VERSION`
// via `bun build --define` (git describe --tags). Dev runs have no injection and
// fall back to '0.0.0-dev' — which still differs from any released identity, so
// the gate errs on the safe (refusing) side across dev/release boundaries.

declare const AW_BUILD_VERSION: string | undefined

export const BUILD_VERSION: string | null =
  typeof AW_BUILD_VERSION === 'string' ? AW_BUILD_VERSION : null

/** Effective binary identity: explicit env override → build-time tag → dev. */
export function appVersion(): string {
  return process.env.AGENT_WORKFLOW_VERSION ?? BUILD_VERSION ?? '0.0.0-dev'
}

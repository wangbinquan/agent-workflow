// RFC-143 PR-4 — spawn argv head selection, moved out of runner.ts so BOTH
// drivers can import it without a module-init cycle (runner ← driver would loop
// through runtime/index). runner.ts re-exports it for existing import sites
// (runtime-spawn-head.test.ts locks the contract).
//
// Leaf module: zero imports.

/**
 * RFC-112: pick the spawn argv head. A custom runtime's frozen binary
 * (`runtimeBinary`) overrides the protocol default; null / empty (the built-in
 * runtimes) falls back to the RFC-111 head (`opencodeCmd` for opencode, the
 * test-only `runtimeCmd` for claude), so a built-in spawn is byte-for-byte
 * unchanged. Exported so the golden head-selection contract can be unit-locked.
 */
export function pickRuntimeHead(
  runtimeBinary: string | null | undefined,
  fallback: string[] | undefined,
): string[] | undefined {
  return runtimeBinary != null && runtimeBinary.length > 0 ? [runtimeBinary] : fallback
}

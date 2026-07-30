// RFC-227 — version-neutral OpenCode executable identity.
//
// RFC-237 moved the implementation VERBATIM to ../binarySnapshot.ts (it never
// contained opencode-specific logic — only naming), so the claude-code sealed
// path can reuse the exact same TOCTOU fence. This module keeps every legacy
// name as an alias: same classes (instanceof-identical), same error code, same
// behavior — every RFC-224/227 import site is byte-compatible.
//
// The administrator-selected runtime binary is local trusted code. The
// platform resolves it once, hashes it, copies those exact bytes into a
// private per-run seal, re-hashes the copy, and executes only that copy.
// SHA-256 is a byte/TOCTOU identity fence; it is not a vendor signature and is
// never compared with a static OpenCode-version allowlist.

export {
  RUNTIME_BINARY_SNAPSHOT_ERROR_CODE as RUNTIME_OPENCODE_BINARY_ERROR_CODE,
  RuntimeBinarySnapshotError as RuntimeOpencodeBinaryError,
  inspectRuntimeBinary as inspectRuntimeOpencodeBinary,
  snapshotRuntimeBinary as snapshotRuntimeOpencodeBinary,
  verifyRuntimeBinarySnapshot as verifyRuntimeOpencodeSnapshot,
} from '../binarySnapshot'
export type {
  RuntimeBinarySnapshotFailureReason as RuntimeOpencodeBinaryFailureReason,
  RuntimeBinaryIdentity as RuntimeOpencodeBinaryIdentity,
  SnapshotRuntimeBinaryOptions as SnapshotRuntimeOpencodeBinaryOptions,
  RuntimeBinaryDependencies as RuntimeOpencodeBinaryDependencies,
} from '../binarySnapshot'

import { withRuntimeBinarySnapshot, type RuntimeBinaryIdentity } from '../binarySnapshot'

export const OPENCODE_BINARY_IDENTITY_CODEC = 1 as const

/** Diagnostic helper: execute only a temporary byte-frozen snapshot. */
export async function withRuntimeOpencodeSnapshot<T>(
  command: readonly string[],
  callback: (snapshotPath: string, identity: RuntimeBinaryIdentity) => Promise<T>,
): Promise<T> {
  return withRuntimeBinarySnapshot(command, callback, 'opencode')
}

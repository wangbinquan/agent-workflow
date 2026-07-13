// RFC-170 (T2) — opaque composite precondition token for skill version writes.
//
// A plain `contentVersion` is NOT a reusable-safe generation identifier: after a
// same-name delete/recreate the version counter restarts from a low value, so a
// stale `{name, version}` re-matches the NEW resource (ABA). And a metadata-only
// change (description) never advances the content version, so a stale
// ZIP-overwrite decision would still pass. The token therefore binds THREE
// components:
//   - skillId       — the immutable row identity (defeats delete/recreate ABA);
//   - contentVersion — the files-tree/version-snapshot generation;
//   - metaRevision   — a monotonic counter over form/ZIP-writable meta fields
//                      (currently `description`); NOT bumped by content saves,
//                      ACL/owner/path changes (design §1).
//
// The token is OPAQUE to the frontend (it only round-trips the string). The
// backend encodes on read and CAS-checks on every version write: a missing
// token is 400 (fail-closed), any component mismatch is 409.
//
// Encoding = base64url of a compact JSON triple. Kept deliberately simple and
// self-describing so decode can validate shape/types and reject garbage. Pure —
// no IO. Unit-tested in tests/skill-token.test.ts.

export interface SkillPreconditionToken {
  skillId: string
  contentVersion: number
  metaRevision: number
}

export function encodeSkillToken(t: SkillPreconditionToken): string {
  const payload = JSON.stringify([t.skillId, t.contentVersion, t.metaRevision])
  return Buffer.from(payload, 'utf-8').toString('base64url')
}

/** Decode an opaque token. Returns null on any malformed / wrong-shape input
 *  (the caller maps null → 400 fail-closed). */
export function decodeSkillToken(s: string): SkillPreconditionToken | null {
  let arr: unknown
  try {
    arr = JSON.parse(Buffer.from(s, 'base64url').toString('utf-8'))
  } catch {
    return null
  }
  if (!Array.isArray(arr) || arr.length !== 3) return null
  const [skillId, contentVersion, metaRevision] = arr
  if (typeof skillId !== 'string' || skillId.length === 0) return null
  if (!Number.isInteger(contentVersion) || contentVersion < 0) return null
  if (!Number.isInteger(metaRevision) || metaRevision < 0) return null
  return { skillId, contentVersion, metaRevision }
}

/**
 * RFC-170 F3 — decode a token into `commitSkillVersion`'s expected-fence fields so
 * the version-write funnel OCC-checks it in the bump tx. `undefined` in →
 * `undefined` out (no fence requested, backward compat); a malformed token →
 * `null` (the caller maps that to a 400 fail-closed); a valid token → the fields.
 * Pure — keeps this codec module IO/error-free; both skill.ts and skillVersion.ts
 * (which cannot import each other) share it without a module cycle.
 */
export function tokenToVersionFence(
  expectedToken: string | undefined,
):
  | { expectedSkillId: string; expectedVersion: number; expectedMetaRevision: number }
  | null
  | undefined {
  if (expectedToken === undefined) return undefined
  const decoded = decodeSkillToken(expectedToken)
  if (decoded === null) return null
  return {
    expectedSkillId: decoded.skillId,
    expectedVersion: decoded.contentVersion,
    expectedMetaRevision: decoded.metaRevision,
  }
}

/** Exact-match CAS predicate: does the caller-supplied token still describe the
 *  current authoritative row? All three components must match. */
export function skillTokenMatches(
  token: SkillPreconditionToken,
  current: SkillPreconditionToken,
): boolean {
  return (
    token.skillId === current.skillId &&
    token.contentVersion === current.contentVersion &&
    token.metaRevision === current.metaRevision
  )
}

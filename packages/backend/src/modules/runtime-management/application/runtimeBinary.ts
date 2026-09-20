import { isAbsolute, resolve as resolvePath } from 'node:path'
import { ValidationError } from '@/util/errors'

/**
 * A runtime binary is one executable path or PATH token, not a shell command
 * with embedded arguments. Extra arguments have their own typed field. Reject
 * ambiguous values at the admin write boundary instead of letting spawn parse
 * them differently later.
 *
 * Deliberately filesystem-free: existence/executability stays with the
 * advisory probe (`POST /api/runtimes/probe`). A stat here would also block the
 * legitimate "configure before install" flow.
 */
export function validateBinaryPath(binaryPath: string | null | undefined): string | null {
  if (binaryPath === null || binaryPath === undefined) return null
  const p = binaryPath.trim()
  if (p.length === 0) return null
  const reject = (detail: string): never => {
    throw new ValidationError('runtime-binary-invalid', `binaryPath must be ${detail}`)
  }
  if (/[\n\r]/.test(p) || p.includes('\0')) reject('a single path')
  if (isAbsolute(p)) {
    // Canonical form only: '/usr/bin/../bin/oc' and '/usr/bin/' resolve
    // elsewhere at exec time than they read here.
    if (resolvePath(p) !== p) reject('a canonical absolute path (no "..", ".", or trailing slash)')
    return p
  }
  // Not absolute → the only other accepted form is a bare PATH token. A
  // relative fragment is cwd-dependent and the seal rejects it outright.
  if (p.includes('/') || p.includes('\\')) {
    reject('an absolute path or a bare PATH token (relative paths are cwd-dependent)')
  }
  if (/\s/.test(p)) reject('a single path without arguments')
  return p
}

// RFC-222 (C 线, D5) — type-to-confirm for destructive resource deletes.
//
// Every resource/task DELETE requires the caller to echo the resource's CURRENT
// name in a `{ confirm }` body. The check is server-side and authoritative: a
// front-end that skips the dialog, or a script that omits confirm, is rejected.
// The comparison base is the freshly-loaded row's name (or the :name path param
// where that IS the identity), so a rename between opening the dialog and
// submitting yields a mismatch — the change is caught, never silently applied.
//
// Ordering (N-5, all 7 endpoints): existence 404 → authz 403/builtin → THIS
// confirm 422 → business gate (refs refusal / OCC / status) → delete.
//
// Errors use ValidationError (422) to match the codebase's input-validation
// convention (invalid-json et al.); the front-end keys on the `code`.

import type { Context } from 'hono'
import { ValidationError } from '@/util/errors'

/**
 * Read a DELETE request body tolerantly. Empty / absent body → `{}` (so the
 * confirm check below produces a clean `delete-confirm-required`, never a raw
 * JSON-parse 500 for the legacy no-body callers). Malformed JSON keeps the
 * existing `invalid-json` semantics.
 */
export async function readDeleteBody(c: Context): Promise<unknown> {
  const raw = await c.req.text()
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ValidationError('invalid-json', 'request body is not valid JSON')
  }
}

/**
 * Enforce type-to-confirm. `expectedName` is the resource's current name (path
 * param for :name routes; the loaded row's `name` column for :id routes).
 * Comparison is EXACT (case-sensitive, no trim/normalization — the front-end
 * trims the user's input before sending). `resourceType` rides the error meta
 * for the UI; `expected` is never echoed back (the caller could already read
 * the name, but we don't spell it out for them).
 */
export function assertDeleteConfirm(
  body: unknown,
  expectedName: string,
  resourceType: string,
): void {
  const confirm =
    typeof body === 'object' && body !== null && 'confirm' in body
      ? (body as { confirm: unknown }).confirm
      : undefined
  if (typeof confirm !== 'string') {
    throw new ValidationError(
      'delete-confirm-required',
      `type the ${resourceType} name to confirm deletion`,
      { resourceType },
    )
  }
  if (confirm !== expectedName) {
    throw new ValidationError(
      'delete-confirm-mismatch',
      `the entered name does not match this ${resourceType}`,
      { resourceType },
    )
  }
}

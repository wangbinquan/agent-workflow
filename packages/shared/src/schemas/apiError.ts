// RFC-054 W1-2 — canonical API error envelope shape.
//
// Mirrors `packages/backend/src/platform/errors/domainErrors.ts ErrorPayload` exactly. Lives
// in shared so the contract-suite test (and any future frontend type-safe
// fetch wrapper) can validate error responses without duplicating the
// shape definition.
//
// Wire shape: `{ ok: false, code: <string>, message: <string>, details?: ... }`.

import { z } from 'zod'

export const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

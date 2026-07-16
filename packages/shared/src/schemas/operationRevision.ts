// RFC-201 — shared wire primitive for exact saved-resource operation fences.

import { z } from 'zod'

/** Lowercase SHA-256 hex over a domain-separated canonical projection. */
export const OperationConfigHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export type OperationConfigHash = z.infer<typeof OperationConfigHashSchema>

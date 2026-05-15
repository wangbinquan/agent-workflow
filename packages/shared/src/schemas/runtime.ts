// RFC-001: shared types for the /api/runtime/* endpoints.
//
// These shape the response of:
//   GET /api/runtime/opencode  — live `opencode --version` probe
//   GET /api/runtime/models    — `opencode models --verbose` parsed list
//
// Backend writes them; frontend reads them. Kept in shared so both sides
// type-check against the same shape.

import { z } from 'zod'

export const RuntimeOpencodeStatusSchema = z.object({
  binary: z.string(),
  version: z.string().nullable(),
  compatible: z.boolean(),
  minVersion: z.string(),
})
export type RuntimeOpencodeStatus = z.infer<typeof RuntimeOpencodeStatusSchema>

export const OpencodeModelSchema = z.object({
  id: z.string(),
  provider: z.string(),
  modelID: z.string(),
  name: z.string().optional(),
})
export type OpencodeModel = z.infer<typeof OpencodeModelSchema>

export const RuntimeModelsResponseSchema = z.object({
  binary: z.string(),
  models: z.array(OpencodeModelSchema),
  cached: z.boolean(),
})
export type RuntimeModelsResponse = z.infer<typeof RuntimeModelsResponseSchema>

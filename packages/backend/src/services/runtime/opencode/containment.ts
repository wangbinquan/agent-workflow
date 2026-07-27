// RFC-227 — OpenCode containment admission is capability based, not OS-name
// based. Built-in Linux/macOS providers are adapted from RFC-205, while future
// providers can supply an opaque child plan and outer renderer through the
// generic SandboxProvider extension seam.

import { z } from 'zod'
import type {
  ContainmentCapabilityStrength,
  ContainmentRuntimeProjection,
  PreparedContainmentPlan,
  SandboxProvider,
} from '@/services/sandbox'
import {
  PreparedChildContainmentPlanSchema,
  type PreparedChildContainmentPlan,
} from '@/services/sandbox/containmentContract'
export type CapabilityStrength = ContainmentCapabilityStrength
export type RuntimeContainmentReceipt = ContainmentRuntimeProjection

export type RuntimeChildProviderPlan = PreparedChildContainmentPlan

export const RuntimeContainmentReceiptSchema = z
  .object({
    providerId: z.string().min(1).max(128).nullable(),
    mode: z.enum(['enforce', 'warn', 'off']),
    capabilities: z.record(z.string().min(1).max(128), z.enum(['strong', 'best-effort', 'absent'])),
    available: z.boolean(),
    degradedReasons: z.array(z.string().min(1).max(256)).max(32),
  })
  .strict()

export const RuntimeChildProviderPlanSchema = PreparedChildContainmentPlanSchema

export interface RuntimeContainmentAdmission {
  sandbox: SandboxProvider
  receipt: RuntimeContainmentReceipt
  childProvider: RuntimeChildProviderPlan
}

/** Adapt the generic daemon admission to the verified OpenCode manifest seam. */
export function runtimeContainmentAdmissionFromPrepared(
  prepared: PreparedContainmentPlan,
): RuntimeContainmentAdmission {
  return {
    sandbox: prepared.sandbox,
    receipt: RuntimeContainmentReceiptSchema.parse(prepared.runtimeReceipt),
    childProvider: RuntimeChildProviderPlanSchema.parse(prepared.childProvider),
  }
}

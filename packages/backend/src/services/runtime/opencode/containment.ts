// RFC-227 — OpenCode containment admission is capability based, not OS-name
// based. Built-in Linux/macOS providers are adapted from RFC-205, while future
// providers can supply an opaque child plan and outer renderer through the
// generic SandboxProvider extension seam.

import { z } from 'zod'
import type { SandboxProvider } from '@/services/sandbox'
import { JsonValueSchema, type JsonValue } from './directApiSchemas'
import { executionIdentityFailure } from './failure'

export const RUNTIME_CONTAINMENT_BASELINE = [
  'platformHomeIsolation',
  'immutableArtifactView',
  'modelChildNetworkDeny',
] as const

export const RUNTIME_CONTAINMENT_CAPABILITIES = [
  ...RUNTIME_CONTAINMENT_BASELINE,
  'descendantLifetimeBound',
] as const

export type RuntimeContainmentCapability = (typeof RUNTIME_CONTAINMENT_CAPABILITIES)[number]
export type CapabilityStrength = 'strong' | 'best-effort' | 'absent'

export interface RuntimeContainmentReceipt {
  providerId: string | null
  mode: 'enforce' | 'warn' | 'off'
  capabilities: Record<string, CapabilityStrength>
  available: boolean
  degradedReasons: string[]
}

export interface RuntimeChildProviderPlan {
  providerId: string
  config: JsonValue
}

export const RuntimeContainmentReceiptSchema = z
  .object({
    providerId: z.string().min(1).max(128).nullable(),
    mode: z.enum(['enforce', 'warn', 'off']),
    capabilities: z.record(z.string().min(1).max(128), z.enum(['strong', 'best-effort', 'absent'])),
    available: z.boolean(),
    degradedReasons: z.array(z.string().min(1).max(256)).max(32),
  })
  .strict()

export const RuntimeChildProviderPlanSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    config: JsonValueSchema,
  })
  .strict()

export interface RuntimeContainmentAdmission {
  sandbox: SandboxProvider
  receipt: RuntimeContainmentReceipt
  childProvider: RuntimeChildProviderPlan
}

interface EvaluatedRuntimeContainment {
  receipt: RuntimeContainmentReceipt
  candidate: RuntimeChildProviderPlan | null
}

function absentCapabilities(): Record<RuntimeContainmentCapability, CapabilityStrength> {
  return {
    platformHomeIsolation: 'absent',
    immutableArtifactView: 'absent',
    modelChildNetworkDeny: 'absent',
    descendantLifetimeBound: 'absent',
  }
}

function builtInCapabilities(
  mechanism: string | null,
  available: boolean,
): Record<RuntimeContainmentCapability, CapabilityStrength> | null {
  if (mechanism !== 'bwrap' && mechanism !== 'seatbelt') return null
  if (!available) return absentCapabilities()
  return {
    platformHomeIsolation: 'strong',
    immutableArtifactView: 'strong',
    modelChildNetworkDeny: 'strong',
    descendantLifetimeBound: mechanism === 'bwrap' ? 'strong' : 'best-effort',
  }
}

function normalizedCapabilities(
  sandbox: SandboxProvider,
): Readonly<Record<string, CapabilityStrength>> {
  const builtIn = builtInCapabilities(sandbox.status.mechanism, sandbox.status.available)
  if (builtIn !== null) return builtIn
  const supplied = sandbox.runtimeContainment?.capabilities ?? {}
  const normalized: Record<string, CapabilityStrength> = { ...supplied }
  for (const capability of RUNTIME_CONTAINMENT_CAPABILITIES) {
    normalized[capability] ??= 'absent'
  }
  return normalized
}

function providerIdOf(sandbox: SandboxProvider): string | null {
  if (sandbox.runtimeContainment !== undefined) {
    return sandbox.runtimeContainment.providerId
  }
  if (sandbox.status.mechanism === 'bwrap') return 'linux-bwrap'
  if (sandbox.status.mechanism === 'seatbelt') return 'macos-seatbelt'
  return sandbox.status.mechanism
}

function activeChildProvider(
  sandbox: SandboxProvider,
  providerId: string | null,
): RuntimeChildProviderPlan | null {
  if (providerId === 'linux-bwrap') {
    // `buildVerifiedOpencodePlan` replaces this placeholder only after the
    // root-owned namespace capability probe returns a canonical executable.
    return { providerId, config: {} }
  }
  if (providerId === 'macos-seatbelt') {
    return {
      providerId,
      config: { sandboxExecPath: '/usr/bin/sandbox-exec' },
    }
  }
  if (
    providerId !== null &&
    sandbox.runtimeContainment?.providerId === providerId &&
    sandbox.runtimeContainment.childProviderPlan !== undefined &&
    sandbox.wrapCommand !== undefined
  ) {
    const parsed = JsonValueSchema.safeParse(sandbox.runtimeContainment.childProviderPlan)
    if (parsed.success) return { providerId, config: parsed.data }
  }
  return null
}

function evaluateRuntimeContainment(sandbox: SandboxProvider): EvaluatedRuntimeContainment {
  const providerId = providerIdOf(sandbox)
  const capabilities = normalizedCapabilities(sandbox)
  const reasons: string[] = []
  if (!sandbox.status.available) reasons.push('containment-provider-unavailable')
  for (const capability of RUNTIME_CONTAINMENT_BASELINE) {
    const strength = capabilities[capability] ?? 'absent'
    if (strength !== 'strong') {
      reasons.push(`containment-capability-${capability}-${strength}`)
    }
  }

  const candidate =
    sandbox.mode === 'off' || !sandbox.status.available
      ? null
      : activeChildProvider(sandbox, providerId)
  if (sandbox.mode !== 'off' && sandbox.status.available && candidate === null) {
    reasons.push('containment-child-provider-plan-unavailable')
  }
  return {
    receipt: RuntimeContainmentReceiptSchema.parse({
      providerId,
      mode: sandbox.mode,
      capabilities,
      available: sandbox.status.available,
      degradedReasons: [...new Set(reasons)].sort(),
    }),
    candidate,
  }
}

/** Read-only status projection; unlike admission it never throws. */
export function inspectRuntimeContainment(
  sandbox: SandboxProvider | null,
): RuntimeContainmentReceipt | null {
  return sandbox === null ? null : evaluateRuntimeContainment(sandbox).receipt
}

/**
 * Resolve the admission truth table. No platform string or version string is
 * consulted: enforce requires strong baseline capabilities, warn degrades, and
 * off intentionally selects the uncontained child launcher.
 */
export function admitRuntimeContainment(
  sandbox: SandboxProvider | null,
): RuntimeContainmentAdmission {
  if (sandbox === null) {
    return executionIdentityFailure('execution-identity-sandbox-required')
  }

  const evaluated = evaluateRuntimeContainment(sandbox)
  if (sandbox.mode === 'enforce' && evaluated.receipt.degradedReasons.length > 0) {
    return executionIdentityFailure('execution-identity-sandbox-required')
  }

  const childProvider =
    sandbox.mode === 'off' ||
    evaluated.receipt.degradedReasons.length > 0 ||
    evaluated.candidate === null
      ? { providerId: 'none', config: {} }
      : evaluated.candidate

  return {
    sandbox,
    receipt: evaluated.receipt,
    childProvider: RuntimeChildProviderPlanSchema.parse(childProvider),
  }
}

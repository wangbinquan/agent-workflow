import { z } from 'zod'
import type {
  RuntimeManagementEffects,
  RuntimeManagementConfigPort,
  RuntimeDiagnosticTarget,
  RuntimeSmokeRequest,
} from '../application/ports/runtimeManagement'
import type { HostedRuntimeCapabilities, RuntimeKind } from '../public/types'
import type { McpRuntimeTestReconciliationParticipant } from '@/modules/resource-catalog/public/participants'
import { sha256Hex } from '@/util/hash'

export const HostedRuntimeCapabilitiesSchema = z.object({
  protocolVersion: z.literal(3),
  releaseId: z.string(),
  runtimeImageUpgrade: z.literal(1).optional(),
  taskRuntimeImageVersionId: z.string().nullable().optional(),
  agentProfiles: z.array(
    z.object({
      agentProfileId: z.guid({ error: 'Invalid uuid' }).meta({ format: 'uuid' }),
      computeProfileId: z.guid({ error: 'Invalid uuid' }).meta({ format: 'uuid' }),
      profileRevision: z.number().int().positive(),
      capabilities: z.object({
        events: z.boolean(),
        mcp: z.boolean(),
        usage: z.enum(['none', 'final', 'incremental']),
        startupInventoryVersion: z.literal(1).optional(),
        nativeConfigVersion: z.literal(1).optional(),
        nativeModelMappingVersion: z.literal(1).optional(),
        materialObjectsVersion: z.literal(1).optional(),
      }),
    }),
  ),
})
export type { HostedRuntimeCapabilities }
export interface HostedRuntimeProfileMapping {
  readonly protocol: RuntimeKind
  readonly model: string | null
  readonly agentProfileId: string
}

/** A platform profile's tested capability is status evidence; the API does
 * not report a binary version. A smoke probe still makes a real Agent turn. */
export function createCrewStationRuntimeManagementEffects(input: {
  readonly profiles: readonly HostedRuntimeProfileMapping[]
  readonly initialCapabilities: HostedRuntimeCapabilities
  readonly capabilities: () => Promise<HostedRuntimeCapabilities>
  readonly configuration: RuntimeManagementConfigPort
  readonly runtimeTests: McpRuntimeTestReconciliationParticipant
  readonly smoke: (
    request: RuntimeSmokeRequest,
  ) => ReturnType<RuntimeManagementEffects['drivers']['smoke']>
}): RuntimeManagementEffects {
  let current = input.initialCapabilities
  const targets = new WeakMap<
    RuntimeDiagnosticTarget,
    { protocol: RuntimeKind; model?: string | null }
  >()
  const matching = (protocol: RuntimeKind, model?: string | null) =>
    input.profiles.filter(
      (p) => p.protocol === protocol && (model === undefined || p.model === model),
    )
  const capture = (protocol: RuntimeKind, binary: string | null, model?: string | null) => {
    const label = `cs-agent:${protocol}`
    if (binary && binary !== label)
      throw new Error('hosted-runtime-binary-is-managed-by-crewstation')
    const mappings = matching(protocol, model)
    const frozen = mappings.map((p) => ({
      ...p,
      profile: current.agentProfiles.find((c) => c.agentProfileId === p.agentProfileId) ?? null,
    }))
    const receiptKey = `${label}:${sha256Hex(JSON.stringify([current.releaseId, frozen]))}`
    const target: RuntimeDiagnosticTarget = {
      protocol,
      label,
      receiptKey,
      runtimeBinding: { owner: 'runtime-management', reference: receiptKey, version: null },
    }
    targets.set(target, { protocol, ...(model === undefined ? {} : { model }) })
    return target
  }
  const requireTarget = (protocol: RuntimeKind, target: RuntimeDiagnosticTarget) => {
    const value = targets.get(target)
    if (!value || value.protocol !== protocol)
      throw new Error('hosted-runtime-target-owner-mismatch')
    return value
  }
  const assertOptions: RuntimeManagementEffects['drivers']['assertSpawnCapabilities'] = (
    _protocol,
    request,
  ) => {
    if (request.extraArgs?.length)
      throw new Error('hosted-runtime-extra-arguments-require-native-materials')
    if (request.isSandbox)
      throw new Error('hosted-runtime-sandbox-option-requires-native-materials')
  }
  return {
    config: input.configuration,
    protocols: ['opencode', 'claude-code'],
    statusProbeTimeoutMs: 5000,
    beforeProbeReceipt() {},
    drivers: {
      capture: (request) => capture(request.protocol(), request.binaryPath),
      resolveTarget: (row) => capture(row.protocol, row.binaryPath, row.model),
      async probeStatus(protocol, target) {
        const selected = requireTarget(protocol, target)
        current = HostedRuntimeCapabilitiesSchema.parse(await input.capabilities())
        const configured = matching(protocol, selected.model)
        const compatible =
          configured.length > 0 &&
          configured.every((profile) =>
            current.agentProfiles.some(
              (c) => c.agentProfileId === profile.agentProfileId && c.capabilities.events,
            ),
          )
        return { binary: target.label, version: null, ran: configured.length > 0, compatible }
      },
      async smoke(request) {
        requireTarget(request.protocol, request.target)
        assertOptions(request.protocol, request)
        const mapping = matching(request.protocol, request.model || null)
        if (mapping.length !== 1) throw new Error('hosted-runtime-profile-unmapped')
        current = HostedRuntimeCapabilitiesSchema.parse(await input.capabilities())
        if (
          !current.agentProfiles.some(
            (p) => p.agentProfileId === mapping[0]!.agentProfileId && p.capabilities.events,
          )
        )
          throw new Error('hosted-runtime-profile-not-tested')
        return input.smoke(request)
      },
      // `smoke` refreshes the capabilities before it runs. A target captured
      // from the copy read at the previous refresh then no longer matches the
      // receipt computed afterwards, and the first probe after any platform
      // profile change failed as `runtime-probe-stale`.
      async prepareProbe() {
        current = HostedRuntimeCapabilitiesSchema.parse(await input.capabilities())
      },
      assertSpawnCapabilities: assertOptions,
    },
    modelDiscovery: {
      resolveTarget: (protocol, binary) => capture(protocol, binary),
      async list(protocol, target) {
        requireTarget(protocol, target)
        current = HostedRuntimeCapabilitiesSchema.parse(await input.capabilities())
        return {
          binary: target.label,
          cached: false,
          models: matching(protocol)
            .filter(
              (p) =>
                p.model !== null &&
                current.agentProfiles.some(
                  (c) => c.agentProfileId === p.agentProfileId && c.capabilities.events,
                ),
            )
            .map((p) => ({ id: p.model! })),
        }
      },
    },
    tests: {
      eligible: (row) =>
        matching(row.protocol, row.model).some((p) =>
          current.agentProfiles.some(
            (c) =>
              c.agentProfileId === p.agentProfileId && c.capabilities.events && c.capabilities.mcp,
          ),
        ),
      reconcile: () => input.runtimeTests.reconcileDurableIntents(),
    },
  }
}

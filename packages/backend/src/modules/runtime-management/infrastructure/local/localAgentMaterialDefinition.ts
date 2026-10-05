import type { RuntimeKind } from '../../public/types'
import type { AgentInvocationProtocol } from '../../application/ports/agentProtocol'
import type { AgentMaterialEvidenceCapabilities } from '../../application/ports/agentMaterial'
import {
  createLocalAgentMaterialCompiler,
  type NativeAgentMaterialContents,
  type NativeAgentMaterialFixture,
} from './agentMaterialCompiler'
import type { NativeAgentMaterialEvidenceHooks } from './agentMaterialEvidence'
import { bindNativeAgentProtocol } from './agentProtocol'
import { buildOpencodeNativeMaterial } from './opencodeAgentMaterial'
import { buildClaudeNativeMaterial } from './claudeAgentMaterial'
import { getRuntimeDriver } from '@/services/runtime'

/** A native bootstrap selects this definition, then opens a compiler for one
 * owner-bound content scope. The compiler calls the existing material body;
 * the legacy buildSpawn compilation facade is never called again. */
export interface LocalAgentMaterialDefinition {
  readonly protocol: AgentInvocationProtocol
  readonly evidenceHooks: NativeAgentMaterialEvidenceHooks
  createCompiler(
    contents: NativeAgentMaterialContents,
    fixture?: NativeAgentMaterialFixture,
  ): ReturnType<typeof createLocalAgentMaterialCompiler>
}

// The native root owns the complete protocol-to-material pairing.
const nativeMaterialBuilders: ReadonlyMap<RuntimeKind, typeof buildOpencodeNativeMaterial> =
  new Map<RuntimeKind, typeof buildOpencodeNativeMaterial>([
    ['opencode', buildOpencodeNativeMaterial],
    ['claude-code', buildClaudeNativeMaterial],
  ])

export function selectLocalAgentMaterialDefinition(
  kind: RuntimeKind,
): LocalAgentMaterialDefinition {
  const buildNative = nativeMaterialBuilders.get(kind)
  if (buildNative === undefined) {
    throw new Error(
      `unknown runtime kind '${String(kind)}' — no registered driver (RFC-282 决策 13)`,
    )
  }
  const driver = getRuntimeDriver(kind)
  return {
    protocol: bindNativeAgentProtocol(driver),
    evidenceHooks: driver,
    createCompiler(contents, fixture) {
      const evidenceCapabilities: AgentMaterialEvidenceCapabilities = {
        usageNormalizer: driver.prepareUsageNormalizer !== undefined,
        nativeUsageCapture: driver.prepareNativeUsageCapture !== undefined,
        spanCapture: driver.prepareSpanCapture !== undefined,
        sessionCapture: true,
        inventory: driver.readInventory !== undefined,
        finalEvents: driver.drainFinalEvents !== undefined,
        liveCapture: driver.startLiveCapture !== undefined,
        sessionSinkCapture: driver.captureSessionsToSink !== undefined,
      }
      return createLocalAgentMaterialCompiler({
        protocol: kind,
        contents,
        buildNative,
        evidenceCapabilities,
        ...(fixture === undefined ? {} : { fixture }),
      })
    },
  }
}

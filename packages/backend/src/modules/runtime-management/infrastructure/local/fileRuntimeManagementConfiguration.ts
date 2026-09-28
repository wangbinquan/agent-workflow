// RFC-370: standalone runtime management configuration; preserve the shared
// file reader and probe-receipt queue used by configuration updates.
import { loadConfig } from '@/platform/configuration/fileConfiguration'
import type { RuntimeManagementConfigPort } from '../../application/ports/runtimeManagement'
import { withRuntimeProbeConfigFence } from '../runtimeProbeFence'

export function createFileRuntimeManagementConfiguration(
  configPath: string,
): RuntimeManagementConfigPort {
  return Object.freeze({
    current() {
      const cfg = loadConfig(configPath)
      return {
        defaultRuntime: cfg.defaultRuntime,
        memoryDistillRuntime: cfg.memoryDistillRuntime,
        commitPushRuntime: cfg.commitPushRuntime,
        mergeAgentRuntime: cfg.mergeAgentRuntime,
        intentBuilderRuntime: cfg.intentBuilderRuntime,
        changeNarrativeRuntime: cfg.changeNarrativeRuntime,
        opencodePath: cfg.opencodePath,
        claudeCodePath: cfg.claudeCodePath,
      }
    },
    withProbeReceiptFence: <T>(action: () => Promise<T>) =>
      withRuntimeProbeConfigFence(configPath, action),
  })
}

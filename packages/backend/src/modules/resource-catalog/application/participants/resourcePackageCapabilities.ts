import type {
  AgentPackageMutation,
  CapabilityTemplatePackageMutation,
  McpPackageMutation,
  PluginPackageMutation,
  PreparedAgentPackageMutation,
  PreparedCapabilityTemplatePackageMutation,
  PreparedMcpPackageMutation,
  PreparedPluginPackageMutation,
  PreparedSkillPackageMutation,
  PreparedWorkflowPackageMutation,
  PreparedWorkgroupPackageMutation,
  SkillPackageMutation,
  WorkflowPackageMutation,
  WorkgroupPackageMutation,
} from '../../public/types'

const trustedResourcePackageCapabilities = new WeakSet<object>()

function prepared<T extends object>(value: T): T {
  const capability = Object.freeze(value)
  trustedResourcePackageCapabilities.add(capability)
  return capability
}

export function createPreparedAgentPackageMutation(
  mutation: AgentPackageMutation,
): PreparedAgentPackageMutation {
  return prepared({ mutation }) as unknown as PreparedAgentPackageMutation
}

export function createPreparedSkillPackageMutation(
  mutation: SkillPackageMutation,
): PreparedSkillPackageMutation {
  return prepared({ mutation }) as unknown as PreparedSkillPackageMutation
}

export function createPreparedMcpPackageMutation(
  mutation: McpPackageMutation,
): PreparedMcpPackageMutation {
  return prepared({ mutation }) as unknown as PreparedMcpPackageMutation
}

export function createPreparedPluginPackageMutation(
  mutation: PluginPackageMutation,
): PreparedPluginPackageMutation {
  return prepared({ mutation }) as unknown as PreparedPluginPackageMutation
}

export function createPreparedWorkflowPackageMutation(
  mutation: WorkflowPackageMutation,
): PreparedWorkflowPackageMutation {
  return prepared({ mutation }) as unknown as PreparedWorkflowPackageMutation
}

export function createPreparedWorkgroupPackageMutation(
  mutation: WorkgroupPackageMutation,
): PreparedWorkgroupPackageMutation {
  return prepared({ mutation }) as unknown as PreparedWorkgroupPackageMutation
}

export function createPreparedCapabilityTemplatePackageMutation(
  mutation: CapabilityTemplatePackageMutation,
): PreparedCapabilityTemplatePackageMutation {
  return prepared({ mutation }) as unknown as PreparedCapabilityTemplatePackageMutation
}

export function assertTrustedResourcePackageCapability(capability: object): void {
  if (!trustedResourcePackageCapabilities.has(capability)) {
    throw new Error('untrusted-resource-package-capability')
  }
}

// RFC-359（apply 引擎合一，plan §5dy）—— 这里原本还有一整族 `*InTx` 参与者构造器与
// `createResourcePackageApplyTx` / `createResourcePackageApplyScenarioTx`，它们是**通用 bundle
// 引擎**那条同步事务链的装配面，随该引擎退役（生产零调用方）。统一 apply 引擎用的是上面这七个
// `createPrepared*` 加 `assertTrustedResourcePackageCapability`，事务句柄由编排层直接交给各臂。

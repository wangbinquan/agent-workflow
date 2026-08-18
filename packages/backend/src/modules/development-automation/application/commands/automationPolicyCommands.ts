// RFC-310 T15 —— automation policy 的 application 命令面（port 见
// digitalEmployeeCommands.ts；publish 校验在 store 内调用 domain 的
// validatePolicyForPublish，无跨资源 lookup）。

import type {
  AutomationPolicyStorePort,
  DevelopmentResourceSummary,
} from './digitalEmployeeCommands'

export interface AutomationPolicyCommands {
  createPolicy(input: {
    name: string
    ownerUserId: string | null
    draft: unknown
  }): Promise<DevelopmentResourceSummary>
  revisePolicyDraft(input: { id: string; draft: unknown }): Promise<void>
  publishPolicy(input: {
    id: string
    publishedBy: string | null
  }): Promise<{ revision: number; contentDigest: string }>
}

export function createAutomationPolicyCommands(deps: {
  store: AutomationPolicyStorePort
}): AutomationPolicyCommands {
  return {
    createPolicy: (input) => deps.store.create(input),
    revisePolicyDraft: (input) => deps.store.reviseDraft(input),
    publishPolicy: (input) => deps.store.publish(input),
  }
}

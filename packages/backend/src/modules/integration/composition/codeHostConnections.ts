// RFC-450 — 代码平台连接与调用的装配：连接服务、两个路由合同（出站 fetch 测试注入点在这里绑定）、
// MR 绑定用的请求实现，以及 task-execution 代码平台节点与启动恢复用的请求实现。

import { testCodeHostConnection } from '../application/codeHostConnectionTest'
import type { CodeHostRequests, FetchLike } from '../application/ports/codeHostCalls'
import type {
  CodeHostConnectionAdministration,
  CodeHostConnectionProbe,
  CodeHostConnectionsService,
} from '../application/ports/codeHostConnections'
import { resolveProjectFallback } from '../domain/codeHostProjectFallback'
import { executeCodeHostCall } from '../infrastructure/codeHost/call'
import {
  createCodeHostConnectionsService,
  probeCodeHostConnection,
} from '../infrastructure/codeHost/connections'
import { probeCodeHostMutation } from '../infrastructure/codeHost/recoveryProbe'

export function composeCodeHostConnections(
  deps: Parameters<typeof createCodeHostConnectionsService>[0],
): CodeHostConnectionsService {
  return createCodeHostConnectionsService(deps)
}

export function composeCodeHostConnectionProbe(
  input: { readonly fetchImpl?: FetchLike } = {},
): CodeHostConnectionProbe {
  const probe: CodeHostConnectionProbe = {
    probe: (credential) =>
      probeCodeHostConnection({
        ...credential,
        ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
      }),
  }
  return Object.freeze(probe)
}

export function composeCodeHostConnectionAdministration(input: {
  readonly service: CodeHostConnectionsService
  readonly fetchImpl?: FetchLike
}): CodeHostConnectionAdministration {
  const { service } = input
  const probe = composeCodeHostConnectionProbe(
    input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl },
  )
  const administration: CodeHostConnectionAdministration = {
    list: () => service.list(),
    upsert: (provider, upsert) => service.upsert(provider, upsert),
    remove: (provider, confirmation) => service.remove(provider, confirmation),
    test: (provider, draft) => testCodeHostConnection({ service, probe }, provider, draft),
  }
  return Object.freeze(administration)
}

/** MR 用例的绑定带上它（交付 provider 由装配根注入）。 */
export const codeHostRequests: CodeHostRequests = Object.freeze({
  executeCodeHostCall,
  probeCodeHostConnection,
})

/** task-execution 代码平台节点（`RunTaskOptions.codeHostRequests`）与启动恢复探测用。 */
export const codeHostNodeRequests = Object.freeze({
  executeCodeHostCall,
  resolveProjectFallback,
  probeCodeHostMutation,
})

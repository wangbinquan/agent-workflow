// RFC-450 — 代码平台调用的数据形状与请求端口（形状原样取自 services/codeHost/call 与 connections）。
// 执行器、连接探测在 infrastructure/codeHost；MR 用例经绑定里的 `requests` 使用它们，实现由装配注入。

import type {
  CodeHostCustomRequest,
  CodeHostFailureCode,
  CodeHostProvider,
  CodeHostTemplateContext,
  CodeHostTestResult,
  RepositoryTransportMappingV1,
} from '@agent-workflow/shared'
import type { CodeHostSendAttemptObserver } from '@/modules/task-execution/public/participants'
import type { ProjectFallback } from '../../domain/codeHostProjectFallback'

/** 解封后的凭据；只在进程内流转。 */
export interface ResolvedCodeHostConnection {
  provider: CodeHostProvider
  baseUrl: string
  repositoryUrlPrefixes: string[]
  /** Present on persisted connections; optional keeps legacy test/adaptor stubs source-compatible. */
  transportMappings?: RepositoryTransportMappingV1[]
  /** Present on persisted connections; optional keeps legacy test/adaptor stubs source-compatible. */
  connectionGeneration?: string
  token: string
  /** false is an explicit, GitLab-only TLS trust downgrade. */
  rejectUnauthorized: boolean
}

export type FetchLike = (url: string, init?: BunFetchRequestInit) => Promise<Response>

/** 节点定义里与执行相关的那一份（scheduler 从 WorkflowNode 读出后传进来）。 */
export interface CodeHostCallSpec {
  provider: CodeHostProvider
  action: string
  params: Readonly<Record<string, string>>
  request?: CodeHostCustomRequest
  allowDestructive?: boolean
  timeoutMs?: number
}

export interface CodeHostCallDeps {
  connection: ResolvedCodeHostConnection
  ctx: CodeHostTemplateContext
  projectFallback: ProjectFallback
  fetchImpl?: FetchLike
  maxResponseBytes?: number
  /** 测试用：让退避不真的睡。 */
  sleep?: (ms: number) => Promise<void>
  /** RFC-328: record every real mutation send before the transport sees it. */
  attemptObserver?: CodeHostSendAttemptObserver
}

export type CodeHostCallOutcome =
  | { ok: true; status: number; body: string; truncated: boolean; method: string; pathname: string }
  | { ok: false; code: CodeHostFailureCode; summary: string; message: string }

/** 「测试连接」探测的输入（原 `probeCodeHostConnection` 的内联参数）。 */
export interface CodeHostConnectionProbeInput {
  provider: CodeHostProvider
  baseUrl: string
  token: string
  rejectUnauthorized?: boolean
  fetchImpl?: FetchLike
  timeoutMs?: number
}

/** MR 用例经绑定使用的代码平台请求。 */
export interface CodeHostRequests {
  executeCodeHostCall(spec: CodeHostCallSpec, deps: CodeHostCallDeps): Promise<CodeHostCallOutcome>
  probeCodeHostConnection(input: CodeHostConnectionProbeInput): Promise<CodeHostTestResult>
}

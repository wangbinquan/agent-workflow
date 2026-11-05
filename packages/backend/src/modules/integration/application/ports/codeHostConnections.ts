// RFC-450 — 代码平台连接的服务合同（形状原样取自 services/codeHost/connections）与两个路由合同。

import type {
  CodeHostConnectionWire,
  CodeHostProvider,
  CodeHostTestResult,
  RepositoryTransportMappingV1,
} from '@agent-workflow/shared'
import type { ResolvedCodeHostConnection } from './codeHostCalls'

export interface CodeHostConnectionUpsertInput {
  baseUrl: string
  /** GitLab-only; omission preserves the stored collection. */
  repositoryUrlPrefixes?: readonly string[]
  /** Both providers; omission preserves the stored collection. */
  transportMappings?: readonly RepositoryTransportMappingV1[]
  /** 省略 = 保留原 token（要求该 provider 已有行）。 */
  token?: string
  /** 省略 = 首次为 true、已有行保留；false 只允许 GitLab。 */
  rejectUnauthorized?: boolean
  expectedConnectionGeneration?: string
  confirmCredentialRevocationDigest?: string
  actorUserId?: string | null
}

export interface CodeHostConnectionMutationConfirmation {
  readonly expectedConnectionGeneration?: string
  readonly confirmCredentialRevocationDigest?: string
}

export interface CodeHostConnectionsService {
  /** 供执行器使用：解封后的完整凭据；未配置返回 null。 */
  resolve(provider: CodeHostProvider): Promise<ResolvedCodeHostConnection | null>
  /** 供 API 使用：两家各一行，未配置的也出现（configured:false）。 */
  list(): Promise<CodeHostConnectionWire[]>
  get(provider: CodeHostProvider): Promise<CodeHostConnectionWire>
  upsert(
    provider: CodeHostProvider,
    input: CodeHostConnectionUpsertInput,
  ): Promise<CodeHostConnectionWire>
  remove(
    provider: CodeHostProvider,
    confirmation?: CodeHostConnectionMutationConfirmation,
  ): Promise<boolean>
  recordTest(provider: CodeHostProvider, result: CodeHostTestResult): Promise<void>
}

/** 「测试连接」的草稿值；未传的字段回落到已保存的值。 */
export interface CodeHostConnectionTestDraft {
  readonly baseUrl?: string | undefined
  readonly token?: string | undefined
  readonly rejectUnauthorized?: boolean | undefined
}

/** 一套待探测的凭据。 */
export interface CodeHostConnectionCredential {
  readonly provider: CodeHostProvider
  readonly baseUrl: string
  readonly token: string
  readonly rejectUnauthorized: boolean
}

/** 身份探测；出站 fetch 由装配绑定。 */
export interface CodeHostConnectionProbe {
  probe(credential: CodeHostConnectionCredential): Promise<CodeHostTestResult>
}

/** 管理端路由用的连接管理面：列表、保存、删除、测试。 */
export interface CodeHostConnectionAdministration {
  list(): Promise<CodeHostConnectionWire[]>
  upsert(
    provider: CodeHostProvider,
    input: CodeHostConnectionUpsertInput,
  ): Promise<CodeHostConnectionWire>
  remove(
    provider: CodeHostProvider,
    confirmation?: CodeHostConnectionMutationConfirmation,
  ): Promise<boolean>
  test(provider: CodeHostProvider, draft: CodeHostConnectionTestDraft): Promise<CodeHostTestResult>
}

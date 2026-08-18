export const SYSTEM_MOCK_SERVICES = [
  'control',
  'git',
  'gitlab',
  'github',
  'external',
  'development-requirement', // RFC-310 自建需求系统 mock
  'development-pipeline', // RFC-310 自建流水线门禁 mock（PR-6 T70）
  'oauth',
  'oidc',
  'mcp',
  'npm',
  'pypi',
  'plantuml',
] as const

export type SystemMockService = (typeof SYSTEM_MOCK_SERVICES)[number]

export interface RecordedMockRequest {
  id: number
  at: number
  service: SystemMockService
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  bodyText: string
}

export interface MockFaultPlan {
  /** Number of matching requests affected. Omit for every request until cleared. */
  times?: number
  /** Delay before any headers are written. */
  delayMs?: number
  /** End the socket without an HTTP response. */
  disconnect?: boolean
  status?: number
  headers?: Record<string, string>
  body?: string
  /** Send headers and an initial body fragment, then never end the response. */
  stallBody?: boolean
}

export interface MockFaultRule extends MockFaultPlan {
  service: SystemMockService
  /** Exact HTTP method or `*`. */
  method?: string
  /** Path prefix within the mock gateway. */
  pathPrefix?: string
}

export interface SystemMockEndpoints {
  baseUrl: string
  controlUrl: string
  gitBaseUrl: string
  gitlabApiBaseUrl: string
  githubApiBaseUrl: string
  /** Generic script-adapter upstream, for CI/document/issue systems RFCs do not know. */
  externalHttpBaseUrl: string
  /** RFC-310 —— 自建需求系统 mock（adapter CLI 的上游）。 */
  developmentRequirementBaseUrl: string
  /** RFC-310 —— 自建流水线门禁 mock（pipeline adapter CLI 的上游）。 */
  developmentPipelineBaseUrl: string
  oauthIssuerUrl: string
  oidcIssuerUrl: string
  mcpStreamableUrl: string
  mcpSseUrl: string
  npmRegistryUrl: string
  pypiIndexUrl: string
  plantumlEndpoint: string
}

export interface MockOidcUser {
  sub: string
  email: string
  name: string
  preferredUsername?: string
  emailVerified?: boolean
  claims?: Record<string, unknown>
}

export type MockOidcTokenMode = 'id-token' | 'access-token-only'

export interface MockCodeHostUser {
  id?: number
  username: string
  name?: string
}

export type MockCodeHostMergeRequestState = 'opened' | 'closed' | 'merged'
export type MockCodeHostPipelineState = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface MockCodeHostIssueSeed {
  number?: number
  title?: string
  body?: string
  state?: 'opened' | 'closed'
  labels?: string[]
  author?: MockCodeHostUser
}

export interface MockCodeHostPipelineJob {
  id?: number
  name: string
  state?: MockCodeHostPipelineState
  log?: string
}

export interface MockCodeHostPipelineSeed {
  id?: number
  mrNumber?: number
  state?: MockCodeHostPipelineState
  runId?: string
  headSha?: string
  jobs?: MockCodeHostPipelineJob[]
}

export interface MockCodeHostSeed {
  provider: 'gitlab' | 'github'
  projectPath: string
  title?: string
  number?: number
  defaultBranch?: string
  headBranch?: string
  /** Null removes a file from the head revision. Embedded NUL bytes model binary files. */
  baseFiles?: Record<string, string>
  headFiles?: Record<string, string | null>
  /** Force a provider omission for a changed path without fabricating a different Git tree. */
  diffOmissions?: Record<string, 'binary' | 'too-large'>
  mrAuthor?: MockCodeHostUser
  /** Metadata-only fork source. The target's special MR ref remains fetchable. */
  sourceProjectPath?: string
  issues?: MockCodeHostIssueSeed[]
  pipelines?: MockCodeHostPipelineSeed[]
}

export interface MockCodeHostComment {
  id: string
  threadId: string | null
  body: string
  author: MockCodeHostUser
  createdAt: string
  resolved: boolean
  inReplyToId: string | null
  position: Record<string, unknown> | null
}

export interface MockCodeHostMergeRequest {
  id: number
  number: number
  title: string
  description: string
  state: MockCodeHostMergeRequestState
  sourceProjectPath: string
  sourceBranch: string
  targetBranch: string
  baseSha: string
  headSha: string
  author: MockCodeHostUser
  drafts: MockCodeHostComment[]
  reviewComments: MockCodeHostComment[]
  issueComments: MockCodeHostComment[]
}

export interface MockCodeHostIssue {
  id: number
  number: number
  title: string
  body: string
  state: 'opened' | 'closed'
  labels: string[]
  author: MockCodeHostUser
  comments: MockCodeHostComment[]
}

export interface MockCodeHostPipeline {
  id: number
  mrNumber: number
  state: MockCodeHostPipelineState
  runId: string
  headSha: string
  jobs: Array<Required<Pick<MockCodeHostPipelineJob, 'id' | 'name' | 'state' | 'log'>>>
}

export interface MockCodeHostProject {
  provider: 'gitlab' | 'github'
  projectId: string
  projectPath: string
  number: number
  title: string
  defaultBranch: string
  headBranch: string
  baseSha: string
  headSha: string
  repoHttpUrl: string
  webUrl: string
  mergeRequests: MockCodeHostMergeRequest[]
  issues: MockCodeHostIssue[]
  pipelines: MockCodeHostPipeline[]
}

export type MockCodeHostMutationInput =
  | {
      kind: 'advance-head'
      provider: 'gitlab' | 'github'
      projectPath: string
      number?: number
      files: Record<string, string | null>
      message?: string
      actor?: MockCodeHostUser
    }
  | {
      kind: 'add-review-comment'
      provider: 'gitlab' | 'github'
      projectPath: string
      number?: number
      body: string
      actor?: MockCodeHostUser
      threadId?: string
      inReplyToId?: string
      position?: Record<string, unknown>
    }
  | {
      kind: 'add-issue-comment'
      provider: 'gitlab' | 'github'
      projectPath: string
      number: number
      body: string
      actor?: MockCodeHostUser
    }
  | {
      kind: 'label-issue'
      provider: 'gitlab' | 'github'
      projectPath: string
      number: number
      label: string
    }
  | {
      kind: 'set-mr-state'
      provider: 'gitlab' | 'github'
      projectPath: string
      number?: number
      state: MockCodeHostMergeRequestState
    }
  | {
      kind: 'set-pipeline'
      provider: 'gitlab' | 'github'
      projectPath: string
      pipeline: MockCodeHostPipelineSeed & { mrNumber?: number }
    }

export interface MockWebhookDeliveryInput {
  provider: 'gitlab' | 'github'
  callbackUrl: string
  secret: string
  projectPath: string
  number?: number
  event:
    | 'mr_opened'
    | 'mr_updated'
    | 'mr_closed'
    | 'mr_merged'
    | 'comment_created'
    | 'review_comment_created'
    | 'issue_labeled'
    | 'issue_comment'
    | 'push'
    | 'pipeline_succeeded'
    | 'pipeline_failed'
  body?: string
  actor?: MockCodeHostUser
  label?: string
  labels?: string[]
  threadId?: string
  inReplyToId?: string
  position?: Record<string, unknown>
  pipelineId?: number
  runId?: string
  deliveryId?: string
}

export interface MockHttpResponse {
  status?: number
  headers?: Record<string, string>
  body?: string
  json?: unknown
}

/** A deterministic generic upstream route; responses advance once per match. */
export interface MockHttpRoute {
  id?: string
  method?: string
  path: string
  responses: MockHttpResponse[]
  /** Default true: after the sequence is exhausted, keep returning its last response. */
  repeatLast?: boolean
}

export interface MockHttpRouteSnapshot extends MockHttpRoute {
  id: string
  consumed: number
}

export interface MockPackageFile {
  path: string
  content: string
  mode?: number
}

export interface MockNpmPackage {
  name: string
  version: string
  files?: MockPackageFile[]
  packageJson?: Record<string, unknown>
}

export interface MockPythonPackage {
  name: string
  version: string
  module?: string
  files?: MockPackageFile[]
}

export interface SystemMockSnapshot {
  requests: RecordedMockRequest[]
  faults: MockFaultRule[]
  codeHosts: MockCodeHostProject[]
  externalHttp: MockHttpRouteSnapshot[]
  oidc: {
    tokenMode: MockOidcTokenMode
    users: MockOidcUser[]
  }
  oauth: {
    tokenMode: MockOidcTokenMode
    users: MockOidcUser[]
  }
  packages: {
    npm: Array<{ name: string; version: string }>
    pypi: Array<{ name: string; version: string }>
  }
}

export const SYSTEM_MOCK_SERVICES = [
  'control',
  'git',
  'gitlab',
  'github',
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

export interface MockCodeHostSeed {
  provider: 'gitlab' | 'github'
  projectPath: string
  title?: string
  number?: number
  defaultBranch?: string
  headBranch?: string
  baseFiles?: Record<string, string>
  headFiles?: Record<string, string>
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
}

export interface MockWebhookDeliveryInput {
  provider: 'gitlab' | 'github'
  callbackUrl: string
  secret: string
  projectPath: string
  number: number
  event:
    | 'mr_opened'
    | 'mr_updated'
    | 'mr_closed'
    | 'mr_merged'
    | 'comment_created'
    | 'pipeline_succeeded'
    | 'pipeline_failed'
  body?: string
  deliveryId?: string
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

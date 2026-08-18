import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleCodeHostApi } from './code-host/stateful-http'
import {
  RequirementProviderMock,
  type MockRequirementSeed,
} from './development/requirement-provider'
import { CodeHostStore } from './code-host/stateful-store'
import { SystemMockClient } from './client'
import {
  applyFault,
  headerRecord,
  parseJsonBody,
  queryRecord,
  readRequestBody,
  writeJson,
  writeText,
} from './core/http'
import { FaultRegistry, RequestJournal } from './core/state'
import { ExternalHttpMock } from './external-http/server'
import { handleGitSmartHttp } from './git/http'
import { McpHttpMock } from './mcp/server'
import { createOauthMock } from './oauth/server'
import { OidcMock } from './oidc/server'
import { PackageRegistryMock } from './registry/server'
import { handlePlantuml } from './plantuml/server'
import type {
  MockCodeHostMutationInput,
  MockCodeHostSeed,
  MockFaultRule,
  MockHttpRoute,
  MockNpmPackage,
  MockOidcTokenMode,
  MockOidcUser,
  MockPythonPackage,
  MockWebhookDeliveryInput,
  SystemMockEndpoints,
  SystemMockService,
  SystemMockSnapshot,
} from './types'

export interface StartedSystemMockSuite {
  endpoints: SystemMockEndpoints
  controlToken: string
  client: SystemMockClient
  env: Record<string, string>
  close(): Promise<void>
}

class SystemMockGateway {
  readonly #journal = new RequestJournal()
  readonly #faults = new FaultRegistry()
  readonly #developmentRequirement = new RequirementProviderMock()
  readonly #mcp = new McpHttpMock()
  readonly #server: Server
  readonly #controlToken = randomBytes(24).toString('base64url')
  readonly #suiteRoot: string
  readonly #gitRoot: string
  readonly #codeHosts: CodeHostStore
  readonly #oidc: OidcMock
  readonly #oauth: OidcMock
  readonly #registries: PackageRegistryMock
  readonly #externalHttp = new ExternalHttpMock()
  #baseUrl = ''
  #closed = false

  private constructor(input: {
    suiteRoot: string
    gitRoot: string
    oidc: OidcMock
    oauth: OidcMock
  }) {
    this.#suiteRoot = input.suiteRoot
    this.#gitRoot = input.gitRoot
    this.#oidc = input.oidc
    this.#oauth = input.oauth
    this.#codeHosts = new CodeHostStore({
      suiteRoot: input.suiteRoot,
      gitRoot: input.gitRoot,
      baseUrl: () => this.#baseUrl,
    })
    this.#registries = new PackageRegistryMock(() => this.#baseUrl)
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          writeJson(response, 500, {
            error: 'system-mock-internal-error',
            message: error instanceof Error ? error.message : String(error),
          })
        } else if (!response.writableEnded) {
          response.end()
        }
      })
    })
  }

  static async start(): Promise<SystemMockGateway> {
    const gitRoot = realpathSync(tmpdir())
    const suiteRoot = await mkdtemp(join(gitRoot, 'aw-system-mocks-'))
    let baseUrl = ''
    const oidc = await OidcMock.create(() => `${baseUrl}/oidc`)
    const oauth = await createOauthMock(() => `${baseUrl}/oauth`)
    const gateway = new SystemMockGateway({ suiteRoot, gitRoot, oidc, oauth })
    await new Promise<void>((resolve, reject) => {
      gateway.#server.once('error', reject)
      gateway.#server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = gateway.#server.address()
    if (address === null || typeof address === 'string') throw new Error('unexpected mock address')
    gateway.#baseUrl = `http://127.0.0.1:${address.port}`
    baseUrl = gateway.#baseUrl
    return gateway
  }

  get started(): StartedSystemMockSuite {
    const endpoints = endpointsFor(this.#baseUrl)
    return {
      endpoints,
      controlToken: this.#controlToken,
      client: new SystemMockClient(endpoints.controlUrl, this.#controlToken),
      env: environmentFor(endpoints, this.#controlToken),
      close: async () => await this.close(),
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#mcp.close()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
    await rm(this.#suiteRoot, { recursive: true, force: true })
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.#baseUrl)
    const body = await readRequestBody(request)
    const service = serviceFor(url.pathname)
    this.#journal.add(service, {
      method: request.method ?? 'GET',
      path: url.pathname,
      query: queryRecord(url),
      headers: headerRecord(request.headers),
      bodyText: body.toString('utf8'),
    })
    const fault = this.#faults.take(service, request.method ?? 'GET', url.pathname)
    if (await applyFault(response, request.socket, fault)) return

    if (service === 'control') {
      await this.#handleControl(request, response, url, body)
      return
    }
    if (service === 'git') {
      await handleGitSmartHttp({
        request,
        response,
        url,
        body,
        gitRoot: this.#gitRoot,
        routePrefix: '/git',
      })
      await this.#codeHosts.syncRefsFromGit()
      return
    }
    if (service === 'development-requirement') {
      const stripped = url.pathname.replace(/^\/development-requirement/, '') || '/'
      if (this.#developmentRequirement.handle(request, response, stripped, body.toString('utf8')))
        return
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unknown-route' }))
      return
    }
    if (service === 'gitlab' || service === 'github') {
      await handleCodeHostApi({
        provider: service,
        request,
        response,
        url,
        body,
        store: this.#codeHosts,
      })
      return
    }
    if (service === 'oidc' && (await this.#oidc.handle({ request, response, url, body }))) return
    if (
      service === 'oauth' &&
      (await this.#oauth.handle({ request, response, url, body, routePrefix: '/oauth' }))
    )
      return
    if (service === 'mcp' && (await this.#mcp.handle({ request, response, url, body }))) return
    if (
      service === 'external' &&
      this.#externalHttp.handle({ request, response, url, routePrefix: '/external' })
    )
      return
    if (
      (service === 'npm' || service === 'pypi') &&
      this.#registries.handle({ request, response, url })
    )
      return
    if (service === 'plantuml' && handlePlantuml({ request, response, url, body })) return
    writeText(response, 404, 'system mock route not found')
  }

  async #handleControl(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    body: Buffer,
  ): Promise<void> {
    const path = url.pathname.slice('/__system-mocks'.length) || '/'
    if (path === '/health' && request.method === 'GET') {
      writeJson(response, 200, { ok: true })
      return
    }
    if (request.headers.authorization !== `Bearer ${this.#controlToken}`) {
      writeJson(response, 401, { error: 'invalid-control-token' })
      return
    }
    if (path === '/snapshot' && request.method === 'GET') {
      writeJson(response, 200, this.#snapshot())
      return
    }
    if (path === '/requests' && request.method === 'GET') {
      const service = url.searchParams.get('service') as SystemMockService | null
      writeJson(response, 200, this.#journal.list(service ?? undefined))
      return
    }
    if (path === '/reset' && request.method === 'POST') {
      await this.#codeHosts.reset()
      this.#oidc.reset()
      this.#oauth.reset()
      this.#registries.reset()
      this.#externalHttp.reset()
      this.#developmentRequirement.reset()
      this.#faults.clear()
      this.#journal.clear()
      response.writeHead(204)
      response.end()
      return
    }
    if (path === '/faults' && request.method === 'POST') {
      this.#faults.add(parseJsonBody<MockFaultRule>(body))
      response.writeHead(204)
      response.end()
      return
    }
    if (path === '/faults' && request.method === 'DELETE') {
      this.#faults.clear((url.searchParams.get('service') as SystemMockService | null) ?? undefined)
      response.writeHead(204)
      response.end()
      return
    }
    if (path === '/oidc' && request.method === 'POST') {
      this.#oidc.configure(
        parseJsonBody<{ users?: MockOidcUser[]; tokenMode?: MockOidcTokenMode }>(body),
      )
      response.writeHead(204)
      response.end()
      return
    }
    if (path === '/oauth' && request.method === 'POST') {
      this.#oauth.configure({ users: parseJsonBody<{ users: MockOidcUser[] }>(body).users })
      response.writeHead(204)
      response.end()
      return
    }
    if (path === '/development-requirement/seed' && request.method === 'POST') {
      this.#developmentRequirement.seed(parseJsonBody<MockRequirementSeed>(body))
      response.writeHead(204)
      response.end()
      return
    }
    if (path === '/development-requirement/answers' && request.method === 'POST') {
      const input = parseJsonBody<{
        correlationId: string
        answers: { questionId: string; answer: string }[]
        answerRevision?: string
      }>(body)
      const ok = this.#developmentRequirement.seedAnswers(
        input.correlationId,
        input.answers,
        input.answerRevision,
      )
      writeJson(response, ok ? 200 : 404, { ok })
      return
    }
    if (path === '/development-requirement/question-sets' && request.method === 'GET') {
      writeJson(response, 200, { items: this.#developmentRequirement.listQuestionSets() })
      return
    }
    if (path === '/code-hosts' && request.method === 'POST') {
      writeJson(response, 201, await this.#codeHosts.seed(parseJsonBody<MockCodeHostSeed>(body)))
      return
    }
    if (path === '/code-hosts/mutate' && request.method === 'POST') {
      writeJson(
        response,
        200,
        await this.#codeHosts.mutate(parseJsonBody<MockCodeHostMutationInput>(body)),
      )
      return
    }
    if (path === '/external/routes' && request.method === 'POST') {
      writeJson(response, 201, this.#externalHttp.seed(parseJsonBody<MockHttpRoute>(body)))
      return
    }
    if (path === '/external/routes' && request.method === 'DELETE') {
      this.#externalHttp.reset()
      response.writeHead(204)
      response.end()
      return
    }
    if (path === '/npm' && request.method === 'POST') {
      this.#registries.seedNpm(parseJsonBody<MockNpmPackage>(body))
      response.writeHead(204)
      response.end()
      return
    }
    if (path === '/pypi' && request.method === 'POST') {
      this.#registries.seedPython(parseJsonBody<MockPythonPackage>(body))
      response.writeHead(204)
      response.end()
      return
    }
    if (path === '/webhooks/deliver' && request.method === 'POST') {
      writeJson(
        response,
        200,
        await this.#codeHosts.deliverWebhook(parseJsonBody<MockWebhookDeliveryInput>(body)),
      )
      return
    }
    writeJson(response, 404, { error: 'control-route-not-found' })
  }

  #snapshot(): SystemMockSnapshot {
    return {
      requests: this.#journal.list(),
      faults: this.#faults.list(),
      codeHosts: this.#codeHosts.list(),
      externalHttp: this.#externalHttp.snapshot(),
      oidc: this.#oidc.snapshot(),
      oauth: this.#oauth.snapshot(),
      packages: this.#registries.snapshot(),
    }
  }
}

export async function startSystemMockSuite(): Promise<StartedSystemMockSuite> {
  return (await SystemMockGateway.start()).started
}

function endpointsFor(baseUrl: string): SystemMockEndpoints {
  return {
    baseUrl,
    controlUrl: `${baseUrl}/__system-mocks`,
    gitBaseUrl: `${baseUrl}/git`,
    gitlabApiBaseUrl: `${baseUrl}/gitlab/api/v4`,
    githubApiBaseUrl: `${baseUrl}/github/api/v3`,
    externalHttpBaseUrl: `${baseUrl}/external`,
    developmentRequirementBaseUrl: `${baseUrl}/development-requirement`,
    oauthIssuerUrl: `${baseUrl}/oauth`,
    oidcIssuerUrl: `${baseUrl}/oidc`,
    mcpStreamableUrl: `${baseUrl}/mcp`,
    mcpSseUrl: `${baseUrl}/mcp/sse`,
    npmRegistryUrl: `${baseUrl}/npm/`,
    pypiIndexUrl: `${baseUrl}/pypi/simple/`,
    plantumlEndpoint: `${baseUrl}/renderer`,
  }
}

function environmentFor(
  endpoints: SystemMockEndpoints,
  controlToken: string,
): Record<string, string> {
  return {
    AW_SYSTEM_MOCK_BASE_URL: endpoints.baseUrl,
    AW_SYSTEM_MOCK_CONTROL_URL: endpoints.controlUrl,
    AW_SYSTEM_MOCK_CONTROL_TOKEN: controlToken,
    AW_SYSTEM_MOCK_GIT_BASE_URL: endpoints.gitBaseUrl,
    AW_SYSTEM_MOCK_GITLAB_API_BASE_URL: endpoints.gitlabApiBaseUrl,
    AW_SYSTEM_MOCK_GITHUB_API_BASE_URL: endpoints.githubApiBaseUrl,
    AW_SYSTEM_MOCK_EXTERNAL_HTTP_BASE_URL: endpoints.externalHttpBaseUrl,
    AW_REQUIREMENT_MOCK_URL: endpoints.developmentRequirementBaseUrl,
    AW_SYSTEM_MOCK_OAUTH_ISSUER_URL: endpoints.oauthIssuerUrl,
    AW_SYSTEM_MOCK_OIDC_ISSUER_URL: endpoints.oidcIssuerUrl,
    AW_SYSTEM_MOCK_MCP_URL: endpoints.mcpStreamableUrl,
    AW_SYSTEM_MOCK_NPM_REGISTRY_URL: endpoints.npmRegistryUrl,
    AW_SYSTEM_MOCK_PYPI_INDEX_URL: endpoints.pypiIndexUrl,
    AW_SYSTEM_MOCK_PLANTUML_ENDPOINT: endpoints.plantumlEndpoint,
  }
}

function serviceFor(path: string): SystemMockService {
  if (path.startsWith('/__system-mocks')) return 'control'
  if (path.startsWith('/git/')) return 'git'
  if (path.startsWith('/gitlab/api/v4')) return 'gitlab'
  if (path.startsWith('/github/api/v3')) return 'github'
  if (path.startsWith('/development-requirement')) return 'development-requirement'
  if (path.startsWith('/external')) return 'external'
  if (path.startsWith('/oauth')) return 'oauth'
  if (path.startsWith('/oidc')) return 'oidc'
  if (path.startsWith('/mcp')) return 'mcp'
  if (path.startsWith('/npm')) return 'npm'
  if (path.startsWith('/pypi')) return 'pypi'
  return 'plantuml'
}

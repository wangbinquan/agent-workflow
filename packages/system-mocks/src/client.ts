import type {
  MockCodeHostMutationInput,
  MockCodeHostProject,
  MockCodeHostSeed,
  MockFaultRule,
  MockHttpRoute,
  MockHttpRouteSnapshot,
  MockNpmPackage,
  MockOidcTokenMode,
  MockOidcUser,
  MockPythonPackage,
  MockWebhookDeliveryInput,
  RecordedMockRequest,
  SystemMockService,
  SystemMockSnapshot,
} from './types'

export class SystemMockClient {
  readonly #controlUrl: string
  readonly #token: string

  constructor(controlUrl: string, token: string) {
    this.#controlUrl = controlUrl.replace(/\/$/, '')
    this.#token = token
  }

  async health(): Promise<{ ok: boolean }> {
    return await this.#request('GET', '/health')
  }

  async snapshot(): Promise<SystemMockSnapshot> {
    return await this.#request('GET', '/snapshot')
  }

  async requests(service?: SystemMockService): Promise<RecordedMockRequest[]> {
    const query = service === undefined ? '' : `?service=${encodeURIComponent(service)}`
    return await this.#request('GET', `/requests${query}`)
  }

  async reset(): Promise<void> {
    await this.#request('POST', '/reset')
  }

  async addFault(rule: MockFaultRule): Promise<void> {
    await this.#request('POST', '/faults', rule)
  }

  async clearFaults(service?: SystemMockService): Promise<void> {
    const query = service === undefined ? '' : `?service=${encodeURIComponent(service)}`
    await this.#request('DELETE', `/faults${query}`)
  }

  async configureOidc(input: {
    users?: MockOidcUser[]
    tokenMode?: MockOidcTokenMode
  }): Promise<void> {
    await this.#request('POST', '/oidc', input)
  }

  async configureOauth(input: { users: MockOidcUser[] }): Promise<void> {
    await this.#request('POST', '/oauth', input)
  }

  async seedCodeHost(seed: MockCodeHostSeed): Promise<MockCodeHostProject> {
    return await this.#request('POST', '/code-hosts', seed)
  }

  async mutateCodeHost(input: MockCodeHostMutationInput): Promise<MockCodeHostProject> {
    return await this.#request('POST', '/code-hosts/mutate', input)
  }

  async seedHttpRoute(route: MockHttpRoute): Promise<MockHttpRouteSnapshot> {
    return await this.#request('POST', '/external/routes', route)
  }

  async clearHttpRoutes(): Promise<void> {
    await this.#request('DELETE', '/external/routes')
  }

  async seedNpm(pkg: MockNpmPackage): Promise<void> {
    await this.#request('POST', '/npm', pkg)
  }

  async seedPython(pkg: MockPythonPackage): Promise<void> {
    await this.#request('POST', '/pypi', pkg)
  }

  async deliverWebhook(input: MockWebhookDeliveryInput): Promise<{
    status: number
    body: string
    deliveryId: string
  }> {
    return await this.#request('POST', '/webhooks/deliver', input)
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.#controlUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`system mock control ${method} ${path} returned ${response.status}: ${text}`)
    }
    if (text.length === 0) return undefined as T
    return JSON.parse(text) as T
  }
}

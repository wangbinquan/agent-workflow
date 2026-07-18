// Vitest network boundary: unit/component tests must declare every HTTP
// interaction by replacing globalThis.fetch. A rejected fetch alone is not a
// sufficient guard because React Query can catch it and still let the test go
// green, so every unexpected request is also recorded for the global
// afterEach assertion in setup.ts.

const unexpectedRequests: string[] = []

function requestDescription(input: RequestInfo | URL, init?: RequestInit): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  return `${method} ${url}`
}

export const unexpectedNetworkFetch: typeof fetch = async (input, init) => {
  const request = requestDescription(input, init)
  unexpectedRequests.push(request)
  throw new Error(
    `Unexpected network request in Vitest: ${request}. Mock globalThis.fetch in this test.`,
  )
}

export function installUnexpectedNetworkGuard(): void {
  globalThis.fetch = unexpectedNetworkFetch
}

export function resetUnexpectedNetworkRequests(): void {
  unexpectedRequests.length = 0
}

export function takeUnexpectedNetworkRequests(): string[] {
  return unexpectedRequests.splice(0)
}

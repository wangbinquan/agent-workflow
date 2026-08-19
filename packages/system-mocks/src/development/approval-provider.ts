import type { IncomingMessage, ServerResponse } from 'node:http'

export type MockApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'unavailable'

export interface MockApprovalSeed {
  idempotencyKey: string
  statuses: MockApprovalStatus[]
  /** Persist the request but fail the first submit response. */
  responseLost?: boolean
}

export interface MockApprovalRecord {
  idempotencyKey: string
  correlationRef: string
  externalRequestRef: string
  submittedRevision: string
  submittedAt: string
  statuses: MockApprovalStatus[]
  observationIndex: number
  lostResponseSent: boolean
  intentDigest: string
}

function json(response: ServerResponse, status: number, body: unknown): true {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
  return true
}

function iso(sequence: number): string {
  return new Date(Date.UTC(2026, 7, 19, 0, 0, sequence)).toISOString().replace('Z', '+00:00')
}

export class ApprovalProviderMock {
  readonly #seeds = new Map<string, MockApprovalSeed>()
  readonly #byKey = new Map<string, MockApprovalRecord>()
  readonly #byCorrelation = new Map<string, MockApprovalRecord>()
  #sequence = 0

  seed(input: MockApprovalSeed): void {
    const seed = {
      ...input,
      statuses: input.statuses.length === 0 ? ['pending'] : [...input.statuses],
    } satisfies MockApprovalSeed
    this.#seeds.set(input.idempotencyKey, seed)
    // Tests may discover the platform-derived idempotency key only after the
    // request has been committed. Re-seeding that exact key changes only the
    // provider's future authoritative observations; it never replaces the
    // request identity, receipt or observation ordinal.
    const existing = this.#byKey.get(input.idempotencyKey)
    if (existing !== undefined) existing.statuses = [...seed.statuses]
  }

  reset(): void {
    this.#seeds.clear()
    this.#byKey.clear()
    this.#byCorrelation.clear()
    this.#sequence = 0
  }

  snapshot(): MockApprovalRecord[] {
    return [...this.#byKey.values()].map((row) => ({ ...row, statuses: [...row.statuses] }))
  }

  handle(request: IncomingMessage, response: ServerResponse, pathname: string, body = ''): boolean {
    if (pathname === '/approvals' && request.method === 'POST') {
      let input: { idempotencyKey?: string; intentDigest?: string }
      try {
        input = JSON.parse(body || '{}') as typeof input
      } catch {
        return json(response, 400, { error: 'bad-json' })
      }
      const key = input.idempotencyKey
      if (key === undefined || !/^[0-9a-f]{64}$/.test(input.intentDigest ?? '')) {
        return json(response, 400, { error: 'idempotency-key-and-intent-digest-required' })
      }
      const existing = this.#byKey.get(key)
      if (existing !== undefined) {
        if (existing.intentDigest !== input.intentDigest) {
          return json(response, 409, {
            error: 'idempotency-intent-mismatch',
            idempotencyKey: key,
          })
        }
        return json(response, 200, { ...existing, adopted: true })
      }
      this.#sequence += 1
      const seed = this.#seeds.get(key) ?? { idempotencyKey: key, statuses: ['pending'] as const }
      const row: MockApprovalRecord = {
        idempotencyKey: key,
        correlationRef: `approval-correlation-${this.#sequence}`,
        externalRequestRef: `APP-${String(this.#sequence).padStart(5, '0')}`,
        submittedRevision: `submit-${this.#sequence}`,
        submittedAt: iso(this.#sequence),
        statuses: [...seed.statuses],
        observationIndex: 0,
        lostResponseSent: seed.responseLost === true,
        intentDigest: input.intentDigest!,
      }
      this.#byKey.set(key, row)
      this.#byCorrelation.set(row.correlationRef, row)
      if (seed.responseLost === true) return json(response, 500, { error: 'response-lost' })
      return json(response, 201, { ...row, adopted: false })
    }

    const byKey = /^\/approvals\/by-key\/(.+)$/.exec(pathname)
    if (byKey !== null && request.method === 'GET') {
      const row = this.#byKey.get(decodeURIComponent(byKey[1]!))
      return row === undefined
        ? json(response, 404, { found: false })
        : json(response, 200, { found: true, ...row })
    }

    const observe = /^\/approvals\/([^/]+)$/.exec(pathname)
    if (observe !== null && request.method === 'GET') {
      const row = this.#byCorrelation.get(decodeURIComponent(observe[1]!))
      if (row === undefined) return json(response, 404, { error: 'approval-not-found' })
      const index = Math.min(row.observationIndex, row.statuses.length - 1)
      const status = row.statuses[index] ?? 'pending'
      row.observationIndex += 1
      return json(response, 200, {
        correlationRef: row.correlationRef,
        observedRevision: `observe-${row.observationIndex}`,
        status,
        evidenceRef: status === 'approved' ? `approval-evidence:${row.externalRequestRef}` : null,
        observedAt: iso(this.#sequence + row.observationIndex),
      })
    }
    return false
  }
}

import type { MockFaultRule, RecordedMockRequest, SystemMockService } from '../types'

export class RequestJournal {
  readonly #rows: RecordedMockRequest[] = []
  #nextId = 1

  add(
    service: SystemMockService,
    request: {
      method: string
      path: string
      query: Record<string, string>
      headers: Record<string, string>
      bodyText: string
    },
  ): RecordedMockRequest {
    const row: RecordedMockRequest = {
      id: this.#nextId++,
      at: Date.now(),
      service,
      ...request,
    }
    this.#rows.push(row)
    return row
  }

  list(service?: SystemMockService): RecordedMockRequest[] {
    return this.#rows.filter((row) => service === undefined || row.service === service)
  }

  clear(): void {
    this.#rows.length = 0
    this.#nextId = 1
  }
}

interface StoredFault {
  rule: MockFaultRule
  remaining: number | null
}

export class FaultRegistry {
  readonly #rules: StoredFault[] = []

  add(rule: MockFaultRule): void {
    this.#rules.push({
      rule: structuredClone(rule),
      remaining: rule.times === undefined ? null : Math.max(0, rule.times),
    })
  }

  clear(service?: SystemMockService): void {
    if (service === undefined) {
      this.#rules.length = 0
      return
    }
    for (let i = this.#rules.length - 1; i >= 0; i -= 1) {
      if (this.#rules[i]?.rule.service === service) this.#rules.splice(i, 1)
    }
  }

  list(): MockFaultRule[] {
    return this.#rules.map(({ rule, remaining }) => ({
      ...structuredClone(rule),
      ...(remaining === null ? {} : { times: remaining }),
    }))
  }

  take(service: SystemMockService, method: string, path: string): MockFaultRule | null {
    for (let i = 0; i < this.#rules.length; i += 1) {
      const stored = this.#rules[i]!
      if (stored.rule.service !== service) continue
      if (
        stored.rule.method !== undefined &&
        stored.rule.method !== '*' &&
        stored.rule.method !== method
      )
        continue
      if (stored.rule.pathPrefix !== undefined && !path.startsWith(stored.rule.pathPrefix)) continue
      if (stored.remaining === 0) continue
      if (stored.remaining !== null) {
        stored.remaining -= 1
        if (stored.remaining === 0) this.#rules.splice(i, 1)
      }
      return structuredClone(stored.rule)
    }
    return null
  }
}

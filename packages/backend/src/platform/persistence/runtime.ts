// RFC-349 — narrow provider-neutral runtime mechanism. Business application
// ports never receive a raw client or transaction from this surface.

export interface DatabaseHealth {
  readonly provider: 'sqlite' | 'postgresql'
  readonly generationId: string
  readonly ok: boolean
  readonly latencyMs: number
  readonly databaseFingerprint: string | null
  readonly serverVersion: string | null
  readonly errorCategory: 'closed' | 'configuration' | 'timeout' | 'unavailable' | null
}

export interface DatabaseRuntime {
  readonly provider: 'sqlite' | 'postgresql'
  readonly generationId: string
  health(): Promise<DatabaseHealth>
  close(): Promise<void>
}

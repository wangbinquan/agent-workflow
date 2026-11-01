import type { Json, Row } from './model'

/** Read-only subset of record.ts format v1; no dependency on its CLI/daemon driver. */
export interface RecordedSeedDataset {
  formatVersion: 1
  tag: string
  valueEncoding: 'json-with-tagged-bigint-bytes-timestamp-v1'
  tables: { schema: string; name: string; file: string; rowCount: number; sha256: string }[]
}

/** RFC-398 T8. JSON text stays text: never parse/re-serialize historical payloads. */
export interface ApiExpectation {
  /** HTTP GET on the CURRENT product, authenticated as the fixture administrator. */
  path: string
  /** RFC 6901 pointer to an object or array in the response (empty = response body). */
  at: string
  /** For arrays, exactly one element must match these identity fields. */
  match?: Record<string, Json>
  /** Partial equality; keys are RFC 6901 pointers relative to the selected object. */
  equals: Record<string, Json>
}

export interface SeedRow {
  table: string
  values: Row
  expect?: {
    api?: ApiExpectation[]
    /** Optional row-specific override of the independent mapping oracle. */
    disposition?: 'converted' | 'preserved' | 'archived' | 'metadata' | 'history-only'
    reason?: string
  }
}

export interface SeedFile {
  formatVersion: 1
  epoch: 1 | 2
  after: string
  provenance: {
    kind: 'curated' | 'scenario' | 'derived-draft'
    sources: string[]
    note: string
  }
  rows: SeedRow[]
  /** E2: complete expected rows for tables changed by this native history edge. */
  historyExpectations?: { table: string; rows: Row[] }[]
  content?: {
    path: string
    utf8?: string
    base64?: string
    sha256: string
    /** Offline body for a hosted object ID; the L1 object adapter must bind this ID. */
    objectId?: string
  }[]
  /** Independently authored SQL effects; documentation for S1, never executable SQL. */
  migrationEffects?: {
    table: string
    operation: 'backfill' | 'rename' | 'remove' | 'install-seed' | 'alter'
    rule: string
    source: string
    /** Independently authored relational projection, evaluated before conversion. */
    projection?: {
      sourceTables: string[]
      keyColumns: string[]
      cardinality: string
      values: Record<string, string>
    }
  }[]
}

export interface CoverageExemption {
  id: string
  table: string
  epoch: 1 | 2
  category: 'migration-metadata' | 'retired-never-written'
  status: 'proposed' | 'approved'
  reason: string
  evidence: string[]
  /** Omission applies only to these exact release builds. */
  buildKeys: string[]
  /** Required for approval; old proposed fixtures never authorize an exemption. */
  build?: string
  approvedBy?: 'user'
  approvedAt?: string
}

export interface TableCoverage {
  table: string
  rows: number
  coverage: 'scenario' | 'curated' | 'exempt' | 'missing'
  sources: string[]
  exemption?: string
}

export interface BuildCoverage {
  buildKey: string
  tags: string[]
  epoch: 1 | 2
  tables: TableCoverage[]
  failures: { phase: string; detail: string }[]
}

export interface CoverageLedger {
  formatVersion: 1
  /** Coverage proves data preparation only, never conversion or HTTP acceptance. */
  evidence: 'receipt-and-seed-sqlite-reconstruction'
  exemptions: CoverageExemption[]
  builds: BuildCoverage[]
}

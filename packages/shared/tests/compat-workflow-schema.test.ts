// RFC-054 W3-3 — compatibility matrix for workflow $schema_version values
// 1 / 2 / 3 / 4 / 5. Every historical version MUST still parse cleanly through the
// current `WorkflowDefinitionSchema` so a daemon upgrade never bricks a
// user's existing workflows.
//
// LOCKS:
//   * v1 (M1 baseline) — minimal shape (input / agent-single / output).
//   * v2 (RFC-005) — adds 'review' node kind.
//   * v3 (RFC-023) — adds 'clarify' node kind.
//   * v4 (RFC-056) — adds 'clarify-cross-agent' node kind.
//   * v5 (RFC-292) — canonical `trigger.webhook.<field>` template namespace.
//
// Why fixture files vs. inline literals: the fixture format IS the
// migration contract. Committing the artifacts means future engineers see
// "this is what a real v2 workflow looks like" and can grep the directory
// to find canonical reference examples. The inline alternative would
// silently drift as the schema evolved.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_SCHEMA_VERSIONS,
  WorkflowDefinitionSchema,
} from '../src/schemas/workflow'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(HERE, 'fixtures', 'workflow-schema-versions')

interface Fixture {
  filename: string
  schemaVersion: 1 | 2 | 3 | 4 | 5
  raw: unknown
}

function loadFixtures(): Fixture[] {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'))
  return files.map((filename) => {
    const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, filename), 'utf-8'))
    const v = (raw as { $schema_version: number }).$schema_version
    if (v !== 1 && v !== 2 && v !== 3 && v !== 4 && v !== 5) {
      throw new Error(`fixture ${filename}: unexpected $schema_version ${v}`)
    }
    return { filename, schemaVersion: v as 1 | 2 | 3 | 4 | 5, raw }
  })
}

describe('RFC-054 W3-3 — workflow schema version compatibility matrix', () => {
  const fixtures = loadFixtures()

  test('exactly one fixture per supported schema version exists', () => {
    // Catches dropped / duplicated fixtures. If a future PR adds v4 but
    // forgets the fixture (or vice versa), this fires.
    const seen = new Set<number>()
    for (const f of fixtures) {
      expect(seen.has(f.schemaVersion)).toBe(false)
      seen.add(f.schemaVersion)
    }
    expect([...seen].sort()).toEqual([...WORKFLOW_SCHEMA_VERSIONS])
  })

  for (const v of WORKFLOW_SCHEMA_VERSIONS) {
    test(`v${v} fixture parses through WorkflowDefinitionSchema cleanly`, () => {
      const fixture = fixtures.find((f) => f.schemaVersion === v)
      expect(fixture).toBeDefined()
      const parsed = WorkflowDefinitionSchema.safeParse(fixture!.raw)
      if (!parsed.success) {
        throw new Error(
          `v${v} fixture (${fixture!.filename}) failed schema validation:\n` +
            JSON.stringify(parsed.error.issues, null, 2),
        )
      }
      expect(parsed.data.$schema_version).toBe(v)
    })
  }

  test('v2 fixture surfaces a `review` node kind (RFC-005 invariant)', () => {
    // Locks the rationale for v2's bump — if a future refactor drops
    // the review kind from the schema, v2 fixtures stop parsing.
    const v2 = fixtures.find((f) => f.schemaVersion === 2)!
    const parsed = WorkflowDefinitionSchema.parse(v2.raw)
    const reviewNodes = parsed.nodes.filter((n) => n.kind === 'review')
    expect(reviewNodes.length).toBeGreaterThan(0)
  })

  test('v3 fixture surfaces a `clarify` node kind (RFC-023 invariant)', () => {
    const v3 = fixtures.find((f) => f.schemaVersion === 3)!
    const parsed = WorkflowDefinitionSchema.parse(v3.raw)
    const clarifyNodes = parsed.nodes.filter((n) => n.kind === 'clarify')
    expect(clarifyNodes.length).toBeGreaterThan(0)
  })

  test('v4 fixture surfaces a `clarify-cross-agent` node kind (RFC-056 invariant)', () => {
    const v4 = fixtures.find((f) => f.schemaVersion === 4)!
    const parsed = WorkflowDefinitionSchema.parse(v4.raw)
    const crossNodes = parsed.nodes.filter((n) => n.kind === 'clarify-cross-agent')
    expect(crossNodes.length).toBeGreaterThan(0)
  })

  test('v5 fixture surfaces the canonical webhook trigger namespace (RFC-292 invariant)', () => {
    const v5 = fixtures.find((f) => f.schemaVersion === 5)!
    const parsed = WorkflowDefinitionSchema.parse(v5.raw)
    expect(JSON.stringify(parsed)).toContain('{{trigger.webhook.comment_text}}')
  })

  test('current schema version constant matches highest supported', () => {
    // Sanity that the writer-side constant tracks the union literal in
    // the schema. A PR that bumps to v4 must update both.
    const max = Math.max(...WORKFLOW_SCHEMA_VERSIONS)
    expect(WORKFLOW_SCHEMA_VERSION).toBe(max)
  })
})

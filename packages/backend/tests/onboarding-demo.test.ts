// P-5-10: the frontend onboarding card bundles a demo workflow YAML and
// imports it via POST /api/workflows/import. This test asserts that the
// frontend's fixture string actually parses + imports cleanly against the
// backend's importer — if it ever drifts (schema bumps, renamed kinds), CI
// catches it instead of users hitting a 422 on first click.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import { importWorkflowYaml, previewWorkflowYaml } from '../src/services/workflow.yaml'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const FIXTURE_PATH = resolve(
  import.meta.dir,
  '..',
  '..',
  'frontend',
  'src',
  'fixtures',
  'demo-workflow.ts',
)

function readDemoYaml(): string {
  // The fixture is a TS module exporting a template-literal string; pull the
  // string body out with a regex rather than importing TS into a bun:test
  // suite. The regex must match exactly the export shape used in the file:
  //   export const DEMO_WORKFLOW_YAML = `...`
  const src = readFileSync(FIXTURE_PATH, 'utf8')
  const match = src.match(/export const DEMO_WORKFLOW_YAML\s*=\s*`([\s\S]*?)`\s*\n/)
  if (match === null) {
    throw new Error('Could not extract DEMO_WORKFLOW_YAML from fixture file')
  }
  // Inline interpolations like ${DEMO_WORKFLOW_NAME} — re-resolve them.
  return match[1]!.replace(/\$\{DEMO_WORKFLOW_NAME\}/g, extractName(src))
}

function extractName(src: string): string {
  const m = src.match(/export const DEMO_WORKFLOW_NAME\s*=\s*'([^']+)'/)
  if (m === null) throw new Error('Could not extract DEMO_WORKFLOW_NAME')
  return m[1]!
}

describe('demo workflow YAML fixture', () => {
  test('previewWorkflowYaml accepts the bundled string', () => {
    const yaml = readDemoYaml()
    const preview = previewWorkflowYaml(yaml)
    expect(preview.name.length).toBeGreaterThan(0)
    expect(preview.definition.$schema_version).toBe(1)
    // Sanity-check the three-node shape we promise in the onboarding card.
    const kinds = preview.definition.nodes.map((n) => n.kind).sort()
    expect(kinds).toEqual(['agent-single', 'input', 'output'])
  })

  test('importWorkflowYaml stores it as a brand-new workflow', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const yaml = readDemoYaml()
    const result = await importWorkflowYaml(
      db,
      { yamlText: yaml, mode: 'new' },
      { kind: 'system', reason: 'onboarding-demo-test' },
    )
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') throw new Error('expected a created import result')
    const wf = result.workflow
    expect(wf.id).toBeTruthy()
    expect(wf.name.toLowerCase()).toContain('demo')
    expect(wf.definition.nodes).toHaveLength(3)
    expect(wf.definition.edges).toHaveLength(1)
  })
})

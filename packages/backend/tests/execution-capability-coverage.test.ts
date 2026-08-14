// Mechanical drift gate for the durable execution protection catalog.
//
// Adding a node/input/output/runtime/workgroup/wrapper element must add named
// evidence in the same change. This does not pretend the infinite Cartesian
// product is enumerable: finite registries and the high-risk runtime/wrapper
// products are exhaustive; other dimensions use representative pairwise and
// state/fault/recovery coverage documented in e2e/CAPABILITY_COVERAGE.md.

import {
  NODE_KIND,
  OUTPUT_KIND_UI,
  WORKFLOW_INPUT_KIND,
  WORKGROUP_MODES,
  WRAPPER_NODE_KINDS,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RUNTIME_KINDS } from '../src/services/runtime'
import {
  EXECUTION_CAPABILITY_COVERAGE,
  RUNTIME_SCENARIOS,
  type CoverageEvidence,
  type CoverageItem,
} from './fixtures/execution-capability-coverage'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const REQUIRED_ORCHESTRATION_SPINES = [
  'memory-distill-approve-inject',
  'webhook-ingress-delivery-dedup',
  'webhook-to-agent-prompt',
  'webhook-to-code-host-action',
  'webhook-launch-workflow-agent-workgroup',
  'webhook-runtime-failure-lineage',
  'webhook-mr-terminal-runtime-recovery',
  'intent-create-review-commit-provenance',
  'human-gate-daemon-replacement',
  'child-workflow-execution',
  'child-workgroup-execution',
] as const

function exactUniverse(actual: readonly string[], expected: readonly string[]): void {
  expect([...new Set(actual)].sort()).toEqual([...expected].sort())
  expect(actual).toHaveLength(new Set(actual).size)
}

function allEvidence(): CoverageEvidence[] {
  const itemGroups: readonly (readonly CoverageItem[])[] = [
    EXECUTION_CAPABILITY_COVERAGE.nodeKinds,
    EXECUTION_CAPABILITY_COVERAGE.inputKinds,
    EXECUTION_CAPABILITY_COVERAGE.outputShapes,
    EXECUTION_CAPABILITY_COVERAGE.workgroupModes,
    EXECUTION_CAPABILITY_COVERAGE.workgroupRuntimePairs,
    EXECUTION_CAPABILITY_COVERAGE.runtimeKinds,
    EXECUTION_CAPABILITY_COVERAGE.runtimeScenarioPairs,
    EXECUTION_CAPABILITY_COVERAGE.wrapperCompositions,
    EXECUTION_CAPABILITY_COVERAGE.liveRuntimeKinds,
    EXECUTION_CAPABILITY_COVERAGE.orchestrationSpines,
    EXECUTION_CAPABILITY_COVERAGE.crossCuttingCapabilities,
  ]
  return itemGroups.flatMap((items) => items.flatMap((item) => item.evidence))
}

describe('execution capability coverage cannot drift behind registries', () => {
  test('every workflow node, input, output shape, workgroup mode and runtime is cataloged', () => {
    exactUniverse(
      EXECUTION_CAPABILITY_COVERAGE.nodeKinds.map((item) => item.id),
      NODE_KIND,
    )
    exactUniverse(
      EXECUTION_CAPABILITY_COVERAGE.inputKinds.map((item) => item.id),
      WORKFLOW_INPUT_KIND,
    )
    exactUniverse(
      EXECUTION_CAPABILITY_COVERAGE.outputShapes.map((item) => item.id),
      [...OUTPUT_KIND_UI.map((item) => item.id), 'list'],
    )
    exactUniverse(
      EXECUTION_CAPABILITY_COVERAGE.workgroupModes.map((item) => item.id),
      WORKGROUP_MODES,
    )
    exactUniverse(
      EXECUTION_CAPABILITY_COVERAGE.runtimeKinds.map((item) => item.id),
      RUNTIME_KINDS,
    )
    exactUniverse(
      EXECUTION_CAPABILITY_COVERAGE.liveRuntimeKinds.map((item) => item.id),
      RUNTIME_KINDS,
    )
  })

  test('runtime × lifecycle/fault matrix is exhaustive for every registered driver', () => {
    const expected = RUNTIME_KINDS.flatMap((runtime) =>
      RUNTIME_SCENARIOS.map((scenario) => `${runtime}::${scenario}`),
    )
    exactUniverse(
      EXECUTION_CAPABILITY_COVERAGE.runtimeScenarioPairs.map((item) => item.id),
      expected,
    )
  })

  test('runtime × workgroup mode matrix is exhaustive for every registered driver', () => {
    const expected = RUNTIME_KINDS.flatMap((runtime) =>
      WORKGROUP_MODES.map((mode) => `${runtime}::${mode}`),
    )
    exactUniverse(
      EXECUTION_CAPABILITY_COVERAGE.workgroupRuntimePairs.map((item) => item.id),
      expected,
    )
  })

  test('wrapper parent × wrapper child matrix classifies all nine combinations', () => {
    const expected = WRAPPER_NODE_KINDS.flatMap((outer) =>
      WRAPPER_NODE_KINDS.map((inner) => `${outer}::${inner}`),
    )
    exactUniverse(
      EXECUTION_CAPABILITY_COVERAGE.wrapperCompositions.map((item) => item.id),
      expected,
    )
    for (const item of EXECUTION_CAPABILITY_COVERAGE.wrapperCompositions) {
      expect(['supported', 'static-rejected', 'runtime-rejected']).toContain(item.classification)
    }
  })

  test('named orchestration spines cannot disappear behind incidental coverage', () => {
    exactUniverse(
      EXECUTION_CAPABILITY_COVERAGE.orchestrationSpines.map((item) => item.id),
      REQUIRED_ORCHESTRATION_SPINES,
    )
  })

  test('every catalog claim points to a checked-in source anchor and a named test layer', () => {
    for (const evidence of allEvidence()) {
      const path = resolve(REPO_ROOT, evidence.file)
      expect(existsSync(path), evidence.file).toBe(true)
      const source = readFileSync(path, 'utf8')
      expect(source.includes(evidence.anchor), `${evidence.file}#${evidence.anchor}`).toBe(true)
      expect(['fast-contract', 'deterministic-e2e', 'live-release']).toContain(evidence.layer)
    }
  })
})

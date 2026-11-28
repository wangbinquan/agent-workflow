// RFC-374: NodeRun mint order is seq-first; typed structural detection closes the site catalog.
// RFC-629: the live multi-package `ts.Program` scan runs in `architecture/rfc629-shared-program-guards.test.ts`;
// this file retains the isolated virtual-program fixtures, ledger mutation checks and manifest registration check.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  NODE_RUN_ORDER_EXCEPTIONS,
  checkNodeRunOrderExceptions,
  detectNodeRunIdOrder,
  nodeRunOrderVirtualProgram,
  type NodeRunOrderException,
  type NodeRunOrderViolation,
} from '../helpers/rfc629SharedProgramRules'

export {
  NODE_RUN_ORDER_EXCEPTIONS,
  checkNodeRunOrderExceptions,
  detectNodeRunIdOrder,
  nodeRunOrderVirtualProgram,
  type NodeRunOrderException,
  type NodeRunOrderViolation,
}

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

function detectSample(source: string): NodeRunOrderViolation[] {
  const program = nodeRunOrderVirtualProgram({ '/virtual/sample.ts': source })
  return detectNodeRunIdOrder(
    program.getSourceFile('/virtual/sample.ts')!,
    program.getTypeChecker(),
  )
}

const RUN_SAMPLE =
  'type Run = { id: string; seq: number | null; nodeId: string; iteration: number }; declare const a: Run, b: Run; '

describe('RFC-374 NodeRun order hard guard', () => {
  test('each detection branch bites on virtual violations', () => {
    expect(detectSample('db.orderBy(asc(nodeRuns.id))')).toHaveLength(1)
    for (const sample of [
      'db.orderBy(desc(nodeRuns.id))',
      'import { nodeRuns as rows } from "schema"; const a = alias(rows, "a"); const b = alias(a, "b"); db.orderBy(desc(b.id))',
      RUN_SAMPLE + '(a.id as string) > b.id!',
      'const r = alias(nodeRuns, "r"); db.orderBy(asc(r.id), asc(r.seq))',
      'gt(nodeRuns.id, target.id)',
      'gte(nodeRuns.id, target.id)',
      'const r = alias(nodeRuns, "r"); lt(r.id, target.id)',
      'lte(nodeRuns.id, target.id)',
      RUN_SAMPLE + 'a.id > b.id',
      RUN_SAMPLE + 'a.id <= "id"',
      'declare const a: { nodeRunId: string }; a.nodeRunId < "id"',
      'declare const a: { runId: string }; a.runId >= "id"',
      'declare const sinceRunId: string; sinceRunId > "id"',
      RUN_SAMPLE + 'a.id.localeCompare(b.id)',
      'declare const runId: string; runId.localeCompare("id")',
      RUN_SAMPLE + '"id".localeCompare(a.id)',
      'function isFresherNodeRun(candidate: {id: string}, incumbent: {id: string}) { return candidate.id > incumbent.id }',
      'declare const a: { nodeRunId: string | null }; (a.nodeRunId ?? "") < "message"',
    ])
      expect(detectSample(sample).length).toBeGreaterThan(0)
  })
  test('frontend text branch detects an unresolved imported NodeRun comparison', () => {
    const file = '/packages/frontend/src/fixture.ts'
    const program = nodeRunOrderVirtualProgram({
      [file]:
        'import type { NodeRun } from "@agent-workflow/shared"; declare const a: NodeRun, b: NodeRun; a.id > b.id; a.id.localeCompare(b.id)',
    })
    expect(
      detectNodeRunIdOrder(program.getSourceFile(file)!, program.getTypeChecker()).map(
        (hit) => hit.rule,
      ),
    ).toEqual(['R3', 'R4'])
    const compliant = nodeRunOrderVirtualProgram({
      [file]:
        'import type { NodeRun } from "@agent-workflow/shared"; declare const a: NodeRun, b: NodeRun; compareNodeRunMintOrder(a, b)',
    })
    expect(
      detectNodeRunIdOrder(compliant.getSourceFile(file)!, compliant.getTypeChecker()),
    ).toEqual([])
  })
  test('compliant exemption boundaries remain accepted', () => {
    for (const sample of [
      'db.orderBy(descNullsLast(nodeRuns.seq), desc(nodeRuns.id))',
      'const r = alias(nodeRuns, "r"); db.orderBy(ascNullsFirst(r.seq), asc(r.id))',
      RUN_SAMPLE + 'compareNodeRunMintOrder(a, b)',
      'db.orderBy(asc(nodeRunEvents.id))',
      'declare const a: {id: string; round: number}, b: {id: string; round: number}; a.id > b.id',
      RUN_SAMPLE + 'a.id === b.id',
      RUN_SAMPLE + 'a.iteration > b.iteration',
      'eq(nodeRuns.id, "id")',
      'declare const a: {id: string; nodeId:string}; a.id > "id"',
      'declare const a: {id: number; nodeId:string; iteration:number}; a.id > 1',
    ])
      expect(detectSample(sample)).toEqual([])
    const escaped = detectSample(
      '// s1-allow-id-order: persisted receipt order\ndb.orderBy(asc(nodeRuns.id))',
    )
    expect(escaped).toHaveLength(1)
    expect(checkNodeRunOrderExceptions(escaped, {})).toEqual([])
    const expired = detectSample(
      '// s1-allow-id-order: too far away\n\n\n\n\n\n\ndb.orderBy(asc(nodeRuns.id))',
    )
    expect(checkNodeRunOrderExceptions(expired, {})).toHaveLength(1)
  })
  test('exception ledger mutations reject removed and added entries', () => {
    const syntheticHits: NodeRunOrderViolation[] = Object.entries(
      NODE_RUN_ORDER_EXCEPTIONS,
    ).flatMap(([file, entry]) =>
      Array.from({ length: entry.count }, (_, index) => ({
        file,
        line: index + 1,
        rule: 'R3' as const,
        text: 'a.id > b.id',
        allowance: null,
      })),
    )
    expect(checkNodeRunOrderExceptions(syntheticHits, NODE_RUN_ORDER_EXCEPTIONS)).toEqual([])
    const [file] = Object.keys(NODE_RUN_ORDER_EXCEPTIONS)
    const removed = { ...NODE_RUN_ORDER_EXCEPTIONS }
    delete removed[file!]
    expect(
      checkNodeRunOrderExceptions(syntheticHits, removed).some((error) =>
        error.startsWith('unregistered:'),
      ),
    ).toBe(true)
    expect(
      checkNodeRunOrderExceptions(syntheticHits, {
        ...NODE_RUN_ORDER_EXCEPTIONS,
        'never.ts': { count: 1, reason: 'stale negative fixture' },
      }).some((error) => error.startsWith('stale:')),
    ).toBe(true)
  })
  test('guard source is registered in the manifest', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(ROOT, 'architecture/guard-manifest.json'), 'utf8'),
    ) as { guards: { file: string }[] }
    expect(
      manifest.guards.some((guard) => guard.file.endsWith('/rfc374-node-run-order-guard.test.ts')),
    ).toBe(true)
  })
})

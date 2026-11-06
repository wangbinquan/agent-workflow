// RFC-083 PR-E — source-text backstops the unit tests can't observe.
//  1. The ALWAYS-ON baseline path (baseline / gitBackend / assemble / impact)
//     must NOT import deep/* — else protobufjs gets pulled into every structural
//     analysis (and risks the RFC-079 binary-init-cycle). Deep is reached only
//     via the service orchestrator, on `?mode=deep`.
//  2. The two-tier confidence contract: precise = 'extracted', heuristic =
//     'inferred'. Lock it at source so a refactor can't silently blur them.
//  3. runner wires a timeout (runtime not observable in CI).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// RFC-453: the family moved into the workspace-insight module (domain / engine / application / infrastructure).
const WI = resolve(import.meta.dir, '..', 'src', 'modules', 'workspace-insight')
const read = (rel: string): string => readFileSync(resolve(WI, rel), 'utf8')
const BASELINE_PATH: Record<string, string> = {
  'baseline.ts': 'engine/structuralDiff/baseline.ts',
  'gitBackend.ts': 'application/structuralDiff/revisionAnalysis.ts',
  'assemble.ts': 'engine/structuralDiff/assemble.ts',
  'impact.ts': 'domain/structuralDiff/impact.ts',
}

describe('deep/ stays out of the always-on baseline path', () => {
  for (const f of ['baseline.ts', 'gitBackend.ts', 'assemble.ts', 'impact.ts']) {
    test(`${f} does not import deep/`, () => {
      const src = read(BASELINE_PATH[f]!)
      expect(src).not.toMatch(/from ['"][^'"]*\/deep\//)
      expect(src).not.toMatch(/protobufjs/)
    })
  }

  test('the shared barrel does not reference deep / protobuf', () => {
    const barrel = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'index.ts'),
      'utf8',
    )
    expect(barrel).not.toMatch(/deep/)
    expect(barrel).not.toMatch(/protobuf/)
  })
})

describe('two-tier confidence contract', () => {
  test("deep precise impact tags callers 'extracted'", () => {
    expect(read('domain/deep/deepImpact.ts')).toMatch(/confidence: 'extracted'/)
  })
  test("baseline heuristic impact tags callers 'inferred'", () => {
    expect(read('domain/structuralDiff/impact.ts')).toMatch(/confidence: 'inferred'/)
  })
})

describe('deep runner safety', () => {
  test('runIndexer wires a timeout + kills the process', () => {
    const src = read('infrastructure/deep/indexerRunner.ts')
    expect(src).toMatch(/setTimeout/)
    expect(src).toMatch(/\.kill\(/)
    expect(src).toMatch(/timeoutMs/)
  })
  test('indexer binary is resolved from settings/PATH, no hardcoded abs dev path', () => {
    const src = read('domain/deep/indexers.ts')
    expect(src).not.toMatch(/\/Users\/|\/home\/|\/opt\//)
    expect(src).toMatch(/resolveIndexerBin/)
  })
})

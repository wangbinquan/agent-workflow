// RFC-083 PR-E — the deep-mode safety contract. With injected stub probe/run
// (no real indexer), assert: success → engine 'deep' + precise 'extracted'
// impact augmenting the baseline; EVERY failure mode throws a typed
// DeepUnavailableError carrying the right reason (the service catch turns that
// into a clean baseline fallback). The baseline payload is always preserved.

import { describe, expect, test } from 'bun:test'
import { computeDeepStructuralDiff } from '../src/modules/workspace-insight/infrastructure/deep/deepStructuralDiff'
import { DeepUnavailableError } from '../src/modules/workspace-insight/domain/deep/deepIndexing'
import { encodeScipFixture } from '../src/modules/workspace-insight/domain/deep/scip'
import { computeSummary, type StructuralDiff, type SymbolNode } from '@agent-workflow/shared'

const chargeNode: SymbolNode = {
  id: 'svc.ts#Svc.charge:method:2',
  kind: 'method',
  name: 'charge',
  qualifiedName: 'Svc.charge',
  lang: 'typescript',
  filePath: 'svc.ts',
  range: { startLine: 2, endLine: 4 },
  confidence: 'extracted',
}

function baselineDiff(): StructuralDiff {
  const files = [
    {
      filePath: 'svc.ts',
      lang: 'typescript' as const,
      status: 'ok' as const,
      edges: [],
      impact: [], // heuristic baseline impact (empty here)
      changes: [{ changeType: 'modified' as const, kind: 'method' as const, after: chargeNode }],
    },
  ]
  return {
    scope: 'task',
    taskId: 't',
    fromRef: 'a',
    toRef: 'WORKTREE',
    engine: 'baseline',
    status: 'ok',
    files,
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    summary: computeSummary(files, []),
  }
}

const available = async () => ({ available: true, bin: 'stub', version: '1.0' })

function expectReason(p: Promise<unknown>, reason: string): Promise<void> {
  return p.then(
    () => {
      throw new Error(`expected DeepUnavailableError(${reason}), got success`)
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(DeepUnavailableError)
      expect(String((err as DeepUnavailableError).reason)).toBe(reason)
    },
  )
}

describe('computeDeepStructuralDiff', () => {
  test('happy path: valid SCIP → engine deep, precise extracted impact, baseline kept', async () => {
    const scipBytes = encodeScipFixture([
      {
        relativePath: 'svc.ts',
        occurrences: [{ symbol: 'S#charge', range: [1, 6, 12], isDefinition: true }],
      },
      {
        relativePath: 'order.ts',
        occurrences: [{ symbol: 'S#charge', range: [8, 4, 10], isDefinition: false }],
      },
    ])
    const out = await computeDeepStructuralDiff({
      baseline: baselineDiff(),
      worktreePath: '/wt',
      deps: { probeIndexer: available, runIndexer: async () => ({ ok: true, scipBytes }) },
    })
    expect(out.engine).toBe('deep')
    expect(out.degradedReason).toBeUndefined()
    expect(out.files).toHaveLength(1) // baseline payload preserved
    expect(out.impact).toHaveLength(1)
    expect(out.impact[0]?.confidence).toBe('extracted')
    expect(out.impact[0]?.callers.map((c) => c.filePath)).toEqual(['order.ts'])
  })

  test('multi-language diff: runs both indexers, merges graphs, impact spans both', async () => {
    const tsNode: SymbolNode = { ...chargeNode, id: 'svc.ts#A.foo:method:2', filePath: 'svc.ts' }
    const pyNode: SymbolNode = {
      ...chargeNode,
      id: 'mod.py#B.bar:method:2',
      filePath: 'mod.py',
      lang: 'python',
    }
    const files = [
      {
        filePath: 'svc.ts',
        lang: 'typescript' as const,
        status: 'ok' as const,
        edges: [],
        impact: [],
        changes: [{ changeType: 'modified' as const, kind: 'method' as const, after: tsNode }],
      },
      {
        filePath: 'mod.py',
        lang: 'python' as const,
        status: 'ok' as const,
        edges: [],
        impact: [],
        changes: [{ changeType: 'modified' as const, kind: 'method' as const, after: pyNode }],
      },
    ]
    const baseline: StructuralDiff = {
      ...baselineDiff(),
      files,
      summary: computeSummary(files, []),
    }
    const tsBytes = encodeScipFixture([
      {
        relativePath: 'svc.ts',
        occurrences: [{ symbol: 'TS#foo', range: [1, 0, 5], isDefinition: true }],
      },
      {
        relativePath: 'caller.ts',
        occurrences: [{ symbol: 'TS#foo', range: [3, 0, 5], isDefinition: false }],
      },
    ])
    const pyBytes = encodeScipFixture([
      {
        relativePath: 'mod.py',
        occurrences: [{ symbol: 'PY#bar', range: [1, 0, 5], isDefinition: true }],
      },
      {
        relativePath: 'helper.py',
        occurrences: [{ symbol: 'PY#bar', range: [3, 0, 5], isDefinition: false }],
      },
    ])
    const out = await computeDeepStructuralDiff({
      baseline,
      worktreePath: '/wt',
      deps: {
        probeIndexer: available,
        runIndexer: async ({ spec }) => ({
          ok: true,
          scipBytes: spec.id === 'scip-typescript' ? tsBytes : pyBytes,
        }),
      },
    })
    expect(out.engine).toBe('deep')
    const callerFiles = out.impact.flatMap((i) => i.callers.map((c) => c.filePath)).sort()
    expect(callerFiles).toEqual(['caller.ts', 'helper.py']) // merged across both indexers
  })

  test('no indexer available → indexer-missing', async () => {
    await expectReason(
      computeDeepStructuralDiff({
        baseline: baselineDiff(),
        worktreePath: '/wt',
        deps: { probeIndexer: async () => ({ available: false, bin: 'x', version: null }) },
      }),
      'indexer-missing',
    )
  })

  test('no indexer covers the languages → indexer-missing', async () => {
    const noLang = baselineDiff()
    noLang.files[0]!.filePath = 'data.bin' // no indexer ext
    await expectReason(
      computeDeepStructuralDiff({ baseline: noLang, worktreePath: '/wt', deps: {} }),
      'indexer-missing',
    )
  })

  test('indexer exits non-zero → build-failed', async () => {
    await expectReason(
      computeDeepStructuralDiff({
        baseline: baselineDiff(),
        worktreePath: '/wt',
        deps: {
          probeIndexer: available,
          runIndexer: async () => ({ ok: false, reason: 'build-failed' }),
        },
      }),
      'build-failed',
    )
  })

  test('indexer times out → timeout', async () => {
    await expectReason(
      computeDeepStructuralDiff({
        baseline: baselineDiff(),
        worktreePath: '/wt',
        deps: {
          probeIndexer: available,
          runIndexer: async () => ({ ok: false, reason: 'timeout' }),
        },
      }),
      'timeout',
    )
  })

  test('garbage SCIP output → scip-parse-error', async () => {
    await expectReason(
      computeDeepStructuralDiff({
        baseline: baselineDiff(),
        worktreePath: '/wt',
        deps: {
          probeIndexer: available,
          runIndexer: async () => ({
            ok: true,
            scipBytes: Uint8Array.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff]),
          }),
        },
      }),
      'scip-parse-error',
    )
  })
})

// RFC-083 — within-file blast radius. For a changed method, the OTHER methods
// in the same file whose body calls it (heuristic, confidence 'inferred'). This
// is the CI-verifiable slice of the "impact" pillar (cross-file SCIP is a
// documented follow-up).

import { describe, expect, test } from 'bun:test'
import { computeWithinFileImpact } from '../src/services/structuralDiff/impact'
import { analyzeFile } from '../src/services/structuralDiff/baseline'
import type { SymbolChange, SymbolNode } from '@agent-workflow/shared'

function sym(p: { qn: string; startLine: number; endLine: number }): SymbolNode {
  return {
    id: `f.py#${p.qn}:method:${p.startLine}`,
    kind: 'method',
    name: p.qn.split('.').pop() ?? p.qn,
    qualifiedName: p.qn,
    lang: 'python',
    filePath: 'f.py',
    range: { startLine: p.startLine, endLine: p.endLine },
    confidence: 'extracted',
  }
}

describe('computeWithinFileImpact', () => {
  test('finds within-file callers of a changed method', () => {
    const newText = `class A:
    def helper(self):
        return 1
    def caller(self):
        return self.helper() + 2
    def unrelated(self):
        return 9
`
    const helper = sym({ qn: 'A.helper', startLine: 2, endLine: 3 })
    const caller = sym({ qn: 'A.caller', startLine: 4, endLine: 5 })
    const unrelated = sym({ qn: 'A.unrelated', startLine: 6, endLine: 7 })
    const changes: SymbolChange[] = [{ changeType: 'modified', kind: 'method', after: helper }]
    const impact = computeWithinFileImpact(changes, [helper, caller, unrelated], newText, 'f.py')
    expect(impact).toHaveLength(1)
    expect(impact[0]?.changedSymbolId).toBe(helper.id)
    expect(impact[0]?.confidence).toBe('inferred')
    const callerIds = impact[0]?.callers.map((c) => c.symbolId)
    expect(callerIds).toContain(caller.id)
    expect(callerIds).not.toContain(unrelated.id) // doesn't call helper
    expect(callerIds).not.toContain(helper.id) // not itself
  })

  test('no callers → no impact item', () => {
    const newText = `def lonely():\n    return 1\n`
    const lonely = sym({ qn: 'lonely', startLine: 1, endLine: 2 })
    const impact = computeWithinFileImpact(
      [{ changeType: 'modified', kind: 'method', after: lonely }],
      [lonely],
      newText,
      'f.py',
    )
    expect(impact).toEqual([])
  })
})

describe('analyzeFile — populates within-file impact', () => {
  test('a modified method that is called elsewhere in the file yields impact', async () => {
    const before = `class A:
    def helper(self):
        return 1
    def caller(self):
        return self.helper()
`
    const after = `class A:
    def helper(self):
        return 2
    def caller(self):
        return self.helper()
`
    const file = await analyzeFile({ filePath: 'a.py', oldText: before, newText: after })
    expect(file.status).toBe('ok')
    const helperImpact = file.impact.find((i) => i.changedSymbolId.includes('helper'))
    expect(helperImpact).toBeDefined()
    expect(helperImpact?.callers.some((c) => (c.symbolId ?? '').includes('caller'))).toBe(true)
  })
})

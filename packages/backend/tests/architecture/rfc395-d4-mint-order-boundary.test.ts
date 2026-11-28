// RFC-395 D4: epoch-2 reads never see a NULL seq, so nothing outside the conversion oracle may keep
// the epoch-1 mint order: no NULL-first / ID fallback, no ID-only lineage anchor, no nullable seq in
// a NodeRun view and no `seq === null` branch.
// RFC-629: the live backend/shared/frontend corpus scan runs in `architecture/rfc629-shared-program-guards.test.ts`
// reusing the already-parsed SourceFiles from both shared programs; this file retains all negative controls.
import { describe, expect, test } from 'bun:test'
import { sourceUnit } from './census'
import { mintOrderHits } from '../helpers/rfc629SharedProgramRules'

export { mintOrderHits }

describe('RFC-395 D4 mint order boundary', () => {
  test('negative controls flag each epoch-1 shape and leave allocated seq alone', () => {
    const rules = (text: string, path = 'packages/frontend/src/sample.tsx') =>
      mintOrderHits(sourceUnit(path, text)).map((hit) => hit.slice(0, hit.indexOf(':')))
    expect(rules("import { nodeRunOrderAnchor } from '@agent-workflow/shared'")).toEqual([
      'legacy-order-name',
    ])
    expect(rules('const a = compareLegacyNodeRunMintOrder(x, y)')).toEqual(['legacy-order-name'])
    expect(rules('interface Row { readonly seq: number | null }')).toEqual(['nullable-seq'])
    expect(rules('type Row = { seq?: null | number }')).toEqual(['nullable-seq'])
    expect(rules('if (row.seq === null) return')).toEqual(['seq-null-check'])
    expect(rules('const fresh = null != anchor.seq')).toEqual(['seq-null-check'])
    expect(rules('interface Row { readonly seq: number }')).toEqual([])
    expect(rules('const next = (last?.seq ?? 0) + 1')).toEqual([])
    expect(rules('if (row.seq > latest.seq) pick(row)')).toEqual([])
  })
})

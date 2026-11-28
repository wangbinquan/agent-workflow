// RFC-626 design §3.4 rows 10 and 17, CONVERSION-RULES "a row-level block is set aside". These
// resource-catalog rules keep their blocks as they are (only the automatic upgrade's collector
// changes what a block means). Locks that every block they raise is row-level and names its
// source row, so that with automatic resolution the row is set aside — archived with its
// decision — instead of failing the upgrade; with operator resolution it is still a block.
import { describe, expect, test } from 'bun:test'
import { TASK_DEFINITION_HOST_IDS } from '@agent-workflow/shared'
import { workflowsRule } from '@/modules/resource-catalog/infrastructure/migration/workflowsRule'
import { resourceGrantsRule } from '@/modules/resource-catalog/infrastructure/migration/resourceGrantsRule'
import { bundleAppliesRule } from '@/modules/resource-catalog/infrastructure/migration/bundleAppliesRule'
import {
  hostPlaceholders,
  referencedWorkflowIds,
} from '@/modules/resource-catalog/infrastructure/migration/lookups'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import { RESOLUTION_CODES, type SourceRow } from '@/platform/persistence/migration/conversion/types'
import { fixtureLookup } from './helpers/rfc395V2Harness'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { runRuleUnit, sourceRow } from './helpers/rfc626CatalogRuleUnit'

const HOST = TASK_DEFINITION_HOST_IDS[0]!
const lookups = [hostPlaceholders, referencedWorkflowIds, fixtureLookup(TASK_FACTS, [])]
const host = sourceRow(
  'workflows',
  frozenValues('workflows', {
    id: HOST,
    name: 'host',
    builtin: false,
    definition: '{"nodes":[],"edges":[],"inputs":[]}',
  }),
)
const brokenWorkflow = sourceRow(
  'workflows',
  frozenValues('workflows', { id: 'workflow-broken', name: 'broken', definition: '[1]' }),
)
const hostGrant = sourceRow(
  'resource_grants',
  frozenValues('resource_grants', {
    resource_type: 'workflow',
    resource_id: HOST,
    user_id: 'user-1',
    added_by: 'user-1',
  }),
  ['resource_type', 'resource_id', 'user_id'],
)
const undecodableApply = sourceRow(
  'resource_bundle_applies',
  frozenValues('resource_bundle_applies', {
    id: 'apply-1',
    state: 'prepared',
    prepared_artifacts_json: '{"scene":"unknown"}',
    receipt_json: null,
  }),
)

const cases: readonly {
  readonly name: string
  readonly rule: ConversionRule
  readonly rows: readonly SourceRow[]
  readonly expected: readonly { readonly row: SourceRow; readonly code: string }[]
}[] = [
  {
    name: 'workflows',
    rule: workflowsRule,
    rows: [host, brokenWorkflow],
    expected: [
      { row: host, code: 'v2-host-not-placeholder' },
      { row: brokenWorkflow, code: 'v2-workflow-definition-shape' },
    ],
  },
  {
    name: 'resource grants',
    rule: resourceGrantsRule,
    rows: [host, hostGrant],
    expected: [{ row: hostGrant, code: 'v2-host-grant-deletion-blocked' }],
  },
  {
    name: 'resource bundle applies',
    rule: bundleAppliesRule,
    rows: [undecodableApply],
    expected: [{ row: undecodableApply, code: 'v2-bundle-artifact-undecodable' }],
  },
]

describe('RFC-626 rows 10 and 17: resource-catalog blocks are row-level', () => {
  for (const item of cases) {
    test(`${item.name}: operator resolution blocks exactly those rows`, async () => {
      const result = await runRuleUnit({ rule: item.rule, lookups, rows: item.rows })
      expect(
        result.output.blocks.map((block) => [block.code, block.scope, block.sourceKey]).sort(),
      ).toEqual(item.expected.map(({ row, code }) => [code, 'row', row.encodedKey]).sort())
    })
    test(`${item.name}: automatic resolution sets those rows aside`, async () => {
      const result = await runRuleUnit({
        rule: item.rule,
        lookups,
        rows: item.rows,
        resolution: 'automatic',
      })
      expect(result.output.blocks).toEqual([])
      for (const { row, code } of item.expected) {
        const dispositions = result.output.dispositions.filter(
          (disposition) => disposition.sourceKey === row.encodedKey,
        )
        expect(dispositions).toEqual([
          expect.objectContaining({ class: 'archived', kind: 'archived', targets: [] }),
        ])
        expect(dispositions[0]!.decision?.code).toBe(code)
        expect(result.decisions(RESOLUTION_CODES.rowSetAside)).toContainEqual(
          expect.objectContaining({ sourceKey: row.encodedKey, code }),
        )
      }
      for (const table of item.rule.produces.map((entry) => entry.table))
        expect(result.rows(table)).toEqual([])
    })
  }
})

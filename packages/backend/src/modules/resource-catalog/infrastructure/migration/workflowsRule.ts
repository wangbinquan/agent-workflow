import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import { HOST_PLACEHOLDERS, REFERENCED_WORKFLOW_IDS, survivingWorkflowReferences } from './lookups'
import { buildWorkflowDependencyIndex } from './workflowDocument'
import { resourceDecision } from './evidence'

export { buildWorkflowDependencyIndex, classifyHostWorkflow } from './workflowDocument'

export const workflowsRule: ConversionRule = {
  ref: { id: 'resource-catalog/workflows', version: 2 },
  owner: 'resource-catalog',
  claims: ['workflows'],
  produces: [{ table: 'workflows' }, { table: 'workflow_dependency_index' }],
  lookups: [HOST_PLACEHOLDERS, REFERENCED_WORKFLOW_IDS],
  unit: { kind: 'source-chunk', table: 'workflows' },
  convert(unit, ctx) {
    for (const row of unit.rows.get('workflows') ?? []) {
      const host = ctx.lookup(HOST_PLACEHOLDERS).get(String(row.values.id))
      if (host?.classification === 'non-skeleton-host') {
        resourceDecision(
          row,
          ctx,
          'v2-host-not-placeholder',
          { classification: host.classification },
          [],
        )
        ctx.out.block(
          rowBlock('v2-host-not-placeholder', row, { id: String(row.values.id) }, [
            'builtin',
            'definition',
          ]),
        )
        continue
      }
      if (host?.classification === 'placeholder') {
        const references = survivingWorkflowReferences(ctx, String(row.values.id))
        if (references.length) {
          resourceDecision(
            row,
            ctx,
            'v2-host-still-referenced',
            references.map((ref) => ({ ...ref })),
            [],
          )
          ctx.out.block(
            rowBlock(
              'v2-host-still-referenced',
              row,
              references.map((ref) => ({ ...ref })),
              ['surviving-references'],
            ),
          )
        } else
          resourceDecision(
            row,
            ctx,
            'v2-host-placeholder-deleted',
            { id: String(row.values.id), dependencyRows: 0 },
            [],
            true,
          )
        continue
      }
      try {
        const index = buildWorkflowDependencyIndex(row)
        ctx.out.row('workflows', row.values, row)
        for (const entry of index) ctx.out.row('workflow_dependency_index', entry, row)
      } catch (error) {
        resourceDecision(row, ctx, 'v2-workflow-definition-shape', { message: String(error) }, [])
        ctx.out.block(
          rowBlock('v2-workflow-definition-shape', row, { message: String(error) }, ['definition']),
        )
      }
    }
  },
}

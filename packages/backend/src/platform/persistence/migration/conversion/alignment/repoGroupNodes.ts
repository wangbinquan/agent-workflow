import { repoGroupIds } from '../generic/references'
import { valuesByColumnName } from '../generic/preserved'
import { canonicalValue } from '../migrationKey'
import { alignmentRule, copyAlignedRow, danglingReference, resolveAlignment } from './common'

export const repoGroupNodesRule = alignmentRule(
  'repo_group_nodes',
  [repoGroupIds.key],
  (row, ctx) => {
    if (!danglingReference(row, 'child_group_id', repoGroupIds.key, ctx)) {
      copyAlignedRow(row, ctx)
      return
    }
    // modules/source-control/infrastructure/repositoryWorkspaceStore.ts:254-268
    const detached = {
      attachment_kind: null,
      cached_repo_id: null,
      child_group_id: null,
      ref: '',
      subdir: '',
      readonly: false,
    }
    resolveAlignment(
      row,
      { ...valuesByColumnName(row, ctx), ...detached },
      'v2-repo-group-detached',
      {
        previous: Object.fromEntries(
          Object.keys(detached).map((column) => [column, canonicalValue(row.values[column]!)]),
        ),
      },
      ctx,
    )
  },
)

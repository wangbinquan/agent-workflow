import { rowBlock } from '../blockCodes'
import { alignmentRule, copyAlignedRow } from './common'

export const runtimeSessionLeasesRule = alignmentRule('runtime_session_leases', [], (row, ctx) => {
  if (row.values.reset_pending === true && row.values.lease_node_run_id === null)
    ctx.out.block(
      rowBlock('v2-lease-reset-without-run', row, { resetPending: true, leaseNodeRunId: null }, [
        'lease_node_run_id',
      ]),
    )
  else copyAlignedRow(row, ctx)
})

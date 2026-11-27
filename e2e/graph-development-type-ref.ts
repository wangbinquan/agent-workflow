// The built-in graph-development MR type and its built-in MR jobs as the production code publishes
// them. Both move whenever the shared MR care is republished (RFC-628 moved graph@2 to graph@3 and
// the jobs from mr-v1 / mr-ci-v1 to mr-v2 / mr-ci-v2); a hand-copied `graph-development@N` or job
// id turns a whole spec into `employee-type-not-found` 404s or a missing default job that day.
// The same reasoning as e2e/development-type-ref.ts.
import { GRAPH_DELIVERY_EMPLOYEE_TYPE } from '../packages/backend/src/modules/development-automation/composition/graphDeliveryLifecycle'

export {
  GRAPH_MR_JOB_ID,
  GRAPH_MR_PIPELINE_JOB_ID,
} from '../packages/backend/src/modules/development-automation/composition/graphDeliveryJob'

/** `{ typeId: 'graph-development', revision: <current> }`, as a Case projection reports it. */
export const GRAPH_DEVELOPMENT_TYPE = {
  typeId: GRAPH_DELIVERY_EMPLOYEE_TYPE.typeId,
  revision: GRAPH_DELIVERY_EMPLOYEE_TYPE.revision,
}
/** `graph-development@<current revision>`. */
export const GRAPH_DEVELOPMENT_TYPE_REF = `${GRAPH_DELIVERY_EMPLOYEE_TYPE.typeId}@${GRAPH_DELIVERY_EMPLOYEE_TYPE.revision}`

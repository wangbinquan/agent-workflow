import type { TaskScriptRunFamily } from '../application/ports/taskScriptRunFamily'
import { createLocalTaskScriptRunFamily } from '../infrastructure/local/taskScriptRunFamily'

/** Bootstrap invokes this factory again for each effective drive, including
 * children. Normal composition never selects this native pairing implicitly. */
export function composeLocalTaskScriptRunFamily(): TaskScriptRunFamily {
  return createLocalTaskScriptRunFamily()
}

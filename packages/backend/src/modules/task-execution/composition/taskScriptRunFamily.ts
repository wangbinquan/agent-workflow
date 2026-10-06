import type {
  TaskScriptRunFamily,
  TaskScriptRunRequest,
} from '../application/ports/taskScriptRunFamily'

/** Only the explicitly selected complete family runs the common Task policy. */
export function runScriptWithFamily(family: TaskScriptRunFamily, request: TaskScriptRunRequest) {
  return family.execute(request)
}

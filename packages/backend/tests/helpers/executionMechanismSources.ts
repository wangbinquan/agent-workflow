// Source locks follow the actual owners, including the script attempt callbacks.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '../../src/modules/task-execution')
export const SCRIPT_NODE_SOURCE = readFileSync(
  resolve(root, 'engine/node/script/runScriptNode.ts'),
  'utf8',
)
export const SCRIPT_ATTEMPT_SOURCE = readFileSync(
  resolve(root, 'engine/node/script/runOneScriptAttempt.ts'),
  'utf8',
)
export const MERGE_CONFLICT_SOURCE = readFileSync(
  resolve(root, 'engine/node/shared/resolveMergeConflicts.ts'),
  'utf8',
)

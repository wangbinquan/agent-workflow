import { columnLookup, idSetLookup } from '../lookups'

export const userIds = idSetLookup('users', 'id')
export const workflowBuiltins = columnLookup('workflows', ['id'], ['builtin'])
export const runContinuationSlots = columnLookup('node_runs', ['id'], ['continuation_slot_key'])
export const memoryIds = idSetLookup('memories', 'id')
export const repoGroupIds = idSetLookup('repo_groups', 'id')
export const missionIds = idSetLookup('development_missions', 'id')
export const skillIds = idSetLookup('skills', 'id')
export const agentIds = idSetLookup('agents', 'id')
export const mcpIds = idSetLookup('mcps', 'id')
export const pluginIds = idSetLookup('plugins', 'id')
export const runTasks = columnLookup('node_runs', ['id'], ['task_id'])
export const documentTasks = columnLookup('doc_versions', ['id'], ['task_id'])
export const gateOperationTasks = columnLookup('collaboration_gate_operations', ['id'], ['task_id'])
export const codeWorkItemStates = columnLookup(
  'code_work_items',
  ['id'],
  ['status', 'pending_generation', 'publishing_epoch', 'pending_revision'],
)
export const codeWorkRoundStates = columnLookup('code_work_rounds', ['id'], ['outcome', 'ended_at'])

// Generic builders have one production owner; consumers declare only their keys.
export const referenceLookups = [
  userIds,
  workflowBuiltins,
  runContinuationSlots,
  memoryIds,
  repoGroupIds,
  missionIds,
  skillIds,
  agentIds,
  mcpIds,
  pluginIds,
  runTasks,
  documentTasks,
  gateOperationTasks,
  codeWorkItemStates,
  codeWorkRoundStates,
] as const

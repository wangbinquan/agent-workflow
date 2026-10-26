import type { NodeRunRole } from './nodeRunRole'

export const NODE_RUN_CONFIG_FIELDS = [
  'runtime',
  'runtimeBinary',
  'runtimeParamsJson',
  'inventorySnapshotJson',
  'runtimeInventoryJson',
  'injectedMemoriesJson',
  'agentOverrideName',
  'agentOverrideId',
  'shardValueHash',
  'promptRefJson',
  'promptInlineBytes',
] as const
export const NODE_RUN_RUNTIME_FIELDS = [
  'pid',
  'spawnBinaryPath',
  'spawnLaunchNonce',
  'sessionId',
  'startupVerificationJson',
  'wrapperProgressJson',
  'isolationRootRef',
  'mergeState',
] as const
export const NODE_RUN_RESULT_FIELDS = [
  'tokInput',
  'tokOutput',
  'tokCacheCreate',
  'tokCacheRead',
  'tokTotal',
  'portValidationFailuresJson',
  'commitPushJson',
  'supersededByReview',
  'rolledBack',
] as const

type Facts<K extends string> = Readonly<Partial<Record<K, unknown>>>
export interface NodeRunRowPresenceFacts {
  readonly role: NodeRunRole | null
  readonly recordMode: 'executable' | 'history-only'
  readonly config?: Facts<(typeof NODE_RUN_CONFIG_FIELDS)[number]> | null
  readonly runtime?: Facts<(typeof NODE_RUN_RUNTIME_FIELDS)[number]> | null
  readonly result?: Facts<(typeof NODE_RUN_RESULT_FIELDS)[number]> | null
}

/** Runtime, conversion and fixtures share value presence, not role-based defaults.
 * Empty strings, zero and false are recorded facts, including unknown history.
 * A role alone never invents a config, process, session or result row. */
export function nodeRunRowPresence(facts: NodeRunRowPresenceFacts) {
  const present = <K extends string>(fields: readonly K[], values?: Facts<K> | null) =>
    fields.some((field) => values?.[field] !== undefined && values[field] !== null)
  return {
    config: present(NODE_RUN_CONFIG_FIELDS, facts.config),
    runtimeState: present(NODE_RUN_RUNTIME_FIELDS, facts.runtime),
    result: present(NODE_RUN_RESULT_FIELDS, facts.result),
  }
}

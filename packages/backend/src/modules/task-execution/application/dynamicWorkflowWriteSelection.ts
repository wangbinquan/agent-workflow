import type {
  DynamicWorkflowPersistence,
  DynamicWorkflowStateWriter,
  DynamicWorkflowWritePurposes,
} from './ports/dynamicWorkflowPersistence'

/** Each original generation checkpoint selects its own purpose. */
export function selectDynamicWorkflowStateWrites(
  persistence: DynamicWorkflowPersistence,
  purpose: keyof DynamicWorkflowWritePurposes,
): DynamicWorkflowStateWriter {
  if (persistence.writeMode === undefined && persistence.writePurposes === undefined)
    return persistence
  const view = persistence.writePurposes?.[purpose]
  if (view === undefined) throw new Error('task-dynamic-workflow-write-purposes-not-composed')
  return view
}

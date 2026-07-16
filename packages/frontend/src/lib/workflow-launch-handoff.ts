export type WorkflowLaunchWizardSearch =
  | { editScheduled: string }
  | { kind: 'workflow'; workflow: string; workflowVersion?: number }

/**
 * Preserve the retired launch URL as a typed exact-revision handoff. Invalid
 * or absent versions keep old bookmarks working, while editor-generated
 * positive versions become the task wizard's OCC fence.
 */
export function workflowLaunchWizardSearch(
  workflowId: string,
  raw: { editScheduled?: string; version?: unknown },
): WorkflowLaunchWizardSearch {
  if (raw.editScheduled !== undefined) return { editScheduled: raw.editScheduled }
  const numericVersion =
    typeof raw.version === 'number'
      ? raw.version
      : typeof raw.version === 'string' && raw.version.trim() !== ''
        ? Number(raw.version)
        : undefined
  const workflowVersion =
    numericVersion !== undefined && Number.isInteger(numericVersion) && numericVersion > 0
      ? numericVersion
      : undefined
  return {
    kind: 'workflow',
    workflow: workflowId,
    ...(workflowVersion === undefined ? {} : { workflowVersion }),
  }
}

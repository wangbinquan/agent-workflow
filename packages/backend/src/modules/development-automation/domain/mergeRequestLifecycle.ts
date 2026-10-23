/**
 * The MR lifecycle is shared by development and graph-development. Its feature
 * level follows the frozen type revision; callers must keep the actual type
 * identity rather than substituting a development revision.
 */
export interface MergeRequestLifecycleTypeRef {
  readonly typeId: string
  readonly revision: number
}

export const MERGE_REQUEST_LIFECYCLE_WORK_ITEM_REFS = [
  'prepare-change',
  'publish-mr',
  'observe-mr',
  'classify-feedback',
  'acknowledge-feedback',
  'repair-feedback',
  'reply-feedback',
  'collect-pipeline',
  'classify-pipeline',
  'repair-pipeline',
  'repair-conflict',
  'publish-conflict',
  'delegate',
  'prepare-approval',
  'submit-approval',
  'observe-approval',
  'evaluate-ready',
  'wait-merge',
] as const

const lifecycleWorkItems = new Set<string>(MERGE_REQUEST_LIFECYCLE_WORK_ITEM_REFS)

export function isMergeRequestLifecycleWorkItem(workItemRef: string): boolean {
  return lifecycleWorkItems.has(workItemRef)
}

export function usesTargetAwareMergeRequestPipeline(
  typeRef: MergeRequestLifecycleTypeRef | null | undefined,
): boolean {
  return (
    (typeRef?.typeId === 'development' && typeRef.revision >= 8) ||
    (typeRef?.typeId === 'graph-development' && typeRef.revision >= 2)
  )
}

export function usesMinimalMergeRequestToolContracts(
  typeRef: MergeRequestLifecycleTypeRef | null | undefined,
): boolean {
  return (
    (typeRef?.typeId === 'development' && typeRef.revision >= 9) ||
    (typeRef?.typeId === 'graph-development' && typeRef.revision >= 2)
  )
}

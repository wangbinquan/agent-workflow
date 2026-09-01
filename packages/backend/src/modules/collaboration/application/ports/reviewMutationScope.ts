/** Resolve the immutable task scope for one review node. The process-local
 * mutex consumes only this purpose-specific Promise query. */
export interface ReviewMutationScopeResolver {
  findTaskId(nodeRunId: string): Promise<string | null>
}

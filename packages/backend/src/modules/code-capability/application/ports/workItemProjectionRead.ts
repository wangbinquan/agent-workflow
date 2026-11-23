import type { CodeWorkItemProjectionQuery, CodeWorkItemPage } from './codeQueries'

export type CodeWorkItemPageInput = Parameters<CodeWorkItemProjectionQuery['page']>[0]

/** Provider-neutral mechanics for the bounded work-item/round/stage projection. */
export interface WorkItemProjectionReadPort {
  readPage(input: CodeWorkItemPageInput): Promise<CodeWorkItemPage>
}

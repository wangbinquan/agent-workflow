/** Physical workspace presence; only the selected adapter interprets the reference. */
export interface WorkspacePresenceQueries {
  exists(workspaceRef: string): boolean | Promise<boolean>
}

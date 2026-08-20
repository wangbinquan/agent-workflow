/**
 * Consumer-owned workspace contract for one Digital Employee Reaction.
 * The implementation may live in source-control or an employee type package;
 * TaskExecution only receives a path-bound, already materialized scene.
 */
export interface DigitalEmployeeWorkspacePort {
  prepare(input: { readonly planJson: string; readonly attemptJson: string }): Promise<
    | { readonly kind: 'scratch' }
    | {
        readonly kind: 'repository'
        readonly workspacePath: string
        readonly baselineSha: string
        readonly platformInputPaths: readonly string[]
      }
  >
  validate(input: {
    readonly roundRef: string
    readonly taskStatus: string
    readonly outputJson: string | null
  }): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly errorCode: string; readonly errorDetail: string }
  >
}

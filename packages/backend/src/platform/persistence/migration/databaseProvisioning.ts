// RFC-398 design §1 / §3: provider-neutral allocated-database protocol, with no module dependencies.
export interface DatabaseAllocation {
  readonly n: number
  readonly kind: 'target' | 'scratch'
  readonly sessionOperationId: string
  readonly runId: string
  readonly database: string
  readonly profileRef: string
}
export interface DatabaseProvisioningRequest {
  readonly sessionOperationId: string
  readonly runId: string
  readonly generationId: string
}
export interface DatabaseProvisioningReceipt {
  readonly sessionOperationId: string
  readonly runId: string
  readonly generationId: string
  readonly target: DatabaseAllocation & { readonly created: boolean }
  readonly scratch: DatabaseAllocation & { readonly created: boolean }
  readonly retained: readonly DatabaseAllocation[]
}
/** RFC-626 §3.5: whether `prepare` could provide the databases of a new session. */
export type DatabaseProvisioningPrecheck =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: string
      /** The refusal `prepare` would give, with the statements a person can run. */
      readonly message: string
      readonly detail: Readonly<Record<string, unknown>>
    }
export interface DatabaseProvisioning {
  prepare(input: DatabaseProvisioningRequest): Promise<DatabaseProvisioningReceipt>
  retained(): Promise<
    readonly (DatabaseAllocation & { readonly bytes: number | null; readonly purpose: string })[]
  >
  /**
   * RFC-626 §3.5: read-only. Answers before a session is recorded what `prepare` would
   * otherwise find out after it has written its allocation files: that a database has to be
   * created and the role may not create one. Allocates nothing and creates nothing.
   */
  precheck?(): Promise<DatabaseProvisioningPrecheck>
}

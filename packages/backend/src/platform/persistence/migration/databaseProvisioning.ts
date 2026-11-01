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
export interface DatabaseProvisioning {
  prepare(input: DatabaseProvisioningRequest): Promise<DatabaseProvisioningReceipt>
  retained(): Promise<
    readonly (DatabaseAllocation & { readonly bytes: number | null; readonly purpose: string })[]
  >
}

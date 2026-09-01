// RFC-349 — the one-hop row needed to resolve one capability cell's effective
// parameters. Both provider adapters freeze the same projection.

export interface CapabilityParamSource {
  readonly paramSchemaJson: string
  readonly paramDefaultsJson: string
  readonly paramsJson: string
}

export interface CapabilityParamRead {
  find(input: {
    readonly repoId: string
    readonly capability: string
  }): Promise<CapabilityParamSource | null>
}

export interface UploadPlacementPlanRecord {
  readonly planId: string
  readonly planDigest: string
  readonly baselineSnapshotRef: string
  readonly baselineSha: string
  readonly entries: readonly {
    readonly fileId: string
    readonly uploadBlobRef: string
    readonly repositoryTargetPath: string
    readonly targetFileMode: string
    readonly expectedTargetKind: string
    readonly ordinal: number
  }[]
  readonly placementReceipt: {
    readonly seedTreeDigest: string | null
  } | null
}

export interface UploadPlacementPersistence {
  load(planId: string): Promise<UploadPlacementPlanRecord | null>
  record(input: {
    readonly id: string
    readonly planId: string
    readonly baselineSnapshotRef: string
    readonly seedChangeRef: string | null
    readonly seedTreeDigest: string
    readonly fulfillmentKind: string | null
    readonly commitSha: string | null
    readonly entriesJson: string
    readonly createdAt: number
  }): Promise<void>
}

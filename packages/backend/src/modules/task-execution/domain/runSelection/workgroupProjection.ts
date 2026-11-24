// RFC-570 — a workgroup host run's selection facts as data. Task Execution computes the selection (the run selection
// reader) and owns this projection; it lived in `platform/` only so Resource Catalog's room projection could name it,
// which now declares the two facts it reads as its own shape.

/** 数据投影可跨上下文传递；选择的计算由 task-execution query 提供。 */
export interface WorkgroupRunSelectionProjection {
  readonly slot: {
    readonly kind: 'workgroup-host'
    readonly nodeId: string
    readonly shardKey: string | null
  }
  readonly current: boolean
  /** 旧 budget/revival 的 null 与空 shard 同组口径，II-a 保留。 */
  readonly legacyGroupCurrent: boolean
  readonly sequence: number
}

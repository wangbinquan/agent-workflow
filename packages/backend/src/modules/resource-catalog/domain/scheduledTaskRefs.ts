/**
 * RFC-284 T9（§2.2）——「哪些 scheduled 行引用了这个资源」三副本的唯一实现。
 * agent（payload.agentId）/ workflow（payload.workflowId）/ workgroup
 * （payload.workgroupId）此前各自内联同形循环。损坏 payload 跳过（degraded
 * rows are repaired/deleted via their own flow），与三处原语义一致。
 *
 * 独立叶子模块（而非落 scheduledTasks.ts 本体）：scheduledTasks.ts 运行时
 * import workflow.ts（fire-time getWorkflow），workflow.ts 若反向 import 它
 * 即成环——本模块零 service 依赖，三个消费方与 scheduledTasks 的再导出面
 * 都指向这里。
 */
export function scheduledRowsReferencing<R extends { launchKind: string; launchPayload: string }>(
  rows: ReadonlyArray<R>,
  target: { launchKind: string; payloadKey: string; id: string },
): R[] {
  const out: R[] = []
  for (const row of rows) {
    if (row.launchKind !== target.launchKind) continue
    try {
      const p = JSON.parse(row.launchPayload) as Record<string, unknown>
      if (p[target.payloadKey] === target.id) out.push(row)
    } catch {
      /* skip degraded rows */
    }
  }
  return out
}

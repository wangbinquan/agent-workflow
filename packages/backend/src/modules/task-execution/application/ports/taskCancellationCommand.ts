// RFC-480: moved here from public/commands — only this module's composition and infrastructure name it.

/** Root or cascade cancellation with an explicit durable stop cause. */
export interface TaskCancellationCommand {
  cancel(input: {
    readonly taskId: string
    readonly cause:
      | Readonly<{ readonly kind: 'user' }>
      | Readonly<{ readonly kind: 'parent-cascade'; readonly parentTaskId: string }>
      /** 资源上限 / 空闲收割：原因文案随取消同一次写入落下。 */
      | Readonly<{
          readonly kind: 'resource-reaped'
          readonly summary: string
          readonly message: string
        }>
  }): Promise<void>
}

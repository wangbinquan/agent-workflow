/**
 * RFC-395 II-pre：跨工作区参与者共享的进程内物化租约。
 * 物化开始前登记，任务提交或清理结束后释放；维护扫描据此跳过在制目录。
 * 这里只存进程状态，不依赖业务上下文、数据库或文件系统。
 */
export const materializingSpaces = new Map<string, { dir: string; startedAt: number }>()

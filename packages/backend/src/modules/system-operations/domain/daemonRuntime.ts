/** Effective listener facts. pid is host diagnostics, not task-execution identity. */
export interface DaemonRuntimeInfo {
  pid: number
  host: string
  port: number
  url: string
  startedAt: string
}

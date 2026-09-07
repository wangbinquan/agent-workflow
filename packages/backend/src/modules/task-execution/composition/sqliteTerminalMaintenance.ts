// RFC-359 W7：终态维护认领的同步 SQLite store（`infrastructure/sqliteTerminalMaintenance.ts`）与它
// 私有的端口文件已随三条消费路径迁到中立事务原语而整体退役；这条 import 路径只剩类型再导出。
export type { RecoverableTerminalMaintenanceClaim } from '../application/ports/terminalMaintenanceStore'

// RFC-311 T20 —— 设置页「维护」区背后的两个端点：盘点与清理。
//
// 权限用 `settings:write`：盘点也走写权限，因为它把**主机路径与目录体积**告诉调用方
// （`~/.agent-workflow/opencode-stores` 及其字节数）——那是部署形态的信息，不该对
// 只读 actor 敞开。清理本身不可逆，与设置页其余「会删东西」的开关同一层边界。

import type { Hono } from 'hono'

import type { MaintenanceDiskOperations } from '@/modules/system-operations/public/operations'
import { registerRoute } from '@/routes/registry'

export function mountMaintenanceDiskRoutes(app: Hono, operations: MaintenanceDiskOperations): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/maintenance/disk',
      permissions: ['settings:write'],
      tokenAccess: 'allow',
      summary: 'Reclaimable disk space: retired runtime stores + DB freelist',
    },
    async (c) => c.json(await operations.report()),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/maintenance/disk/cleanup',
      permissions: ['settings:write'],
      tokenAccess: 'allow',
      summary: 'Delete the retired runtime store directory (irreversible)',
    },
    async (c) => c.json(await operations.cleanupRetiredStores()),
  )
}

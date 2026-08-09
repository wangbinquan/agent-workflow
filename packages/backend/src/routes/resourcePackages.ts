// RFC-271 T30/T31 —— 配置包的导出与导入路由。
//
// **路由门只做身份准入**（AC-30c）。导入端点挂六类 `*:read` 的 AND 会与逐条预检
// 自相矛盾：一个只含 agent 的包，凭什么要求调用方同时有 `mcps:read`？资源类型的
// 权限按**包内实际条目**动态算，那是业务层的事。
//
// 导出端点各挂自己那一类的 `*:read`——那是「能不能走这一类的路由」，与闭包内的
// 行级可见性是两回事（后者在 `walkExportClosure` 里，且**不**逐类校验 `*:read`，
// 见决策 24 / AC-7d 的反向锁）。

import type { Context, Hono } from 'hono'
import { ulid } from 'ulid'
import type { AclResourceType } from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { registerRoute } from '@/routes/registry'
import { exportResourcePackage } from '@/services/resourcePackage/export'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { buildPackagePreview } from '@/services/resourcePackage/preview'
import { commitResourcePackage, type ImportDecision } from '@/services/resourcePackage/commit'
import { ValidationError } from '@/util/errors'
import { z } from 'zod'

/** 线上形状由 Zod 把关——routes 里禁止用 `as T` 绕过校验（RFC-054 W1-7）。 */
const ImportDecisionsSchema = z.array(
  z
    .object({
      localSlug: z.string().min(1).max(128),
      action: z.enum(['new', 'reuse', 'overwrite']),
      targetId: z.string().min(1).max(64).optional(),
      finalName: z.string().min(1).max(256).optional(),
    })
    .strict(),
)

export interface ResourcePackageRouteDeps {
  db: DbClient
  appHome: string
  box: SecretBox
  pluginInstallOpts?: { pluginsDir?: string; npmBin?: string; timeoutMs?: number }
}

/**
 * 六条导出端点。
 *
 * ⚠️ **刻意展开成六条字面量注册，而不是 `for` 循环 + 模板路径**：契约注册表的覆盖
 * 守卫按 `path: '<字面量>'` 抓取，模板字符串对它完全不可见 —— 那样六条端点会静静
 * 地躺在守卫之外，而仓里对「守卫悄悄不再覆盖某物」的态度很明确。共享逻辑收在
 * `exportHandler` 里，重复的只是声明本身，那正是要被守卫看见的部分。
 */
function exportHandler(type: AclResourceType, deps: ResourcePackageRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const pkg = await exportResourcePackage(
      deps.db,
      actorOf(c),
      { type, id: c.req.param('id') ?? '' },
      { exportedAt: Date.now() },
    )
    return new Response(new Blob([pkg.zip]), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${pkg.filename}"`,
      },
    })
  }
}

export function registerResourcePackageRoutes(app: Hono, deps: ResourcePackageRouteDeps): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/agents/:id/export-package',
      permissions: ['agents:read'],
      tokenAccess: 'allow',
      summary: 'Export an agent with its transitive closure (config package)',
    },
    exportHandler('agent', deps),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/skills/:id/export-package',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'Export a skill with its transitive closure (config package)',
    },
    exportHandler('skill', deps),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/mcps/:id/export-package',
      permissions: ['mcps:read'],
      tokenAccess: 'allow',
      summary: 'Export an MCP with its transitive closure (config package)',
    },
    exportHandler('mcp', deps),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/plugins/:id/export-package',
      permissions: ['plugins:read'],
      tokenAccess: 'allow',
      summary: 'Export a plugin with its transitive closure (config package)',
    },
    exportHandler('plugin', deps),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/workflows/:id/export-package',
      permissions: ['workflows:read'],
      tokenAccess: 'allow',
      summary: 'Export a workflow with its transitive closure (config package)',
    },
    exportHandler('workflow', deps),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/workgroups/:id/export-package',
      permissions: ['workgroups:read'],
      tokenAccess: 'allow',
      summary: 'Export a workgroup with its transitive closure (config package)',
    },
    exportHandler('workgroup', deps),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/resource-packages/preview',
      // ⚠️ **只做身份准入**（AC-30c）。挂六类 `*:read` 的 AND 会与逐条预检自相
      // 矛盾：一个只含 agent 的包，凭什么要求调用方同时有 `mcps:read`？
      permissions: [],
      publicReason:
        'no resource-type point: the package decides which types it touches and the per-entry preview computes those permissions itself. Identity is still REQUIRED — this path is not in multiAuth PUBLIC_PATH_PREFIXES, so an unauthenticated caller is rejected before the handler runs.',
      tokenAccess: 'allow',
      summary: 'Inspect a config package against this instance (no writes)',
    },
    async (c) => {
      const pkg = await parseResourcePackage(await readUpload(c))
      return c.json(
        await buildPackagePreview(deps.db, actorOf(c), pkg, { box: deps.box, importId: ulid() }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/resource-packages/commit',
      // 同上——**写**权限由业务层按包内条目逐条判（`allowedActions` 服务端重算，
      // 且「别人的资源不给 overwrite」在那里定死）。
      permissions: [],
      publicReason:
        'no resource-type point: the decisions decide which rows are touched and the server recomputes allowedActions per entry. Identity is still REQUIRED — this path is not in multiAuth PUBLIC_PATH_PREFIXES.',
      tokenAccess: 'allow',
      summary: 'Apply a previewed config package',
    },
    async (c) => {
      const form = await c.req.formData()
      const file = form.get('file')
      if (!(file instanceof File)) {
        throw new ValidationError('package-invalid', 'multipart field `file` is required')
      }
      const previewToken = String(form.get('previewToken') ?? '')
      if (previewToken.length === 0) {
        throw new ValidationError('package-invalid', 'multipart field `previewToken` is required')
      }
      let rawDecisions: unknown
      try {
        rawDecisions = JSON.parse(String(form.get('decisions') ?? '[]'))
      } catch {
        throw new ValidationError('package-invalid', '`decisions` is not valid JSON')
      }
      const parsed = ImportDecisionsSchema.safeParse(rawDecisions)
      if (!parsed.success) {
        throw new ValidationError('package-invalid', '`decisions` has an invalid shape', {
          issues: parsed.error.issues,
        })
      }
      const decisions: ImportDecision[] = parsed.data
      const pkg = await parseResourcePackage(new Uint8Array(await file.arrayBuffer()))
      return c.json(
        await commitResourcePackage(
          {
            db: deps.db,
            appHome: deps.appHome,
            box: deps.box,
            ...(deps.pluginInstallOpts === undefined
              ? {}
              : { pluginInstallOpts: deps.pluginInstallOpts }),
          },
          actorOf(c),
          { pkg, previewToken, decisions },
        ),
      )
    },
  )
}

async function readUpload(c: Context): Promise<Uint8Array> {
  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    throw new ValidationError('package-invalid', 'multipart field `file` is required')
  }
  return new Uint8Array(await file.arrayBuffer())
}

// RFC-271 T30/T31 —— 配置包的导出与导入路由。
//
// **路由门只做身份准入**（AC-30c）。导入端点挂六类 `*:read` 的 AND 会与逐条预检
// 自相矛盾：一个只含 agent 的包，凭什么要求调用方同时有 `mcps:read`？资源类型的
// 权限按**包内实际条目**动态算，那是业务层的事。
//
// 导出端点各挂自己那一类的 `*:read`——那是「能不能走这一类的路由」，与闭包内的
// 行级可见性是两回事（后者在 `walkExportClosure` 里，且**不**逐类校验 `*:read`，
// 见决策 24 / AC-7d 的反向锁）。

import type { Context, Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ulid } from 'ulid'
import { SKILL_ZIP_LIMITS, type AclResourceType } from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { registerRoute } from '@/routes/registry'
import { exportResourcePackage } from '@/services/resourcePackage/export'
import { PackageSecretRefSchema, parseResourcePackage } from '@/services/resourcePackage/parse'
import { buildPackagePreview } from '@/services/resourcePackage/preview'
import {
  commitResourcePackage,
  type HumanMemberMapping,
  type ImportDecision,
} from '@/services/resourcePackage/commit'
import type { PackageSecretInput } from '@/services/resourcePackage/secretInputs'
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

/** human 成员映射：每个 `(workgroupSlug, username)` 一条；`null` = 其全部 alias 不加入。 */
const HumanMemberMappingsSchema = z.array(
  z
    .object({
      workgroupSlug: z.string().min(1).max(128),
      username: z.string().min(1).max(64),
      userId: z.string().min(1).max(64).nullable().optional(),
    })
    .strict(),
)

const PackageSecretInputsSchema = z.array(
  PackageSecretRefSchema.extend({ value: z.string() }).strict(),
)

// A valid package may use the entire compressed-ZIP allowance. Leave bounded
// room for multipart framing plus commit decisions/mappings/secrets, while
// ensuring an attacker can never make `formData()` materialise an unbounded
// request body.
export const RESOURCE_PACKAGE_BODY_MAX_BYTES = SKILL_ZIP_LIMITS.totalBytes + 4 * 1024 * 1024

function packageBodyTooLarge(c: Context): Response {
  return c.json(
    {
      ok: false as const,
      code: 'zip-limit-exceeded',
      message: `resource package request exceeds ${RESOURCE_PACKAGE_BODY_MAX_BYTES} bytes`,
    },
    413,
  )
}

const honoResourcePackageBodyLimit = bodyLimit({
  maxSize: RESOURCE_PACKAGE_BODY_MAX_BYTES,
  onError: packageBodyTooLarge,
})

/**
 * Hono's built-in limit takes the fast path when Content-Length is present: it
 * rejects an oversized declaration, but otherwise trusts the declaration and
 * does not count the stream. Keep the fail-fast branch, then remove an accepted
 * length before delegating so Hono also counts actual bytes. This closes the
 * understated/malformed Content-Length bypass without duplicating its bounded
 * stream buffering and Request reconstruction.
 */
const resourcePackageBodyLimit: MiddlewareHandler = async (c, next) => {
  const raw = c.req.raw
  const contentLength = raw.headers.get('content-length')
  const hasTransferEncoding = raw.headers.has('transfer-encoding')
  if (contentLength !== null && !hasTransferEncoding) {
    const parsedLength = Number(contentLength)
    if (
      !/^\d+$/.test(contentLength) ||
      !Number.isSafeInteger(parsedLength) ||
      parsedLength > RESOURCE_PACKAGE_BODY_MAX_BYTES
    ) {
      return packageBodyTooLarge(c)
    }

    if (raw.body !== null) {
      const headers = new Headers(raw.headers)
      headers.delete('content-length')
      const requestInit: RequestInit & { duplex: 'half' } = {
        headers,
        body: raw.body,
        duplex: 'half',
      }
      c.req.raw = new Request(raw, requestInit)
    }
  }
  return honoResourcePackageBodyLimit(c, next)
}

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
/**
 * exact-revision fence 的 query 参数 —— **六类各自的完整形态**（AC-12）。
 *
 * 数值型（version / updatedAt / aclRevision / contentVersion / metaRevision）必须是
 * 非负整数；写错的值是**拒绝**而不是当没给：静默忽略一个写错的 fence，等于用户以为
 * 有保护而实际没有。服务端还会校验「给了就必须给全该类型的所有字段」。
 */
/**
 * 数值型 fence 逐字段的**取值域**——不能一刀切「非负整数」。
 *
 * `version` / `contentVersion` 是从 1 起的计数（正式 schema 就是
 * `z.number().int().positive()`），0 是一个**不可能存在**的值；而 `aclRevision` /
 * `metaRevision` 从 0 起，0 是合法初值。用同一条规则会两头错：要么把合法的 0 拒掉，
 * 要么把不可能的 version 0 放进去，让它去比出一个假的 409。
 */
const FENCE_NUMERIC: ReadonlyArray<{ key: string; min: 0 | 1 }> = [
  { key: 'expectedVersion', min: 1 },
  { key: 'expectedContentVersion', min: 1 },
  { key: 'expectedUpdatedAt', min: 0 },
  { key: 'expectedAclRevision', min: 0 },
  { key: 'expectedMetaRevision', min: 0 },
]
const FENCE_STRING = ['expectedConfigHash'] as const

function parseRootFence(c: Context): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { key, min } of FENCE_NUMERIC) {
    const raw = c.req.query(key)
    if (raw === undefined) continue
    // ⚠️ **不能把解析交给 `z.coerce.number()`**：它走的是 `Number(raw)`，而
    // `Number('')` 与 `Number(' ')` 都是 **0**。于是 `?expectedVersion=` 和
    // `?expectedVersion=%20` 都会被悄悄转成一个看起来合法的 fence 值 0，拿去比 version
    // 稳定不相等 ⇒ 409「资源已变更」。用户什么都没传，却收到一条说资源被别人改了的错
    // ——比静默放行更难排查。
    //
    // 第一版只挡了逐字空串，`%20` 照样漏过（实现门第四轮实测）。所以这里改成**先按
    // 字面量判**：只接受纯十进制数字串，任何空白 / 符号 / 小数点一律拒。
    if (!/^\d+$/.test(raw)) {
      throw new ValidationError(
        'package-invalid',
        `${key} must be a decimal integer (got ${JSON.stringify(raw)})`,
      )
    }
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < min) {
      throw new ValidationError(
        'package-invalid',
        `${key} must be an integer >= ${min} (got ${raw})`,
      )
    }
    out[key] = value
  }
  for (const key of FENCE_STRING) {
    const raw = c.req.query(key)
    if (raw === undefined) continue
    // 显式传了却是空 ⇒ 拒绝，**不能**当成「没传」。
    //
    // 静默降级是这里最坏的一档：`?expectedConfigHash=` 会返回 200 + 一个完全没有
    // 保护的 zip，而 `?expectedConfigHash=wrong` 才 409。调用方（尤其是拼 URL 时
    // 变量取空的前端）会以为自己有「所见非所得」防护，实际什么都没有。
    if (raw === '') {
      throw new ValidationError('package-invalid', `${key} must not be empty`)
    }
    out[key] = raw
  }
  return out
}

function exportHandler(type: AclResourceType, deps: ResourcePackageRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const pkg = await exportResourcePackage(
      deps.db,
      actorOf(c),
      { type, id: c.req.param('id') ?? '' },
      {
        appHome: deps.appHome,
        exportedAt: Date.now(),
        // 客户端「所见非所得」revision 只针对 root；导出器会自行复核整棵闭包在
        // 本次读取期间没有变化，客户端不需要预先知道传递成员。
        expect: parseRootFence(c),
      },
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
    resourcePackageBodyLimit,
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
    resourcePackageBodyLimit,
    async (c) => {
      const form = await readMultipart(c)
      const file = packageFile(form)
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
      // 工作组的 human 成员：包里带的是源实例 username，本机绑谁由用户逐个选。
      let rawMappings: unknown
      try {
        rawMappings = JSON.parse(String(form.get('humanMemberMappings') ?? '[]'))
      } catch {
        throw new ValidationError('package-invalid', '`humanMemberMappings` is not valid JSON')
      }
      const parsedMappings = HumanMemberMappingsSchema.safeParse(rawMappings)
      if (!parsedMappings.success) {
        throw new ValidationError('package-invalid', '`humanMemberMappings` has an invalid shape', {
          issues: parsedMappings.error.issues,
        })
      }
      const humanMemberMappings: HumanMemberMapping[] = parsedMappings.data
      let rawSecretInputs: unknown
      try {
        rawSecretInputs = JSON.parse(String(form.get('secretInputs') ?? '[]'))
      } catch {
        throw new ValidationError('package-invalid', '`secretInputs` is not valid JSON')
      }
      const parsedSecretInputs = PackageSecretInputsSchema.safeParse(rawSecretInputs)
      if (!parsedSecretInputs.success) {
        throw new ValidationError('package-invalid', '`secretInputs` has an invalid shape', {
          issues: parsedSecretInputs.error.issues,
        })
      }
      const secretInputs: PackageSecretInput[] = parsedSecretInputs.data
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
          { pkg, previewToken, decisions, humanMemberMappings, secretInputs },
        ),
      )
    },
  )
}

async function readUpload(c: Context): Promise<Uint8Array> {
  const form = await readMultipart(c)
  const file = packageFile(form)
  return new Uint8Array(await file.arrayBuffer())
}

async function readMultipart(c: Context): Promise<FormData> {
  try {
    return await c.req.formData()
  } catch (err) {
    throw new ValidationError(
      'package-invalid',
      `failed to parse multipart body: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function packageFile(form: FormData): File {
  const file = form.get('file')
  if (!(file instanceof File)) {
    throw new ValidationError('package-invalid', 'multipart field `file` is required')
  }
  if (file.size > SKILL_ZIP_LIMITS.totalBytes) {
    throw new ValidationError(
      'zip-limit-exceeded',
      `uploaded package exceeds ${SKILL_ZIP_LIMITS.totalBytes} bytes`,
    )
  }
  return file
}

// RFC-271 T25 —— 解包：zip → manifest + bundle + 技能文件载体。
//
// 三件事：
//   ① 复用 `decodeZip` 做归一化与 zip-slip / 体积守卫（不另起一套）；
//   ② **防夹带**：包里出现任何未在 manifest / bundle 里登记的条目 ⇒ 拒绝。
//      不做这条，攻击者可以往包里塞一个 `../../.ssh/authorized_keys`——虽然
//      `decodeZip` 已经拦了路径穿越，但「登记之外的文件」本身就说明这个包不是
//      我们的格式产出的，与其逐个猜它想干嘛，不如整体拒绝；
//   ③ `formatVersion` 比当前**高**就拒绝——低版本的解析器读高版本的包，最好的
//      结果是丢字段，最坏的是把新语义误解成旧语义。

import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  AclResourceTypeSchema,
  BundleSchema,
  collectBundleRefIssues,
  type ResourceBundle,
} from '@agent-workflow/shared'
import { decodeZip } from '@/services/skill-zip'
import { resourceTypeOfOp } from '@/services/bundle/provider'
import { ValidationError } from '@/util/errors'
import { PACKAGE_FORMAT_VERSION } from './export'

const ManifestResourceSchema = z
  .object({
    slug: z.string().min(1),
    type: AclResourceTypeSchema,
    name: z.string().min(1),
  })
  .strict()

export const PackageSecretRefSchema = z
  .object({
    resourceType: AclResourceTypeSchema,
    resourceName: z.string().min(1),
    field: z.string().min(1),
  })
  .strict()

const PackageRequirementsSchema = z
  .object({
    runtimes: z.array(z.string()).optional().default([]),
    codeHosts: z.array(z.string()).optional().default([]),
    executables: z.array(z.string()).optional().default([]),
    pluginSources: z
      .array(z.object({ name: z.string(), spec: z.string(), sourceKind: z.string() }).strict())
      .optional()
      .default([]),
    projectSkills: z.array(z.string()).optional().default([]),
    // Additive diagnostics already emitted by the implementation.
    mcpKinds: z.array(z.string()).optional().default([]),
    humanMembers: z.array(z.string()).optional().default([]),
  })
  .strict()

export const PackageManifestSchema = z
  .object({
    formatVersion: z.number().int().positive(),
    exportedAt: z.number().int().nonnegative(),
    root: ManifestResourceSchema,
    resources: z.array(ManifestResourceSchema),
    requirements: PackageRequirementsSchema,
    secrets: z.array(PackageSecretRefSchema),
    danglingCallRefs: z.array(z.unknown()).optional().default([]),
    /**
     * 框架 built-in 依赖（`builtin:<type>/<name>` 指向的那些）。它们**不入
     * `resources`、不产 op**，导入时按名字绑到对端自己 seed 的那一个。
     *
     * `optional` 是为了**向后兼容**：这个字段之前的包没有它，那些包里也不会出现
     * `builtin:` 引用，所以缺省空数组是安全的。
     */
    builtins: z
      .array(z.object({ type: z.string(), name: z.string() }).strict())
      .optional()
      .default([]),
  })
  .strict()

export type PackageManifest = z.infer<typeof PackageManifestSchema>

export interface ParsedPackage {
  manifest: PackageManifest
  bundle: ResourceBundle
  /** 包内技能文件：`ref` → 字节。`readSkillFile` 从这里取。 */
  files: Map<string, Uint8Array>
  /** 整包字节的摘要，进 previewToken 的签名面。 */
  digest: string
}

const MANIFEST = 'manifest.yaml'
const BUNDLE = 'bundle.json'
const README = 'README.md'

export async function parseResourcePackage(zip: Uint8Array): Promise<ParsedPackage> {
  const entries = decodeZip(zip).filter((e) => !e.isDir)
  const byPath = new Map(entries.map((e) => [e.path, e]))

  const manifestEntry = byPath.get(MANIFEST)
  const bundleEntry = byPath.get(BUNDLE)
  if (manifestEntry === undefined || bundleEntry === undefined) {
    throw new ValidationError('package-invalid', `package must contain ${MANIFEST} and ${BUNDLE}`)
  }

  let rawManifest: unknown
  try {
    rawManifest = parseYaml(new TextDecoder().decode(manifestEntry.bytes()))
  } catch {
    // Upload syntax errors are caller input, not an internal server failure. Do not let the
    // parser-specific YAMLParseError escape to the HTTP boundary where it would become a 500.
    throw new ValidationError('package-invalid', 'manifest.yaml is not valid YAML')
  }
  if (typeof rawManifest !== 'object' || rawManifest === null) {
    throw new ValidationError('package-invalid', 'manifest.yaml is not a mapping')
  }
  const formatVersion = (rawManifest as { formatVersion?: unknown }).formatVersion
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
    throw new ValidationError('package-invalid', 'manifest.formatVersion is missing')
  }
  if (formatVersion > PACKAGE_FORMAT_VERSION) {
    throw new ValidationError(
      'package-format-unsupported',
      `package format version ${formatVersion} is newer than this instance supports (${PACKAGE_FORMAT_VERSION}); upgrade before importing`,
    )
  }
  const parsedManifest = PackageManifestSchema.safeParse(rawManifest)
  if (!parsedManifest.success) {
    throw new ValidationError('package-invalid', 'manifest.yaml has an invalid shape', {
      issues: parsedManifest.error.issues,
    })
  }
  const manifest = parsedManifest.data

  let bundle: ResourceBundle
  try {
    bundle = BundleSchema.parse(JSON.parse(new TextDecoder().decode(bundleEntry.bytes())))
  } catch (err) {
    throw new ValidationError(
      'package-invalid',
      `bundle.json is not a valid resource bundle: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const issues = collectBundleRefIssues(bundle)
  if (issues.length > 0) {
    throw new ValidationError('package-invalid', `bundle.json has reference issues`, {
      issues,
    })
  }

  assertManifestMatchesBundle(manifest, bundle)

  // ② 防夹带：登记面 = 三个固定条目 + bundle 里声明过的技能文件 ref。
  const declared = new Set<string>([MANIFEST, BUNDLE, README])
  for (const op of bundle.ops) {
    if (op.kind !== 'skill-create' && op.kind !== 'skill-update') continue
    for (const file of (op.payload as { files?: Array<{ ref?: unknown }> }).files ?? []) {
      if (typeof file.ref === 'string') declared.add(file.ref)
    }
  }
  const unlisted = entries.map((e) => e.path).filter((p) => !declared.has(p))
  if (unlisted.length > 0) {
    throw new ValidationError(
      'package-unlisted-entry',
      `package contains ${unlisted.length} entr${unlisted.length === 1 ? 'y' : 'ies'} not declared by its manifest: ${unlisted.slice(0, 5).join(', ')}`,
    )
  }

  const files = new Map<string, Uint8Array>()
  for (const [path, entry] of byPath) {
    if (path === MANIFEST || path === BUNDLE || path === README) continue
    files.set(path, entry.bytes())
  }

  return { manifest, bundle, files, digest: await digestOf(zip) }
}

function assertManifestMatchesBundle(manifest: PackageManifest, bundle: ResourceBundle): void {
  const declared = manifest.resources
    .map((resource) => `${resource.type}\u0000${resource.slug}\u0000${resource.name}`)
    .sort()
  const actual = bundle.ops
    .flatMap((op) => {
      if (!('slug' in op)) return []
      const name = (op.payload as { name?: unknown }).name
      return typeof name === 'string'
        ? [`${resourceTypeOfOp(op)}\u0000${op.slug}\u0000${name}`]
        : []
    })
    .sort()
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    throw new ValidationError(
      'package-invalid',
      'manifest.resources does not match the resources declared by bundle.json',
    )
  }

  if (bundle.rootRef === undefined) {
    throw new ValidationError('package-invalid', 'a config package must declare a rootRef')
  }
  // 框架 built-in 作为根：它**不产 create op、也不进 `manifest.resources`**（导入侧
  // 自动忽略、按名字绑对端自己那一个），所以下面「root 必须出现在 resources 里」的
  // 对照对它不适用。只核对 manifest.root 与 rootRef 声明的是同一个 (type, name)。
  if (bundle.rootRef.startsWith('builtin:')) {
    const spec = bundle.rootRef.slice('builtin:'.length)
    const slash = spec.indexOf('/')
    const type = slash < 0 ? '' : spec.slice(0, slash)
    const name = slash < 0 ? '' : spec.slice(slash + 1)
    if (manifest.root.type !== type || manifest.root.name !== name) {
      throw new ValidationError(
        'package-invalid',
        'manifest.root does not match the builtin rootRef in bundle.json',
      )
    }
    return
  }
  if (!bundle.rootRef.startsWith('local:')) {
    throw new ValidationError('package-invalid', 'a config package must declare a local rootRef')
  }
  const rootSlug = bundle.rootRef.slice('local:'.length)
  const root = manifest.resources.find((resource) => resource.slug === rootSlug)
  if (
    root === undefined ||
    root.slug !== manifest.root.slug ||
    root.type !== manifest.root.type ||
    root.name !== manifest.root.name
  ) {
    throw new ValidationError(
      'package-invalid',
      'manifest.root does not match bundle.json rootRef and resources',
    )
  }
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

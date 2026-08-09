// RFC-271 — 配置包的脱敏投影。
//
// **产物必须仍然过它自己的严格 schema**（AC-6）。这是与 `intentSecretSlots.ts` 的
// dump 投影的根本区别，R2-D1 查出的三个反例：
//
//   · projectMcpForDump 输出 `oauth: '‹redacted›'` —— 是**字符串**，而
//     McpRemoteConfigSchema 要求对象或 false ⇒ 产物过不了自己的 schema。
//   · 它把 argv 改成 `‹redacted›-arg-N` ⇒ 摧毁真实命令，导入后跑不起来。
//   · redactUrlForDump 会追加 " (‹redacted›: userinfo/query stripped)" ⇒ 产物
//     不再是合法 URL，而 McpRemoteConfigSchema 要求 http(s) 开头。
//
// 那是**展示**投影（给模型看形状、绝不给值）；这里要的是**可导入**投影。
// 所以复用它的**载体知识**（SECRET_KEY_RE / looksHighEntropy）而**不复用**投影函数。
//
// 范围边界（决策 18）：只处理**结构化字段**。技能文件树内容不扫描——那属于技能
// 作者的责任，已在 proposal §3 列为非目标。

import { looksHighEntropy, SECRET_KEY_RE } from '../intentSecretSlots'

/** 脱敏后的占位值。导入侧遇到它一律当「未提供」，绝不写成字面量。 */
export const PACKAGE_SECRET_PLACEHOLDER = '<REDACTED:SECRET>'

/**
 * 自由 JSON 密钥位置的无歧义编码。
 *
 * 字符串 segment 表示对象 key，数字 segment 表示数组下标。因此字面 key `a.b`、
 * `items[0]`、`0` 不会再和结构路径碰撞。前缀也让导入侧可以同时索引旧的点号路径。
 */
export const PACKAGE_SECRET_FIELD_SEGMENTS_PREFIX = 'segments:'
export type PackageSecretFieldSegment = string | number

export function encodePackageSecretFieldSegments(
  segments: readonly PackageSecretFieldSegment[],
): string {
  return `${PACKAGE_SECRET_FIELD_SEGMENTS_PREFIX}${JSON.stringify(segments)}`
}

/** shared 的 tsconfig 不带 DOM/Node lib —— 沿用 intentSecretSlots.ts 的本地结构声明。 */
interface UrlLike {
  username: string
  password: string
  searchParams: {
    keys(): IterableIterator<string>
    get(k: string): string | null
    set(k: string, v: string): void
  }
  toString(): string
}

/** 一条待填密钥的索引项（manifest.secrets 的元素）。 */
export interface PackageSecretRef {
  resourceType: string
  resourceName: string
  /** 固定 carrier 沿用点号路径；自由 JSON 使用带类型的 `segments:[...]` 路径。 */
  field: string
}

export interface RedactionSink {
  resourceType: string
  resourceName: string
  found: PackageSecretRef[]
}

function note(sink: RedactionSink, field: string): void {
  sink.found.push({
    resourceType: sink.resourceType,
    resourceName: sink.resourceName,
    field,
  })
}

/** 值是否该被当成密钥：键名命中 SECRET_KEY_RE，或值本身高熵。 */
export function isSecretish(key: string, value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  if (SECRET_KEY_RE.test(key)) return true
  return looksHighEntropy(value)
}

/** 键保留、值收敛。用于 env / headers 这类 Record<string,string>。 */
export function redactRecord(
  rec: Record<string, string> | undefined,
  sink: RedactionSink,
  fieldPrefix: string,
): Record<string, string> | undefined {
  if (rec === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec)) {
    // env / headers 是公认的密钥载体：**整体收敛**，不逐个判熵——一个叫 `MODE` 的
    // 环境变量也可能装着 token，而键名判据对它无能为力。
    out[k] = PACKAGE_SECRET_PLACEHOLDER
    note(sink, `${fieldPrefix}.${k}`)
    void v
  }
  return out
}

/**
 * argv 脱敏：**只替换命中的那一个 token，结构与长度不变**。
 * ⚠️ 不能像 dump 投影那样把 argv[1..] 全改成占位——那会摧毁真实命令。
 */
export function redactArgv(argv: readonly string[], sink: RedactionSink): string[] {
  const out = [...argv]
  let parseFlags = true
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--') {
      parseFlags = false
      continue
    }
    // `--token=ghp_xxx` / `--token ghp_xxx` 两种形态
    const eq = arg.indexOf('=')
    if (parseFlags && eq > 0) {
      const key = arg.slice(0, eq)
      const value = arg.slice(eq + 1)
      if (isSecretish(key, value)) {
        note(sink, `config.command[${i}]`)
        out[i] = `${key}=${PACKAGE_SECRET_PLACEHOLDER}`
      }
      continue
    }
    if (parseFlags && isSecretFlag(arg)) {
      const next = argv[i + 1]
      // 缺值或下一项已经是另一个 flag 时，不能把 flag 本身吞成 secret value。
      if (next !== undefined && next.length > 0 && !isCommandFlag(next)) {
        note(sink, `config.command[${i + 1}]`)
        out[i + 1] = PACKAGE_SECRET_PLACEHOLDER
        i += 1
      }
      continue
    }
    if (looksHighEntropy(arg)) {
      note(sink, `config.command[${i}]`)
      out[i] = PACKAGE_SECRET_PLACEHOLDER
    }
  }
  return out
}

function isSecretFlag(arg: string): boolean {
  if (!isCommandFlag(arg) || arg.includes('=')) return false
  const name = arg.slice(arg.startsWith('--') ? 2 : 1)
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').split(/[^a-z0-9]+/i)
  return words.some((word) =>
    /^(?:token|secret|key|password|passwd|credential|auth|api(?:token|secret|key)|access(?:token|key)|client(?:secret|key))$/i.test(
      word,
    ),
  )
}

function isCommandFlag(arg: string): boolean {
  return arg === '--' || /^-{1,2}[^-\s]/.test(arg)
}

/**
 * URL 脱敏：**只换值，URL 仍是合法 http(s) URL**。
 * ⚠️ 不复用 redactUrlForDump——它会追加说明文字并删掉整个 query，产物过不了
 * `McpRemoteConfigSchema` 的 `startsWith('http')` 判据与后续 URL 解析。
 */
export function redactUrlKeepingShape(raw: string, sink: RedactionSink, field: string): string {
  try {
    const UrlCtor = (globalThis as unknown as { URL: new (raw: string) => UrlLike }).URL
    const u = new UrlCtor(raw)
    let touched = false
    if (u.username !== '' || u.password !== '') {
      // ⚠️ userinfo **整段剥掉**，不塞占位符：URL 的 userinfo 位会把占位符
      // percent-encode 成 `%3CREDACTED%3ASECRET%3E`，既不可读也不再等于占位符。
      // 而这里本来也没有「键」需要保留（不像 env/headers），导入方必须重新填。
      u.username = ''
      u.password = ''
      touched = true
    }
    for (const key of [...u.searchParams.keys()]) {
      const value = u.searchParams.get(key)
      if (value !== null && isSecretish(key, value)) {
        u.searchParams.set(key, PACKAGE_SECRET_PLACEHOLDER)
        touched = true
      }
    }
    if (touched) note(sink, field)
    return u.toString()
  } catch {
    // 解析不了就整体收敛——但**保持它是个 http URL**，否则 schema 过不了。
    note(sink, field)
    return `https://${PACKAGE_SECRET_PLACEHOLDER}/`
  }
}

/** 自由 JSON（frontmatterExtra / plugin options / 工作流 passthrough）。 */
export function redactFreeJson(value: unknown, sink: RedactionSink, pointer: string): unknown {
  return redactFreeJsonAt(value, sink, [pointer])
}

function redactFreeJsonAt(
  value: unknown,
  sink: RedactionSink,
  segments: readonly PackageSecretFieldSegment[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((v, i) => redactFreeJsonAt(v, sink, [...segments, i]))
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretish(k, v)) {
        out[k] = PACKAGE_SECRET_PLACEHOLDER
        note(sink, encodePackageSecretFieldSegments([...segments, k]))
        continue
      }
      out[k] = redactFreeJsonAt(v, sink, [...segments, k])
    }
    return out
  }
  return value
}

/**
 * plugin spec：git URL 里可能内嵌凭据。
 * ⚠️ `requirements.pluginSources.spec` 走**同一条**（AC-10：requirements 不含任何密钥）。
 */
export function redactPluginSpec(spec: string, sink: RedactionSink): string {
  if (!spec.includes('://')) return spec // npm 包名等，无凭据面
  return redactUrlKeepingShape(spec, sink, 'spec')
}

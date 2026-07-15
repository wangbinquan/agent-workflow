// RFC-060 PR-A — AgentOutputKind 字符串字面值解析器。
//
// 升级前：AgentOutputKind 是 'string' | 'markdown' | 'markdown_file' 三选枚举
// （`schemas/review.ts`），handler 按字面字符串注册。
//
// 升级后：字符串字面值可表达参数化 kind：
//
//   base       ::= [a-z][a-z0-9_]*           // 'string' | 'markdown' | 'signal' | ...
//   parametric ::= 'path' '<' ext '>'        // path<*>, path<md>, path<markdown>
//                | 'list' '<' kind '>'       // list<path<md>>, list<string>, list<list<int>>
//   ext        ::= '*' | [a-z][a-z0-9]*      // wildcard or simple ext name (no dot)
//
// 兼容别名：字面值 'markdown_file' 解析为 { kind: 'path', ext: 'md' }，与
// `path<md>` 等价；用于保留 RFC-049 + 历史 agent.md frontmatter 文件 + YAML
// fixture 的 round-trip 读取能力。stringifyKind 永远不会输出 'markdown_file'，
// 仓库内部统一输出 'path<md>'——逐步替换历史字面值时不要把它再倒回去。
//
// 解析失败抛 KindParseError；调用方负责把它转成 validator 的
// `agent-output-kind-malformed` 错误码或上层 toast。

export type ParsedKind =
  | { kind: 'base'; name: string }
  | { kind: 'path'; ext: '*' | string }
  | { kind: 'list'; item: ParsedKind }

export class KindParseError extends Error {
  constructor(
    message: string,
    public readonly input: string,
  ) {
    super(message)
    this.name = 'KindParseError'
  }
}

// 命名规则：base/路径段名只允许小写字母 + 数字 + 下划线；首字符必须字母。
const BASE_NAME_RE = /^[a-z][a-z0-9_]*$/
// path 的 ext 段：'*' 通配或简单单词（无下划线，无点号——dot 由 handler 自加）。
const PATH_EXT_RE = /^[a-z][a-z0-9]*$/

/**
 * Parse a kind string into a ParsedKind tree.
 *
 * Idempotent: `stringifyKind(parseKind(s))` is byte-equal to a normalized
 * form of `s` (whitespace stripped, alias 'markdown_file' replaced by
 * 'path<md>'). For arbitrary roundtrips use this contract:
 *
 *   parseKind(stringifyKind(p)) deep-equals p
 *
 * Inputs that don't satisfy the grammar throw KindParseError.
 */
export function parseKind(text: string): ParsedKind {
  if (typeof text !== 'string') {
    throw new KindParseError(`kind must be a string, got ${typeof text}`, String(text))
  }
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw new KindParseError('kind string is empty', text)
  }
  // 别名：markdown_file ≡ path<md>。此分支必须在 BASE_NAME_RE 判断前——
  // markdown_file 字面值匹配 BASE_NAME_RE，但语义上是 path<md>。
  if (trimmed === 'markdown_file') {
    return { kind: 'path', ext: 'md' }
  }

  const ltIdx = trimmed.indexOf('<')
  if (ltIdx === -1) {
    // 没有 '<' → 必为 base kind。
    if (!BASE_NAME_RE.test(trimmed)) {
      throw new KindParseError(`invalid base kind name '${text}'`, text)
    }
    return { kind: 'base', name: trimmed }
  }

  // 有 '<' → parametric kind。要求 head 形如 BASE_NAME_RE，末尾必须 '>'。
  if (!trimmed.endsWith('>')) {
    throw new KindParseError(`expected '>' at end of '${text}'`, text)
  }
  const head = trimmed.slice(0, ltIdx)
  const body = trimmed.slice(ltIdx + 1, -1)
  if (head.length === 0) {
    throw new KindParseError(`missing parametric kind head before '<' in '${text}'`, text)
  }
  if (!BASE_NAME_RE.test(head)) {
    throw new KindParseError(`invalid parametric kind head '${head}' in '${text}'`, text)
  }
  // body 内必须括号配平——否则下面把 list<int>> 误读成 list<int> + trailing >。
  if (!bracketsBalanced(body)) {
    throw new KindParseError(`unbalanced '<' / '>' inside '${text}'`, text)
  }

  if (head === 'list') {
    if (body.trim().length === 0) {
      throw new KindParseError(`list<...> body is empty in '${text}'`, text)
    }
    return { kind: 'list', item: parseKind(body) }
  }
  if (head === 'path') {
    const bt = body.trim()
    if (bt === '*') return { kind: 'path', ext: '*' }
    if (PATH_EXT_RE.test(bt)) return { kind: 'path', ext: bt }
    throw new KindParseError(`invalid path ext '${body}' in '${text}'`, text)
  }
  throw new KindParseError(`unknown parametric kind head '${head}' in '${text}'`, text)
}

/**
 * Render a ParsedKind tree back to its canonical string form.
 *
 * Canonical form: no whitespace, alias 'markdown_file' never emitted (always
 * 'path<md>' so the repository converges on a single representation).
 */
export function stringifyKind(k: ParsedKind): string {
  switch (k.kind) {
    case 'base':
      return k.name
    case 'path':
      return `path<${k.ext}>`
    case 'list':
      return `list<${stringifyKind(k.item)}>`
  }
}

/**
 * `parseKind` wrapper that never throws — returns null on malformed input.
 * Use this on hot validation paths where you'd rather get a boolean than
 * pay for an exception throw + catch.
 */
export function tryParseKind(text: string): ParsedKind | null {
  try {
    return parseKind(text)
  } catch {
    return null
  }
}

/**
 * True if the given kind string parses (syntax-only check). Use this for
 * places that only need to ensure the input is grammatically a kind
 * expression — not for full AgentOutputKind admission, which also checks the
 * base name allowlist (see `isRegisteredKindString`).
 */
export function isValidKindString(text: string): boolean {
  return tryParseKind(text) !== null
}

/**
 * Canonicalize a kind string for PERSISTENCE（flag-audit §8 决策，用户
 * 2026-07-07）：解析后重新 stringify——别名 'markdown_file' 折叠为 'path<md>'、
 * 空白剥离；解析不了的字符串原样返回（防御：未知值照旧透传，行为不变）。
 * node_run_outputs.kind 的所有写入点必须过这一层，别再把 agent frontmatter
 * 里的 legacy 别名倒灌进库（migration 0075 已清洗存量）。
 */
export function normalizeKindString(text: string): string {
  const parsed = tryParseKind(text)
  return parsed === null ? text : stringifyKind(parsed)
}

/**
 * Base kind names recognized by the shared schemas as valid
 * AgentOutputKind ingredients. PR-A locked in 'string' / 'markdown';
 * PR-B (RFC-060) adds 'signal' as the control-flow-only base kind.
 * Future RFCs may extend this set.
 *
 * Kept as a const Set so additions are visible to any consumer that does
 * `REGISTERED_BASE_KINDS.has(name)`. The only public hook is
 * `isRegisteredKindString`.
 */
// RFC-080: exported so the parametric handler registry can CROSS-CHECK it at
// module load against the union of each handler's declared `baseNames` (drift
// guard layer 3a). The red line stays: `kindParser.ts` MUST NOT import the
// registry (that recreates the RFC-079 `index→list→registry→list` init cycle
// that crashes `build:binary`). The dependency is one-directional — the
// registry imports THIS set, never the reverse.
export const REGISTERED_BASE_KINDS: ReadonlySet<string> = new Set<string>([
  'string',
  'markdown',
  'signal',
])

/**
 * Stricter sibling of `isValidKindString`: parses successfully AND every
 * base name it mentions is a member of `REGISTERED_BASE_KINDS`. This is
 * what `AgentOutputKindSchema.refine` calls.
 *
 * The 'markdown_file' alias still passes because it folds to `path<md>`
 * at parse time; `path<ext>` doesn't carry a base name, so it never trips
 * the allowlist check.
 */
export function isRegisteredKindString(text: string): boolean {
  const parsed = tryParseKind(text)
  if (parsed === null) return false
  return allBasesRegistered(parsed, REGISTERED_BASE_KINDS)
}

function allBasesRegistered(p: ParsedKind, registered: ReadonlySet<string>): boolean {
  switch (p.kind) {
    case 'base':
      return registered.has(p.name)
    case 'path':
      return true
    case 'list':
      return allBasesRegistered(p.item, registered)
  }
}

/**
 * Deep structural equality on ParsedKind trees. Used by tests + validator
 * for "is this port the same kind as that one" checks; does not collapse
 * `markdown_file` vs `path<md>` (they collapse at parse time, not here).
 */
export function kindsEqual(a: ParsedKind, b: ParsedKind): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'base':
      return a.name === (b as { name: string }).name
    case 'path':
      return a.ext === (b as { ext: string }).ext
    case 'list':
      return kindsEqual(a.item, (b as { item: ParsedKind }).item)
  }
}

/**
 * RFC-081: is this kind a single markdown-bodied document — eligible for the
 * review / multi-document machinery? base `markdown` OR `path<md>` /
 * `path<markdown>` (the legacy `markdown_file`, which folds to `path<md>`).
 *
 * This is the SINGLE source of truth for the "markdownish" decision that was
 * previously hand-rolled in reviewMultiDoc.ts / workflow.validator.ts /
 * schemas/review.ts / review.ts. It lives in kindParser (which imports nothing)
 * so cycle-blocked modules — notably `schemas/review.ts`, which sits UNDER the
 * handler registry in the import graph — can use it without pulling the
 * registry and recreating the RFC-079 init cycle. Each parametric handler's
 * `isReviewableBody` delegates here too, so the predicate has one definition.
 */
export function isReviewableBodyKind(p: ParsedKind): boolean {
  if (p.kind === 'base') return p.name === 'markdown'
  if (p.kind === 'path') return p.ext === 'md' || p.ext === 'markdown'
  return false
}

/** String form of {@link isReviewableBodyKind}; false on unparseable input. */
export function isReviewableBodyKindString(kind: string): boolean {
  const parsed = tryParseKind(kind)
  return parsed !== null && isReviewableBodyKind(parsed)
}

/** Does this kind subtree contain a `path<…>` anywhere? (RFC-193 D18 helper.) */
function subtreeContainsPath(p: ParsedKind): boolean {
  if (p.kind === 'path') return true
  if (p.kind === 'list') return subtreeContainsPath(p.item)
  return false
}

/**
 * RFC-193 D18 — a NESTED list whose inner tree carries a `path` kind
 * (e.g. `list<list<path<md>>>`). The kind grammar allows it, but the
 * archival / force-merge-back / shard machinery all treat list ports as a
 * single flat level — letting such a declaration through would create ports
 * that pass validation yet whose files are never archived nor force-included
 * (a "validated but dangling" dark corner). Declaration is rejected at agent
 * save time (schemas/review.ts AgentOutputKindSchema), which transitively
 * covers workflow references. `list<path<md>>` (single level) is unaffected;
 * nested lists of non-path kinds (`list<list<string>>`) stay allowed.
 */
export function isNestedListPathKind(p: ParsedKind): boolean {
  return p.kind === 'list' && p.item.kind === 'list' && subtreeContainsPath(p.item)
}

/** String form of {@link isNestedListPathKind}; false on unparseable input. */
export function isNestedListPathKindString(kind: string): boolean {
  const parsed = tryParseKind(kind)
  return parsed !== null && isNestedListPathKind(parsed)
}

// -----------------------------------------------------------------------------
// internal helpers
// -----------------------------------------------------------------------------

function bracketsBalanced(s: string): boolean {
  let depth = 0
  for (const ch of s) {
    if (ch === '<') depth++
    else if (ch === '>') {
      depth--
      if (depth < 0) return false
    }
  }
  return depth === 0
}

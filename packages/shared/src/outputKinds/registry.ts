// RFC-060 PR-A — parametric OutputKindHandler 注册表骨架。
//
// 把 RFC-049 的 `OutputKindHandler<K extends AgentOutputKind>`（按字面值 kind
// 绑定的 handler）泛化为按 `ParsedKind` 谓词分派的 handler。
//
// PR-A 阶段：这是一个 **sibling 注册表**——`PARAMETRIC_HANDLERS` 与现有
// `HANDLERS` Record 并存，不接现有 runtime；getHandlerForParsedKind 仅供
// 新 wrapper-fanout 相关代码（待 PR-C / PR-D）调用。现有 envelope.ts /
// review.ts 仍走 `getOutputKindHandler(kind: AgentOutputKind)`。
//
// PR-D：切换 runtime 调用方为 parseKind + getHandlerForParsedKind；同步
// 删除 markdownFile.ts、把现有 HANDLERS Record 替换为本注册表。
//
// RFC-080（PR-A）现状更新：agent-output 的运行时调用方——shared/prompt.ts
// `buildProtocolBlock`、backend `envelope.ts resolvePortContentDetailed`、
// `runner.ts` repair——**已切到本注册表**（经 `groupPortsByParsedKind` /
// `getHandlerForParsedKind` / `composePerParsedKindRepairBlocks`）。
// outputKinds/index.ts 的旧 `HANDLERS` Record 仅余自身单测调用、无 agent-output
// 运行时调用方；markdownFile.ts 暂未删除（留作 follow-up）。本文件还托管 RFC-080
// 的具名 hook（DEFAULT_OUTPUT_KIND / formatPortValidationErrCode / 分组 helper）+
// handler 能力方法（baseNames / carriesData / bulletSuffix / examplePlaceholder /
// isReviewableBody）+ base 名加载期交叉校验（drift guard 层 1/3a）。
//
// 设计要点：
//   - 每个 handler 通过 `matches(parsed)` 自报负责的 ParsedKind 子集。
//     PathHandler 接 `parsed.kind === 'path'`（任意 ext，含 path<*>）；
//     ListHandler 接 list；SignalHandler 接 base name 'signal'；
//     StringHandler 接 base 'string'；MarkdownHandler 接 base 'markdown'。
//   - 注册顺序决定派发优先级；getHandlerForParsedKind 第一个 matches 命中为准。
//   - subReasons 跨 handler 唯一性继续锁住（与 RFC-049 同款 invariant）；
//     模块加载期 throw 让 PR 永远不能合入冲突命名。

import { splitListItems } from '../listWire'
import { tryParseKind, stringifyKind, REGISTERED_BASE_KINDS, type ParsedKind } from '../kindParser'
import type { ValidateIO, ValidateResult } from './types'

export interface ParametricValidateCtx {
  /** Port name (matches envelope `<port name=…>` attribute). */
  port: string
  /** Parsed kind of the port — handler may read `ext` / `item` etc. */
  kind: ParsedKind
  /** Absolute worktree root. Caller has already ensured it exists. */
  worktreePath: string
}

export interface ParametricKindFailure {
  port: string
  kind: ParsedKind
  /** Handler-internal flat short-code (e.g. 'missing-file'). */
  subReason: string
  detail?: string
}

export interface ParametricOutputKindHandler {
  /** Human-readable name for logs / errors (e.g. 'path' / 'list' / 'signal'). */
  readonly displayName: string
  /** subReasons owned by this handler — used at module load to assert no
   *  cross-handler collision inside this registry. */
  readonly subReasons: ReadonlySet<string>
  /** Returns true if this handler should serve the given ParsedKind. */
  matches(parsed: ParsedKind): boolean
  /**
   * RFC-080 drift guard: the base kind NAMES this handler serves (e.g. the
   * string handler → `['string']`; the path / list handlers serve a SHAPE,
   * not a base name → `[]`). The registry cross-checks the union of all
   * handlers' `baseNames` against `REGISTERED_BASE_KINDS` at module load
   * (`assertBaseNameCoverage`) so a new base kind can never be added to the
   * grammar allowlist without a handler claiming it, and vice versa.
   */
  readonly baseNames: readonly string[]
  /**
   * RFC-080: does this kind carry data that can be referenced as a `{{port}}`
   * template token? `signal` → false (control-flow only). Drives
   * `signalPromptGuard` + canvas signal-port styling, so any future no-data
   * control kind is auto-forbidden in prompt templates without editing those
   * call sites.
   */
  carriesData(parsed: ParsedKind): boolean
  /**
   * RFC-080: the per-port annotation appended to this kind's bullet in the
   * `<workflow-output>` protocol block (e.g. path → "write the file first…").
   * `null` = no suffix. Replaces prompt.ts's hardcoded `=== 'markdown_file'`
   * literal branch so a new kind self-annotates.
   */
  bulletSuffix(parsed: ParsedKind): string | null
  /**
   * RFC-080: the inner text of this kind's `<port>…</port>` example in the
   * Format block (default `'...'`; signal → `''`; path → a path hint). Lets
   * the example self-adapt to new kinds.
   */
  examplePlaceholder(parsed: ParsedKind): string
  /**
   * RFC-080 placeholder (call-site consolidation lands in RFC-081): is this
   * kind a single markdown-bodied document eligible for the review / multi-doc
   * machinery? Replaces the hand-rolled "markdownish" set scattered across
   * validator / reviewMultiDoc / review / schemas. A `list` is NOT a single
   * body → false at the list level; multi-doc detection (a list whose ITEM is
   * reviewable) is a structural check the callers do against `parsed.item`.
   */
  isReviewableBody(parsed: ParsedKind): boolean
  /** First-turn prompt guidance. Receives the ports declared with this
   *  handler + their full ParsedKind context so a list handler can decide
   *  guidance based on item kind. Return null to skip. */
  buildPromptGuidance(input: {
    ports: readonly string[]
    portKinds: ReadonlyMap<string, ParsedKind>
  }): string | null
  /**
   * RFC-317 T57（findings NK-01）—— 这个 kind 的**线格 codec**。
   *
   * 为什么必须是 handler 的方法而不是调用点的 if：`list<T>` 的 wire 形式取决于 T。
   * `list<path<*>>` 的条目是单行路径，一行一条；`list<markdown>` 的条目是**多行文档
   * 正文**，靠边界行分隔。改造前 `ListHandler.validate` 无条件用一行一条的
   * `splitListItems`，而 `splitListItems` 会 **trim 每一行、丢掉所有空行**——
   * 于是 `list<markdown>` 的正文在落库前就被改写了：段落间的空行没了、缩进没了、
   * 代码块的相对缩进也没了。同一个文件里的 `bulletSuffix` / `buildPromptGuidance`
   * **是**按 item kind 分支的，还告诉 agent「你的文档是多行的、用边界行分隔」——
   * 也就是说协议这一半知道，校验那一半不知道。
   *
   * 默认实现是一行一条（`splitListItems` / `'\n'` 连接）；需要别的 codec 的 kind
   * 自己覆盖。调用方一律经 `splitPortItems` / `joinPortItems` 走这里，不再各写各的判据。
   */
  splitItems?(parsed: ParsedKind, rawContent: string): string[]
  joinItems?(parsed: ParsedKind, items: readonly string[]): string
  /** Validate one port's raw content. Same contract as RFC-049 ValidateResult. */
  validate(rawContent: string, ctx: ParametricValidateCtx, io: ValidateIO): ValidateResult
  /** Followup repair-prompt segment for failed ports of this handler.
   *  Same contract as RFC-049 buildRepairBlock; return null to skip. */
  buildRepairBlock(input: {
    failures: readonly ParametricKindFailure[]
    ports: readonly string[]
  }): string | null
}

// -----------------------------------------------------------------------------
// Registration. PR-A registers 5 handlers (string, markdown, path, list,
// signal). Order matters: more specific predicates first so a future
// composite kind doesn't accidentally route to a generic fallback.
// -----------------------------------------------------------------------------

import stringHandler from './stringParametric'
import markdownHandler from './markdownParametric'
import pathHandler from './path'
import listHandler from './list'
import signalHandler from './signal'

export const PARAMETRIC_HANDLERS: readonly ParametricOutputKindHandler[] = Object.freeze([
  stringHandler,
  markdownHandler,
  pathHandler,
  listHandler,
  signalHandler,
])

export function getHandlerForParsedKind(parsed: ParsedKind): ParametricOutputKindHandler {
  for (const h of PARAMETRIC_HANDLERS) {
    if (h.matches(parsed)) return h
  }
  throw new Error(`no parametric OutputKindHandler matches '${stringifyKind(parsed)}'`)
}

/**
 * `getHandlerForParsedKind` that returns null instead of throwing — useful
 * in places that want to handle "no handler" gracefully (e.g. legacy
 * passthrough fallback).
 */
export function tryHandlerForParsedKind(parsed: ParsedKind): ParametricOutputKindHandler | null {
  for (const h of PARAMETRIC_HANDLERS) {
    if (h.matches(parsed)) return h
  }
  return null
}

// -----------------------------------------------------------------------------
// RFC-080 — named hooks + parametric grouping helpers.
//
// These are the registry-owned single sources of truth that replace magic
// literals scattered across prompt / envelope / runner. PR-A migrates the
// agent-output runtime callers onto them; the legacy `HANDLERS` Record helpers
// (`groupPortsByKind` / `composePerKindRepairBlocks` / `getOutputKindHandler`)
// in outputKinds/index.ts stay for non-migrated / test callers.
// -----------------------------------------------------------------------------

/** The implicit kind of an output port with no declared `outputKinds` entry. */
export const DEFAULT_OUTPUT_KIND = 'string'

/** ParsedKind form of {@link DEFAULT_OUTPUT_KIND}. */
export function defaultParsedKind(): ParsedKind {
  return { kind: 'base', name: DEFAULT_OUTPUT_KIND }
}

/**
 * The canonical `port-validation-<namespace>-<subReason>` errCode shape. The
 * namespace is the handler's `displayName` (path / list / signal / string /
 * markdown) so it never carries `<>` and a new kind cannot diverge the format.
 */
export function formatPortValidationErrCode(displayName: string, subReason: string): string {
  return `port-validation-${displayName}-${subReason}`
}

/** Parse a port's declared kind string, defaulting absent → base 'string'. */
export function parsePortKind(kind: string | undefined): ParsedKind {
  if (kind === undefined || kind === '') return defaultParsedKind()
  return tryParseKind(kind) ?? defaultParsedKind()
}

export type ParsedKindGroup = {
  handler: ParametricOutputKindHandler
  /** Ports served by this handler, in first-occurrence order. */
  ports: string[]
  /** Each port's ParsedKind (so list/path handlers can read item/ext). */
  portKinds: Map<string, ParsedKind>
}

/**
 * Parametric sibling of outputKinds/index.ts `groupPortsByKind`: parse every
 * declared port's kind into a ParsedKind, bucket by the matching parametric
 * handler (key = displayName, first-occurrence order), default absent kinds to
 * base 'string'. Unlike the legacy helper this never throws on path<ext> /
 * list<T> / signal — they route through `getHandlerForParsedKind`.
 */
export function groupPortsByParsedKind(
  declaredOutputs: readonly string[],
  agentOutputKinds?: Record<string, string>,
): ParsedKindGroup[] {
  const byDisplay = new Map<string, ParsedKindGroup>()
  const order: string[] = []
  for (const port of declaredOutputs) {
    const parsed = parsePortKind(agentOutputKinds?.[port])
    const handler = getHandlerForParsedKind(parsed)
    let group = byDisplay.get(handler.displayName)
    if (group === undefined) {
      group = { handler, ports: [], portKinds: new Map() }
      byDisplay.set(handler.displayName, group)
      order.push(handler.displayName)
    }
    group.ports.push(port)
    group.portKinds.set(port, parsed)
  }
  return order.map((d) => byDisplay.get(d)!)
}

/**
 * Parametric sibling of outputKinds/index.ts `composePerKindRepairBlocks`:
 * accepts failures carrying a kind STRING (as persisted by the runner), parses
 * each, buckets by the matching parametric handler, and calls its
 * `buildRepairBlock`. Failures whose kind doesn't parse are dropped (defensive;
 * the schema admits only registered kinds on ingress).
 */
export function composePerParsedKindRepairBlocks(
  failures: readonly { port: string; kind: string; subReason: string; detail?: string }[],
  agentOutputKinds?: Record<string, string>,
): string[] {
  if (failures.length === 0) return []
  const byDisplay = new Map<
    string,
    { handler: ParametricOutputKindHandler; items: ParametricKindFailure[] }
  >()
  const order: string[] = []
  for (const f of failures) {
    const parsed = tryParseKind(f.kind)
    if (parsed === null) continue
    const handler = getHandlerForParsedKind(parsed)
    let bucket = byDisplay.get(handler.displayName)
    if (bucket === undefined) {
      bucket = { handler, items: [] }
      byDisplay.set(handler.displayName, bucket)
      order.push(handler.displayName)
    }
    const item: ParametricKindFailure = { port: f.port, kind: parsed, subReason: f.subReason }
    if (f.detail !== undefined) item.detail = f.detail
    bucket.items.push(item)
  }
  const out: string[] = []
  for (const d of order) {
    const bucket = byDisplay.get(d)!
    // The repair block's "ports" arg = all ports of this kind declared on the
    // agent, mirroring the legacy helper's contract.
    const ports = Object.entries(agentOutputKinds ?? {})
      .filter(([, k]) => {
        const p = tryParseKind(k)
        return p !== null && getHandlerForParsedKind(p).displayName === d
      })
      .map(([port]) => port)
    const segment = bucket.handler.buildRepairBlock({ failures: bucket.items, ports })
    if (segment !== null) out.push(segment)
  }
  return out
}

// -----------------------------------------------------------------------------
// Module-load-time invariant: subReason short-codes are unique within this
// registry. RFC-049 sibling check on the legacy HANDLERS Record continues
// to run independently in outputKinds/index.ts.
// -----------------------------------------------------------------------------
{
  const claimedBy = new Map<string, string>()
  for (const h of PARAMETRIC_HANDLERS) {
    for (const sub of h.subReasons) {
      const prev = claimedBy.get(sub)
      if (prev !== undefined && prev !== h.displayName) {
        throw new Error(
          `RFC-060 PARAMETRIC_HANDLERS: subReason collision: '${sub}' claimed by both ${prev} and ${h.displayName}`,
        )
      }
      claimedBy.set(sub, h.displayName)
    }
  }
}

// -----------------------------------------------------------------------------
// RFC-080 drift guard layer 3a — base-name coverage cross-check.
//
// The union of every handler's `baseNames` MUST equal `REGISTERED_BASE_KINDS`
// (kindParser.ts), and each base name must be served by exactly one handler.
// This closes the kindParser.ts allowlist drift WITHOUT kindParser importing
// the registry (the dependency is one-directional; see kindParser.ts note).
// Adding a base kind to one side without the other → boot/CI throw.
// -----------------------------------------------------------------------------
{
  const claimedBy = new Map<string, string>()
  for (const h of PARAMETRIC_HANDLERS) {
    for (const name of h.baseNames) {
      // Sanity: a declared base name must actually route to its handler.
      if (getHandlerForParsedKind({ kind: 'base', name }).displayName !== h.displayName) {
        throw new Error(
          `RFC-080 baseNames: '${name}' declared by ${h.displayName} but resolves to a different handler`,
        )
      }
      const prev = claimedBy.get(name)
      if (prev !== undefined) {
        throw new Error(
          `RFC-080 baseNames: base kind '${name}' claimed by both ${prev} and ${h.displayName}`,
        )
      }
      claimedBy.set(name, h.displayName)
    }
  }
  for (const name of REGISTERED_BASE_KINDS) {
    if (!claimedBy.has(name)) {
      throw new Error(
        `RFC-080 baseNames: REGISTERED_BASE_KINDS has '${name}' but no parametric handler declares it`,
      )
    }
  }
  for (const name of claimedBy.keys()) {
    if (!REGISTERED_BASE_KINDS.has(name)) {
      throw new Error(
        `RFC-080 baseNames: handler declares base '${name}' missing from REGISTERED_BASE_KINDS`,
      )
    }
  }
}

/**
 * RFC-317 T57（findings NK-01）—— 一个端口内容按其 kind 切成条目的**唯一**入口。
 *
 * 改造前这件事散在四处，其中两处忘了按 item kind 分支：
 *   · `ListHandler.validate`（shared/outputKinds/list.ts）—— 无条件 `splitListItems`；
 *   · `portArtifacts.ts` 的 `parsed.kind === 'list' ? splitListItems(...)` —— 同样。
 * 另两处（scheduler 的分片、review 的多文档）**是**分支的——也就是说同一份内容，
 * 落库时按行切、分片时按边界行切，两边对不上。
 *
 * 默认一行一条；需要别的 codec 的 kind 在自己的 handler 上覆盖 `splitItems`。
 */
export function splitPortItems(parsed: ParsedKind, rawContent: string): string[] {
  const itemKind = parsed.kind === 'list' ? parsed.item : parsed
  const handler = getHandlerForParsedKind(itemKind)
  return handler.splitItems?.(itemKind, rawContent) ?? splitListItems(rawContent)
}

/** {@link splitPortItems} 的逆。默认换行连接。 */
export function joinPortItems(parsed: ParsedKind, items: readonly string[]): string {
  const itemKind = parsed.kind === 'list' ? parsed.item : parsed
  const handler = getHandlerForParsedKind(itemKind)
  return handler.joinItems?.(itemKind, items) ?? items.join('\n')
}

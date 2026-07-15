// RFC-049 — OutputKindHandler 静态接口（PR-A 接口骨架）。
//
// 四方法上限——新增能力（如多进程 sharding strategy / aggregator / telemetry tag）
// 请走单独 RFC 评估，不要私自往本接口加字段。本目录的 handler 是 internal
// extension point（仍走 shared 公共 barrel 导出，但只为让 backend / frontend
// 两侧能共用一套 prompt + repair 文案逻辑；不是公开给外部插件用的注册表）。
//
// 每个 AgentOutputKind 由**一个 handler 模块**接管：prompt 侧引导、parse 侧
// 校验、followup repair 文案、独占 subReason 集合。模块加载期 assert 全部
// handler 的 subReasons 跨 kind 唯一，从构造上阻止互相干扰。
//
// `validate` 通过 `ValidateIO` 注入 fs 操作，让 handler 模块本身不依赖 node:fs
// / node:path——shared 包可以在 frontend 加载，handler 只持纯文本逻辑。
// backend `services/outputKinds/io.ts` 提供 Node 实现。

import type { AgentOutputKind } from '../schemas/review'

/**
 * Filesystem + path-resolution capabilities the handler's `validate` needs
 * to do its job. Backend supplies a Node-backed implementation; frontend
 * doesn't call `validate` so doesn't need to provide one.
 */
export interface ValidateIO {
  /**
   * Resolve `rawContent` (a worktree-relative or absolute path emitted by
   * an agent) against the worktree root. Returns the absolute target path,
   * its worktree-relative form (for `sourcePath` reporting), and whether
   * the target stays lexically inside the worktree (defeats `../etc/passwd`
   * and `/etc/passwd`-style traversal — same containment rule as the
   * pre-RFC-049 envelope.ts).
   */
  resolveWorktreePath(
    worktreeAbsPath: string,
    rawContent: string,
  ): { targetAbs: string; relativePath: string; insideWorktree: boolean }

  /** Read absolute path as UTF-8. Throws on ENOENT / EACCES / EISDIR. */
  readFileUtf8(absPath: string): string
}

export interface ValidateCtx {
  port: string
  kind: AgentOutputKind
  /** Absolute worktree root. Caller has already ensured it exists. */
  worktreePath: string
}

export type ValidateResult =
  | {
      ok: true
      body: string
      sourcePath?: string
      /**
       * RFC-193: per-item validate outputs for `list<T>` kinds (item handler's
       * body/sourcePath, in `splitListItems` line order). Set ONLY by the list
       * handler; single-value kinds never populate it. Lets archive-at-emit
       * reuse the validation pass's file reads instead of re-running per-item
       * validation. Single-level by construction — nested lists carrying path
       * are rejected at declaration (D18, kindParser.isNestedListPathKind).
       */
      items?: Array<{ body: string; sourcePath?: string }>
    }
  | { ok: false; subReason: string; detail: string }

export interface KindFailure {
  port: string
  kind: AgentOutputKind
  /** Handler-internal flat short-code (e.g. 'missing-file'). Routed to the
   *  owning kind's handler at the call site via `<kind>` namespace. */
  subReason: string
  detail?: string
}

export interface OutputKindHandler<K extends AgentOutputKind = AgentOutputKind> {
  readonly kind: K

  /** subReasons owned by this handler. Used at module load to assert no
   *  cross-kind collision. Each entry is a flat short-code (no `<kind>-`
   *  prefix) — the kind namespace is added at the errCode wire by callers. */
  readonly subReasons: ReadonlySet<string>

  /**
   * First-turn user-prompt guidance. Receives ONLY ports declared as this
   * kind (handler can't see other kinds' ports → no cross-injection). Return
   * `null` to skip — string / markdown kinds have nothing to add.
   */
  buildPromptGuidance(input: { ports: readonly string[] }): string | null

  /**
   * Validate one port's raw content after envelope parse. **Does not throw**
   * — returns `{ ok: false, subReason, detail }` on failure so callers can
   * convert into a `port-validation-<kind>-<sub>` errCode at the wire.
   *
   * `io` supplies fs / path operations so this handler stays pure JS and
   * usable from any runtime that can synthesize a `ValidateIO`.
   */
  validate(rawContent: string, ctx: ValidateCtx, io: ValidateIO): ValidateResult

  /**
   * Followup repair-prompt segment when one or more ports of this kind
   * failed validation. Receives ONLY this kind's failures + ports — handler
   * can't see other kinds' inputs → no cross-injection. Return `null` to
   * skip (string / markdown can't fail today). Handler is responsible for
   * the **full** segment including its section header marker so callers
   * can splice the per-kind blocks together without further per-kind
   * branching.
   */
  buildRepairBlock(input: {
    failures: readonly KindFailure[]
    ports: readonly string[]
  }): string | null
}

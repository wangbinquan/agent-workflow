// RFC-287 G1 —— spawn 装配线骨架。
//
// 五条 iso 装配线（工作组主机 / agent-single / fanout 分片 / 聚合 / 脚本）此前各抄
// 一份「取许可 → 物化隔离工作树 → 落基线 → spawn → 合并回主干 → 清理」的流程。
// 四处漂移都是这么来的：谁少抄一段就是一个潜伏 bug（脚本线少抄的那个 try/catch
// 潜伏到今天，合并报错会把整个调度循环掀翻）。本模块把**流程骨架**收成一处，
// 而把**逐线差异**做成显式声明——因为实测表明差异是本质的，不是历史偶然。
//
// 契约要点（design §10.2 为唯一权威；此处只复述落地时最容易搞错的三条）：
//   · settle 只在窗口正常走完时执行。任何 skip / disposition / catch-all 产出的
//     结果**直接**成为装配结果，settle 不再执行。
//   · 相位判定序：park 先于 passthrough，passthrough 先于 merge/abandon/readonly。
//     倒过来会让 passthrough 运行的工作组 clarify 再也不落库。
//   · finally 里**释放许可先于清理隔离工作树**（RFC-208 事故；有跨文件结构锁）。
//
// 本模块**不得 import scheduler.ts**（模块环禁令 + 二进制构建事故先例），所需的
// 协作方一律注入；类型也只收结构化最小切片（同 isolatedAgentRun 的 WriteSemLike）。

import type { Logger } from '@/util/log'

/**
 * 模式 B 重试循环的防御性硬上限。取值远高于任何真实重试预算（脚本线与 agent 线
 * 的默认预算是个位数），够到它只可能是 spec 的 shouldRetry 写错了。
 */
const ASSEMBLY_MAX_ATTEMPTS = 100

/** 池的最小切片：只需要「取一个位子、拿到释放函数」。 */
export interface PoolLike {
  acquire(): Promise<() => void>
}

/** 隔离工作树句柄的最小切片。 */
export interface IsoLike {
  passthrough: boolean
}

/** 合并相位判定的四种「跳合并」。 */
export type MergeSkipKind = 'not-done' | 'park' | 'passthrough' | 'abandon' | 'readonly'

export type MergePhase<TCtx, TResult> =
  | 'merge'
  | {
      skip: MergeSkipKind
      keep: boolean
      /** 'settle' = 跳合并后继续走 settle；produce = 在窗口内直接产出结果。 */
      then: 'settle' | { produce(ctx: TCtx): Promise<TResult> }
    }

/** merge-back 的逐线声明式覆写（凡覆写必须带豁免锁）。 */
export interface Disposition<TCtx, TResult> {
  /** 默认：keep + markMergeFailed 后按失败 settle。'rethrow' 保持 L1 的重抛语义。 */
  onThrow?(
    err: unknown,
    ctx: TCtx,
  ): { keep: boolean; then: 'rethrow' | { produce(ctx: TCtx): Promise<TResult> } }
  /** 默认：keep + awaiting_human。L1 覆写为 abandon + failed（RFC-187 T8）。 */
  onConflictHuman?(
    detail: string,
    ctx: TCtx,
  ): { keep: boolean; produce(ctx: TCtx): Promise<TResult> }
}

export interface AssemblySpec<TCtx, TOutcome, TResult> {
  /** 顺序 = 获取序；释放恒逆序且由 finally 保证。 */
  pools: readonly PoolLike[]
  iso: {
    create(): Promise<IsoLike>
    /**
     * 落基线的相位——**按线声明**（design §10.10）：
     *   'in-setup'  = 在物化的同一个 try 内（L1/L5/L6：抛出 → 释放许可 + 返回结构化
     *                 iso-setup-failed）
     *   'in-window' = 在许可保护的主 try 内（L4/L7：抛出经 finally 释放后继续传播）
     * 统一成任一种都会改掉另外几条线的结果形态，故不设默认值。
     */
    persistBase: 'in-setup' | 'in-window'
    persist(handle: IsoLike): Promise<void>
  } | null
  /** L5 的 T14 undo 唯一消费方；钉在物化的同一个 try 内，hook 内自兜。 */
  beforeSpawn?(ctx: TCtx): Promise<void>
  /**
   * 收 attempt 序号（从 0 起）——模式 B 的每次 spawn 都要知道自己是第几次
   * （脚本线用它算 retryIndex 铸行、agent 线用它做 followup 判定）。
   * 模式 A 恒收 0。T5c 首个模式 B 消费者实证的契约缺口。
   */
  spawn(ctx: TCtx, attempt: number): Promise<TOutcome>
  /**
   * spawn 结果**直接**决定的 keep 输入（与合并处置正交，2026-08-13 新增维度）。
   *
   * 现状四条线都有 `processUnreaped === true ⇒ keep`：旧 child 可能还活着，此时
   * 新会话重试会在同一棵工作树里造出两个写者，所以既禁止重试、也必须保住 iso。
   * 它在 spawn 之后、mergePhase 之前求值；**置真则 keep 恒真、不被后续相位下调**
   * ——迁移时若只搬 mergePhase 那套，这条会被静默丢掉。
   */
  keepFromOutcome?(outcome: TOutcome): boolean
  mergePhase(ctx: TCtx, outcome: TOutcome): MergePhase<TCtx, TResult>
  mergeBack: {
    // outcome 是必需入参：L4/L6 的 extraForcedContainerPaths 取自 spawn 结果的
    // portFilePaths（T3 首条迁移实证的契约缺口）。
    // 形状对齐既有原语 `mergeBackAndSettle` 的返回（T3 首条迁移实证）：
    // kind 为 'merged' | 'conflict-human'，detail 仅冲突时给。
    run(
      ctx: TCtx,
      outcome: TOutcome,
    ): Promise<{ kind: 'merged' | 'conflict-human'; detail?: string }>
    disposition?: Disposition<TCtx, TResult>
  } | null
  /**
   * **模式 B 专用**（跨 attempt 持有窗口）：一次许可 + 一棵 iso 的窗口内，由本策略
   * 驱动 1..N 次 spawn。模式 A（每 attempt 一个窗口、外层 driver 重入）不声明它。
   *
   * 为什么必须按线声明而不能统一（design §4）：agent 线的 iso **跨 attempt 稳定**
   * （同会话续跑必须在同一棵树上恢复，否则模型记忆与磁盘错配）；脚本线则**每次
   * 重试都换新树**（否则上一次的文件写入会与这一次叠加）。把任一方统一到另一方
   * 都是行为变更。
   */
  retryPolicy?: {
    /** 还要不要再来一次（收 spawn 结果与本次 attempt 序号，从 0 起）。 */
    shouldRetry(outcome: TOutcome, attempt: number): boolean
    /** 重试前对 iso 的处置：'always-recreate' = 每次换新树；keepIf 为真则留用。 */
    isoOnRetry: 'always-recreate' | { keepIf(outcome: TOutcome): boolean }
    /** 换树失败的处置（与「初始物化失败」是两种结局，不可合并）。 */
    onIsoRecreateFailure(err: unknown): TResult
    /** 每次重试前的副作用（逐 attempt 铸行、落基线、广播……逐线不同）。 */
    onNextAttempt(attempt: number): Promise<void>
  }
  /** 线级 catch-all——逐线载荷不同，不得统一。'rethrow' = 保持抛出直穿。 */
  onUnhandledThrow?(err: unknown, ctx: TCtx): TResult | 'rethrow'
  /** 物化失败的产出（五线 message/summary 各不相同，属产品可见面）。 */
  onIsoSetupFailure(err: unknown, ctx: TCtx): TResult
  /**
   * **仅默认 onThrow 路径需要**——声明了 `disposition.onThrow` 覆写的线不必提供
   * （提供了也用不到，反而会让「装配单源锁」多数出一处 `markMergeFailed(`）。
   * 走默认路径却没提供 = 编程错误，骨架响亮抛出而不是静默跳过标记。
   */
  markMergeFailed?(msg: string, ctx: TCtx): Promise<void>
  discardIso(handle: IsoLike): Promise<void>
  settle(ctx: TCtx, outcome: TOutcome): Promise<TResult>
  log: Logger
}

/**
 * 跑一条装配线。
 *
 * 相位：取许可 → 物化 iso（+ 可选落基线 + beforeSpawn）→ spawn → 合并相位判定 →
 * merge-back（或跳过）→ settle；finally 释放许可（逆序）后再按 keep 清理 iso。
 */
export async function runAssembly<TCtx, TOutcome, TResult>(
  ctx: TCtx,
  spec: AssemblySpec<TCtx, TOutcome, TResult>,
): Promise<TResult> {
  const releases: Array<() => void> = []
  let handle: IsoLike | null = null
  let keep = false

  for (const pool of spec.pools) releases.push(await pool.acquire())

  try {
    if (spec.iso !== null) {
      try {
        handle = await spec.iso.create()
        if (spec.iso.persistBase === 'in-setup') await spec.iso.persist(handle)
        if (spec.beforeSpawn !== undefined) await spec.beforeSpawn(ctx)
      } catch (err) {
        return spec.onIsoSetupFailure(err, ctx)
      }
      // 'in-window'：抛出经 finally 释放后继续向外传播（L4/L7 现状）。
      if (spec.iso.persistBase === 'in-window') await spec.iso.persist(handle)
    }

    // 模式 B：窗口内由 retryPolicy 驱动多次 spawn；模式 A 只跑一次。
    let outcome = await spec.spawn(ctx, 0)
    if (spec.retryPolicy !== undefined) {
      const rp = spec.retryPolicy
      for (let attempt = 1; rp.shouldRetry(outcome, attempt - 1); attempt++) {
        // 防御性硬上限：真实的两条线各自有重试预算兜着（脚本线 maxRetries、agent 线
        // 的 attempt 循环），但骨架**不该依赖调用方不犯错**——一个 shouldRetry 永远
        // 返真的 bug 会让它在 daemon 里无限自旋，而且全程占着许可与隔离工作树。
        // 这个上限只是保险丝：正常路径永远够不到它，够到了就是 spec 有 bug，响亮抛出。
        if (attempt > ASSEMBLY_MAX_ATTEMPTS) {
          throw new Error(
            `assembly: retryPolicy exceeded ${ASSEMBLY_MAX_ATTEMPTS} attempts — shouldRetry never settled (spec bug)`,
          )
        }
        if (spec.iso !== null && handle !== null) {
          const keepTree = rp.isoOnRetry !== 'always-recreate' && rp.isoOnRetry.keepIf(outcome)
          if (!keepTree) {
            // 换新树：先丢弃旧的，再物化一棵——顺序不可颠倒（否则两棵树同时在盘上，
            // 且旧树里的残留写入会被下一次合并带进主干）。
            await spec.discardIso(handle)
            try {
              handle = await spec.iso.create()
            } catch (err) {
              return rp.onIsoRecreateFailure(err)
            }
          }
        }
        await rp.onNextAttempt(attempt)
        outcome = await spec.spawn(ctx, attempt)
      }
    }

    // spawn 结果直接决定的 keep（正交于合并处置；置真后不被下调）。
    const stickyKeep = spec.keepFromOutcome?.(outcome) === true
    if (stickyKeep) keep = true

    const phase = spec.mergePhase(ctx, outcome)
    if (phase !== 'merge') {
      keep = stickyKeep || phase.keep
      if (phase.then !== 'settle') return await phase.then.produce(ctx)
    } else if (spec.mergeBack !== null) {
      const d = spec.mergeBack.disposition
      let merge: Awaited<ReturnType<typeof spec.mergeBack.run>>
      try {
        merge = await spec.mergeBack.run(ctx, outcome)
      } catch (err) {
        const over = d?.onThrow?.(err, ctx)
        if (over !== undefined) {
          keep = stickyKeep || over.keep
          if (over.then === 'rethrow') throw err
          return await over.then.produce(ctx)
        }
        // 默认：保留 iso + 标记合并失败，交给 settle 按失败收场。
        keep = true
        if (spec.markMergeFailed === undefined) {
          throw new Error(
            'assembly: default onThrow disposition requires spec.markMergeFailed (or declare disposition.onThrow)',
          )
        }
        await spec.markMergeFailed(err instanceof Error ? err.message : String(err), ctx)
        return await spec.settle(ctx, outcome)
      }
      if (merge.kind === 'conflict-human') {
        const over = d?.onConflictHuman?.(merge.detail ?? '', ctx)
        if (over !== undefined) {
          keep = stickyKeep || over.keep
          return await over.produce(ctx)
        }
        keep = true
        return await spec.settle(ctx, outcome)
      }
    }

    return await spec.settle(ctx, outcome)
  } catch (err) {
    const handled = spec.onUnhandledThrow?.(err, ctx)
    if (handled === undefined || handled === 'rethrow') throw err
    return handled
  } finally {
    // RFC-208：释放**先于**清理（跨文件结构锁 rfc287-t1-release-before-discard）。
    for (const release of releases.reverse()) release()
    if (handle !== null && !keep) {
      await spec.discardIso(handle).catch((err: unknown) => {
        spec.log.warn('iso discard failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }
}

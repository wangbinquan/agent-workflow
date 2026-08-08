# RFC-271 · `applyIntentChangeset` 承重不变量清单

**用途**：批次 B（`BundleApply` 引擎）的**开工前置**（design §2.2b / plan 批次 B 开头）。
泛化一个既有引擎之前，先把它的承重不变量列成清单——**凭注释和函数签名推断会漏**，这份表
就是为了不再靠推断。

**核实方式**：2026-08-08 逐条读源码核实（不是转述注释）。锚点为 commit `2f6b2143` 时的行号。

**怎么用**：批次 B 落地后逐条对照打勾；标「引擎」的必须在新引擎里存在，标「intent 特有」的
本 RFC 不迁移故不需要，但**后续迁移 RFC 必须回来看这张表**。

---

## I1 · 按 scope 串行

**锚点**：`applyChangeset.ts:198-215`

```ts
/** Per-session in-process serialization (single-daemon platform). */
const applyLocks = new Map<string, Promise<unknown>>()
```

链式 Promise 锁，`finally` 里 release（`applyChangeset.ts:201-217`，入口在 `:266`
`withSessionApplyLock(input.sessionId, ...)`）。**注意是 in-process**——注释显式写明依赖
「单 daemon 平台」这个前提，不是跨进程锁。

⚠️ **本条初版我写错了**（R5 抓出）：我写的是「scope 由 provider 的 `idempotencyKey.scope`
给」。源码的键是 **`sessionId`——按资源实例串行，不是按命名空间**。若 package provider 拿
常量 `scope:'package'` 当串行键，**所有导入会全局串行**：Alice 一个慢 npm 安装堵住 Bob
完全无关的纯 agent 包。**串行键与幂等 namespace 必须是两个独立概念**。

> 这条错误本身值得记：这份清单存在的理由就是「不要凭推断泛化」，而它的第一条就犯了同一个错
> ——我把一个具体的 `sessionId` 泛化成了「provider 给的 scope」，而没有回头确认泛化后的语义
> 是否还成立。

**归属**：引擎（`serializationKey` 由 provider 单独提供，与 `idempotencyKey` 分开）。
**状态**：design §2.1 已补 `serializationKey` 字段并写明二者区别。

---

## I2 · claim 在单个事务内，且 duplicate 查询**先于**其它校验

**锚点**：`applyChangeset.ts:277-355`

一个 `dbTxSync` 内，严格按这个顺序：

1. 读 session；`session === undefined || session.ownerUserId !== actor.user.id` → 404
   （**owner 不符与不存在同形**，不是 403——存在性预言机防护）
2. **查 duplicate journal**（`sessionId + clientMutationId`）→ 命中直接返回 `replay`
3. 此后才是 `session.status !== 'active'` 等业务校验
4. draft 校验（revision / hash）
5. `insert journal (state='prepared')`

**顺序是承重的**：duplicate 查询若排在 status 校验之后，一次已 committed 的重放会因为
session 此后被关闭而报错，而不是返回原 receipt。

**归属**：引擎骨架（1、2、3、5）+ provider `claimInTx`（4 及其它场景特有校验）。
**v4 状态**：design §2.2 只写了 `UNIQUE(scope,key)`。**必须补顺序约束**。

---

## I3 · replay 是**三态**，不是「总是返回 receipt」

**锚点**：`applyChangeset.ts:357-380`

| journal state | 行为 |
|---|---|
| `committed` 且有 receipt | 返回**原 receipt** |
| `failed` | 抛 `intent-apply-failed-replay`（409），带 journalId |
| `prepared` / `applying` | 抛 `intent-apply-unsettled`（409）——「有一次未结的尝试，稍后重试」 |

第三态的注释写得很清楚：*prepared/applying without a live lock holder = a crashed attempt
that boot convergence has not yet swept. **Refuse rather than guess.***

**归属**：引擎。
**v4 状态**：design §2.2 写的是「重复提交返回**原 receipt**，不重跑」——**只覆盖了三分之一**。
必须改成三态。对配置包而言：同一个 `importId` 重传，若上次 failed 要明确告知失败而不是重跑，
若上次未结要拒绝而不是并发再来一遍。

---

## I4 · 依赖排序：类型序 + agent `dependsOn` 拓扑

**锚点**：`resolveChangeset.ts:651-665`

```ts
// ── topo order: skills → mcps → plugins → agents (dependsOn) → wf/wg ──
const typeRank = (t) => t === 'skill' ? 0 : t === 'mcp' ? 1 : t === 'plugin' ? 2
                      : t === 'agent' ? 3 : 4
```

agent 之间再按 `dependsOn` 排（`agentDeps` map，**只统计同 bundle 内的依赖**——
`.filter((id) => resolved.some((o) => o.resourceId === id))`）。

**归属**：引擎（design §2.3b 的 planner）。
**v4 状态**：§2.3b 已写方向，但**没写具体的类型序**。落地时照抄这一行，别自己重排。

---

## I5 · pending seams：preflight 接受同 bundle 内未落库的目标

**锚点**：`applyChangeset.ts:428-435`

```ts
const pendingIds = new Set(bundle.ops.filter(o => o.action === 'create').map(o => o.resourceId))
const pendingAgentNames = new Map(
  bundle.ops.filter(o => o.action === 'create' && o.resourceType === 'agent')
            .map(o => [o.resourceId, o.payload.name]))
```

**注意 `pendingIds` 的元素是预铸的 `resourceId`**（不是名字），说明预铸发生在 resolve 阶段、
preflight 之前。

**归属**：引擎。
**v4 状态**：§2.3b 已写。落地时注意预铸时机——必须早于 preflight。

---

## I6 · big tx 开头 CAS `prepared→applying`，**CAS 之后再次校验身份**

**锚点**：`applyChangeset.ts:695-712`

```ts
const cas = tx.update(journal).set({state:'applying'})
              .where(and(eq(id, journalId), eq(state, 'prepared'))).run()
if (cas.changes !== 1) throw new ConflictError('intent-apply-unsettled', 'journal claim lost')
```

紧接着的注释是一条 Codex impl-gate 教训：

> claim-time checks alone leave the prestage window (npm install / skill staging) open to
> rebase/mount/new drafts. **Re-assert the session identity INSIDE the commit transaction**
> so a moved epoch or superseded draft can never land.

**归属**：引擎（CAS）+ provider `revalidateInTx`（场景特有的二次校验）。
**v4 状态**：design §2.2 写了 CAS，**没写「CAS 之后二次校验」**。这正是 `revalidateInTx`
钩子存在的理由，要在 §2.1 写清它的调用时机 = CAS 之后、任何 commit kernel 之前。

---

## I7 · provenance / commitSeq / epoch / receipt / journal committed **与资源写同事务**

**锚点**：`applyChangeset.ts:865-900`

同一个 `dbTxSync` 内依次：每个 op 的 `applied.push(...)` + `intentProvenance` insert →
`commitSeq = claim.session.commitSeq + 1` → 关闭 context epoch（归档 draft、清 current
指针）→ receipt → journal `committed`。

**这是「资源可见」与「会话状态推进」原子性的唯一保证**。

**归属**：引擎（receipt + journal committed）+ provider `finalizeInTx`（provenance /
commitSeq / epoch 这类场景特有的伴随写入）。
**v4 状态**：§2.1 已有 `finalizeInTx` 钩子。要在 §2.2 明确它在**同一事务内**、且在 journal
committed **之前**调用。

---

## I8 · DB 提交后任何 tail 异常**都不得**补偿、也不得把 journal 改 failed

**锚点**：`applyChangeset.ts:922-932`

```ts
} catch (error) {
  if (committedReceipt !== null) {
    // The transaction is durable — the bundle IS applied. A post-commit throw
    // must never compensate or overwrite the committed journal state;
    // convergence replays the idempotent tail.
    log.warn('intent-roll-forward-crashed', {...})
    throw error
  }
  // ── compensation: reverse order, then journal 'failed' (zero visible) ──
```

**`committedReceipt !== null` 这个哨兵是整个错误处理的分水岭。**

**归属**：引擎。
**v4 状态**：design §8 的失败模式表只隐含了这条。**必须显式写**——它是最容易在重构里丢掉的
一条（写 catch 块时很自然地就把补偿逻辑放进去了）。

---

## I9 · 收敛：active set + freshness 下限 + 逆序补偿 + committed 前滚

**锚点**：`applyChangeset.ts:1000-1032`

```ts
if (ACTIVE_APPLY_JOURNALS.has(row.id) || row.updatedAt > reapBefore) continue
```

两个条件**是或关系**：本进程正在跑的、或**更新时间在 10 分钟内**的，都不收割。
注释：*an apply this PROCESS is running, or one still fresh enough to be a slow install, is
ACTIVE — reaping it would compensate a live transaction's prestage and then fail its journal
CAS.*

- `prepared`/`applying` → 逆序补偿 artifacts → CAS 成 `failed`（**CAS 带 `state = row.state`
  条件**，防止与活事务竞争）
- `committed` → `rollForwardCommitted`

**另注**：插件 artifact 在崩溃后**没有**缓存的 `InstallResult`，所以现有收敛器对它什么也不做，
靠 installer 自己的 generation GC 回收孤儿。**这正是 R3-F8 说的缺口**——RFC-271 的
record-before-act 要把精确路径预先写进 journal，才能在这里真正删掉。

**R5 补充的两条边界**（初版遗漏）：

- **claim 成功后必须立刻把 journalId 注册进 active set，并在 finally 里移除**
  （`applyChangeset.ts:382-395`）——注册晚于 pre-stage 就会留下「本进程正在跑、收敛器却看不见」
  的窗口。
- **补偿未成功时不得无条件终态化**（`:985-1027`）：现有实现里补偿抛错只 `log.warn` 然后仍把
  journal 标 `failed`，于是那次的残留再也不会被重试——这是**已知的既有缺口**（R5-P2-B 也点到
  它与插件精确删除的组合：`rm` 遇 `EBUSY` → journal 进 failed 不再重试 → 而 GC 又被任一
  非终态 run 阻断 ⇒ 目录永久残留）。新引擎应改为「补偿失败保留可重试状态」而不是照抄。

**归属**：引擎。
**状态**：design §2.2 已写 active set + 10min；本条的四点（CAS 带 state 条件、插件精确路径、
claim 后立即注册、补偿失败不终态化）需在批次 B 逐条落实。

---

## I13 · commit kernel / 引用 ACL / 特权 principal / receipt / journal **共处同一 big tx**

**锚点**：`applyChangeset.ts:747-874`

整个提交循环在**一个** `dbTxSync` 内：每个 op 的 commit kernel、`assertRefsUsableInTx` 的引用
ACL 复核、特权 principal 判定、`bundleCreatedNames`、provenance、receipt、journal
`committed`——**全部同事务**。

⚠️ **本条初版整个漏了**（R5 抓出）：我在 design 的速查表里写了它，却没有立成 I 项，于是
「逐条打勾」会漏掉它。

**具体反例**：泛化时若把 `assertRefsUsableInTx` 挪到事务外（很自然的重构——"preflight 归
preflight"），检查通过之后、提交之前目标的 grant 被撤销，资源仍会带着一个已失效的引用提交。

**归属**：引擎。
**状态**：design §2.2 的生命周期 ③ 已列出这些项在 big tx 内，但要在批次 B 显式断言「没有
任何一项被挪出事务」。

---

## I14 · 补偿 oracle 必须 record-before-act

**锚点**：`applyChangeset.ts:641-646`（现有 intent 路径**先 record 再 install**）、
`pluginInstaller.ts:202-254`（installer 在返回前就创建了目录，且可能抛错）、
`pluginGenerationGc.ts:18-31`（粗粒度 GC 被任一非终态 node run 完全挡住）。

**规则**：**任何外部副作用之前，先把「足以精确补偿它」的信息持久化进 journal。**

**具体反例**：plugin generation 已 mkdir、但精确路径尚未写 journal 时进程被 `SIGKILL` ⇒
启动收敛不知道该删哪个目录；而只要有一个 `awaiting_human` 的 node run，粗粒度 GC 又会完全
跳过 ⇒ **目录永久残留，且 journal 无法证明补偿完成**。

⚠️ 现有 intent 路径只做到「先 record `{pluginId}`」——**不含 generation id**，因为那个 id
在 `installPlugin` 内部才生成。RFC-271 的 record-before-act 要求**调用方预铸** generation id，
把精确路径先写进 artifact。

**归属**：引擎。
**状态**：design §2.5 / plan T11 已定案，**不阻塞开工**；列为 I 项是为了让批次 B 的对照表
完整——三个中断边界（journal 写入前 / mkdir 后 / install 返回前）各要一条测试。

---

## I10 · session mutation 在未结 apply 期间必须 409

**锚点**：`session.ts:193-205` `assertNoUnsettledApply`

**归属**：**intent 特有**。本 RFC 不迁移故不需要；后续迁移 RFC 必须把它作为 provider 的
准入钩子或留在 intent adapter。

---

## I11 · resolve 期的场景特有校验

**锚点**：`resolveChangeset.ts:345` 附近 —— slot / secret waiver / human binding / finalName /
copy-only / typed ref / cycle 校验。

**归属**：**intent 特有**。本 RFC 不迁移。
⚠️ 其中 `copyOnlyTargetsFor`（`applyChangeset.ts:135`）是决策 27 要动的那一处——**只动
skill/plugin 的 `not supported yet` 分支，`ownerUserId` 判据一字不动**。

---

## I12 · MCP update 的 OAuth carry-forward

**锚点**：`applyChangeset.ts:545` —— 模型不许输出 OAuth，apply 前把 existing OAuth 合并回去。

**归属**：**intent 特有**，且**绝不能**成为引擎默认——配置包的 overwrite 里「无 OAuth」可能
是有意删除。后续迁移 RFC 必须由 intent translator 在构造 bundle 前补齐。

---

## 对照检查表（批次 B 落地后逐条打勾）

| # | 不变量 | 归属 | v4 设计已覆盖 | 落地已验证 |
|---|---|---|---|---|
| I1 | 按**资源实例**串行（in-process） | 引擎 | ✅ 已补（`serializationKey`） | ☐ |
| I2 | claim 单事务 + duplicate 优先 | 引擎 + `claimInTx` | ⚠️ 缺顺序约束 | ☐ |
| I3 | replay **三态** | 引擎 | ✅ 已补 | ☐ |
| I4 | 类型序 + agent dependsOn 拓扑 | 引擎 | ⚠️ 缺具体类型序 | ☐ |
| I5 | pending seams（预铸早于 preflight） | 引擎 | ✅ | ☐ |
| I6 | CAS 后**二次校验** | 引擎 + `revalidateInTx` | ⚠️ 缺二次校验时机 | ☐ |
| I7 | finalize 与资源写同事务 | 引擎 + `finalizeInTx` | ⚠️ 缺「同事务」措辞 | ☐ |
| I8 | post-commit 绝不补偿 | 引擎 | ✅ 已补 | ☐ |
| I9 | 收敛 active set + 10min + 逆序 + 前滚 + **claim 后立即注册** + **补偿失败不终态化** | 引擎 | ⚠️ 四点待落实 | ☐ |
| I10 | session mutation 409 | intent 特有 | — 本 RFC 不需要 | — |
| I11 | resolve 期场景校验 | intent 特有 | — 本 RFC 不需要 | — |
| I12 | MCP OAuth carry-forward | intent 特有 | — 本 RFC 不需要 | — |
| **I13** | **commit kernel / 引用 ACL / receipt / journal 共处同一 big tx** | 引擎 | ✅ 已补（R5 新增） | ☐ |
| **I14** | **补偿 oracle 必须 record-before-act** | 引擎 | ✅ 已补（R6 新增） | ☐ |

**结论（v3，2026-08-08 第六轮复核后）**：**14 条**，11 条归引擎。

初版（12 条）有三处错漏，全部由设计门第五轮抓出：
1. **I1 写错**——把具体的 `sessionId` 泛化成「provider 的 idempotency scope」，而那样会让所有
   导入全局串行；
2. **I9 不完整**——漏了「claim 后立即注册 active」与「补偿未成功不得无条件终态化」；
3. **整条 I13 漏了**——big tx 的安全边界我在 design 速查表里写了，却没立成 I 项。

第六轮又补出 **I14**（补偿 oracle 必须 record-before-act）。**两轮各补出一条被漏掉的承重
不变量**——这本身就是证据：这份表不该被当成「一次做对」的东西。

> 这份清单存在的理由是「不要凭推断泛化」，而它自己第一条就犯了同一个错。**留着这段自陈，
> 是为了让后来者知道：这份表也要被审，不是权威。**

# RFC-304 不可达面盘点（2026-08-17）

本轮把「**两半都对、没接上**」当成一类缺陷系统扫了一遍：模块写了、单测绿了、
**生产没有任何调用方**。这类缺陷不会报错——缺失的接线永远不抛异常，只是那件事
从来没发生过。本文件是盘点结果与判据，供接手者按图索骥，**不是**待办清单：
每一条要不要做、做成什么形状，仍按 `CLAUDE.md` §RFC workflow 各自立项。

## 扫描方法（可复跑）

对 `packages/backend/src/modules/code-capability/**` 的每个 `export function`：

1. 在 `packages/backend/src` + `packages/frontend/src` + `packages/shared/src` 里搜
   **定义文件之外**的引用——零引用则进入候选；
2. 再看**本文件内**是否被同文件的其它函数用到（被用到 ⇒ 行为经该文件的对外入口
   仍可达，只是符号本身为测试而 export，不算缺陷）；
3. 两条都为零 ⇒ **生产不可达**。

按此判据：函数 102 个「无生产调用方」，其中 **61 个生产不可达**；模块文件层面有
**6 个 `.ts` 零导入**。

> ⚠️ 判据的边界：它证明的是「**这个符号**没被调用」，不等于「**这个功能**没实现」。
> 下面每条都已逐个对账过是「功能缺失」还是「同功能另有实现、本模块是死码」。

## A. 功能缺失（做了一半，产品面拿不到）

| 面                          | 死在哪                                                                                          | 用户侧后果                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| §11.1 AC-35 单条可更新总览  | `application/mrVoice.ts` 的 `updateSummary` 零调用方；且 `parsePrevious` 全仓**无生产实现**     | MR 上从未出现过平台总览评论；即便接上，没有 render→parse 往返，每轮折叠都从空表开始       |
| §11.2 T59 人工指令回执      | `mrVoice.answer` 零调用方                                                                       | @叫 / 确认关键词 / issue 标签发起后**没有任何回执**，人只会重复 @叫，进一步制造噪音       |
| §11.1 噪音上限              | `notificationsSpent` 生产侧无人赋值，`say()` 永远判「已花 0」                                   | 预算形同虚设；`bypassesBudget` 保护的冲突报告 / 三轮交接也就失去了「被听见」的前提        |
| §11.5 AC-38 框架灰度与回退  | `domain/frameworkRelease.ts` **整文件零导入**（revision 解析 / canary 判定 / 状态机 / 回退）    | 部门框架无法灰度到 1–5 个仓，也无一键回退到 last-known-good                               |
| §11.7 T63 批量启用与回滚    | `domain/configScale.ts` **整文件零导入**；`routes/code.ts` 无任何 bulk/batch 端点               | 「200 仓批量启用 + 一键回滚」在产品面不存在（三级继承本身另有实现，见 B）                 |
| T64 模板上游四态 / 三方差异 | `domain/templateUpstream.ts` **整文件零导入**，无路由                                           | 复制出来的模板与上游的关系、三方差异预览都拿不到                                          |
| T66 单工作项状态图          | `domain/stateViewScale.ts` **整文件零导入**；无 per-work-item 详情端点                          | 设计说「当前轮 + 最近 20 轮 + attempt 惰性加载/虚拟化」，实际只有列表页每项 3 轮          |
| readiness 失效传播          | `domain/readinessInvalidation.ts` **整文件零导入**（`cellsInvalidatedBy`）                      | 配置改动后哪些 cell 该被标记失效，没有执行者                                              |
| 发布意图崩溃恢复            | `sqlitePublishIntentStore` 的 `readPendingIntents` / `planRecoveryFor` / `closeIntent` 零调用方 | 崩在发布中途的意图无人清算                                                                |
| 重启清理发布临界区          | `sqliteWorkItemStore.clearStalePublishSections` 零调用方                                        | 崩在临界区里的工作项 `publishingEpoch` 长期非空 ⇒ 之后只能登记 pending_revision、不再动作 |

已于本轮修掉、不在上表：§2.3 lease 协议表的三行（心跳续租 / daemon 代际 / 启动
回收），见 `packages/backend/tests/rfc304-lease-heartbeat-and-generation.test.ts`。

## B. 同功能另有实现，本模块是死码（该删或该统一，不是缺功能）

- `domain/configScale.ts` 的 `effectiveConfig`——三级继承的**活路径**是
  `services/codeCapabilityParams.ts`；两份口径并存本身是风险。
- `domain/stateViewScale.ts` 的 `ROUND_WINDOW = 20` 与投影层活着的
  `ROUNDS_PER_ITEM = 3` 是同一概念的两个数。二者未必矛盾（列表页每项 3 轮 vs
  单项状态图 20 轮），但**只有 3 那个数有调用方与用例**。
- `domain/batchPublish.ts` 只有 `planBatch` 死了，`decideBatch` 活着
  （`application/publishReview.ts`）。

## C. 为测试而 export、行为仍可达（不是缺陷）

典型样本 `domain/capabilityWake.ts` 的 `judgeWake`：第 1 步判它「无外部引用」，
但同文件的 `capabilitiesToWake` 就在调它，而后者有生产调用方——**行为可达**，
export 只是为了单测能直接打这个纯函数。多数 `judge*` / `describe*` 属于此类。
扫描第 2 步就是为了把它们摘出去；**不要**按第 1 步的原始 102 条清单去「修」。

## 判据沉淀

一条通用规律，已同步 `docs/dev-gotchas.md`：**「写了 + 单测绿」不等于「接上了」**。
本 RFC 到目前为止此类缺陷已修 20+ 处，每一处的共同形状都是——规则/注册表/CAS
存在且被单测覆盖，但没有任何生产调用方。查它的最低成本手段就是上面那三步扫描；
写新模块时的对应纪律是：**接线与实现同一个 commit**，或者至少让一条用例从**入口**
（路由 / 调度器 / 启动流程）打进去，而不是只对着纯函数打。

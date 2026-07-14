# RFC-189 · 轮序数 vs 重试数：node_runs 身份语义上游拆分

状态：Draft（待 Codex 设计门 + 用户批准）
日期：2026-07-14
来源：调度执行架构全面审视（2026-07-14）——「共享列语义重载」定级第二位

## 1. 背景与问题

`node_runs.retry_index` 在两套引擎里承载了**两种语义**：

- 工作流：同 (nodeId, iteration, shardKey) 内的**重试计数**
  （`scheduler.ts` mint：`max-existing-in-iter + 1`）。
- 工作组：**轮序数 + 协议重试**的混合值——leader mint 用「往前所有 leader
  行数 + attempt」（`workgroupRunner.ts` driveLeaderTurn/driveAssignmentTurn），
  且 `iteration` 恒 0。

后果已两次成为实际问题：

1. **前端误标（已爆，commit `d1248df4`）**：按工作流语义渲染 retry_index，把
   正常的第二轮 leader 轮标成「重试#1」、把共享 `__wg_member__` 上仅靠
   shardKey 区分的并行 assignment 互标「反问#N」。修复落在**前端派生**
   `displayRetryForRun`（谱系内上个 done 之后的 failed 数）——下游打补丁，
   上游语义未拆。
2. **轮数账本靠派生排除法维持**：`countRoundsUsed` 从行集合现算，先后被
   `wg-gate`（RFC-180）、`__wg_clarify__` 行分区（RFC-187 F3）、
   `wg-protocol-retry`（RFC-187 T4，已落 `880ee15d`）三次打补丁——每加一类
   行都要记得去排除，本质是「轮」没有自己的持久身份。

## 2. 目标

- G1：工作组的「第几轮」获得**持久、显式**的身份：`node_runs.wg_round`
  （nullable INTEGER，仅 wg-* cause 的 mint 打戳）。
- G2：工作组 mint 的 `retry_index` 回归**纯重试计数**（0..N，attempt 序号），
  与工作流语义统一——一列一义。
- G3：`countRoundsUsed` 从「行集合排除法派生」改为读 `wg_round` 的单调事实
  （排除法退役）；前端 `displayRetryForRun` 派生补丁退役，改读结构化列。
- G4：存量数据 backfill（正解优先于双读回退——用户 2026-07-08 授权原则）。

## 3. 非目标

- 不动工作流侧 retry_index / iteration / freshness 任何语义。
- 不引入跨引擎统一「execution ordinal」抽象（YAGNI；只修工作组的重载）。
- 不改 maxRounds 产品语义（wrap-up 宽限轮等 RFC-187 已定行为原样保留）。

## 4. 用户故事

- 房间时间线/抽屉的「第 N 轮 · 第 M 次重试」直接读两列，不再靠前端按谱系
  推断；并行 fan-out 实例不会再互相污染显示。
- 引擎侧新增任何行类别（未来的新 cause）不需要记得去 `countRoundsUsed`
  加排除项。

## 5. 验收标准

- AC-1：migration 落 `wg_round` 列 + backfill（现存工作组任务的行按
  今日派生口径回填）；journal 计数锁同步 bump。
- AC-2：workgroupRunner 三处 mint（leader/assignment/message-turn）打
  `wg_round` 戳、`retry_index=attempt`；`countRoundsUsed` 改读 wg_round。
- AC-3：前端房间/抽屉显示改读 `wg_round`；`displayRetryForRun` 删除或降级为
  纯工作流用途；`d1248df4` 修的两个误标场景有回归锁。
- AC-4：RFC-187 T4 的「协议重试不膨胀轮数」语义在新口径下由测试重锁
  （1 base + 3 retry = 1 轮，断言 wg_round 相等而非 cause 排除）。
- AC-5：wire/shared schema 同步（NodeRun 类型 + API 投影），旧客户端读不到
  新列时行为不回退（可选字段）。

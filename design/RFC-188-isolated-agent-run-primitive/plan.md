# RFC-188 任务分解

> 读法：先 `proposal.md` → `design.md`。子任务 `RFC-188-Tn`；单 PR 交付但
> **一站点一 commit**（golden 对照粒度）。

## 任务

### RFC-188-T1｜差异目录核实 + golden dump 基线
- 对照 design §2 表逐行核实四站点现代码（行号会漂，按符号锚定）；
- 跑 rfc185 fan-out e2e + rfc130 crash-replay，dump node_runs/merge_state
  序列为 golden 基线文件（测试内嵌，不落仓库大文件）。
- 验收：目录与代码零出入（发现出入先修表再动手）。

### RFC-188-T2｜原语落地（isolatedAgentRun.ts）
- `runIsolatedAgent` + `mergeBackAndSettle` 两导出；AC-4 八分支单测。
- 依赖：T1。

### RFC-188-T3｜迁移 runOneNode 主线（一 commit）
- 重试环留在站点；promptMode/clarify 全谱参数穿线。
- 验收：全量套件 + golden 对照不变。

### RFC-188-T4｜迁移 fanout shard + aggregator（各一 commit）
- shard 的 subprocessSem 经 `semaphore` 覆盖；`preRun` 挂 undo。

### RFC-188-T5｜迁移 runHostNode（一 commit）
- 投影/lateSuppress/清 clarify 队列注入等 workgroup 语义留在 hook 内，
  hook 只再拼 req 调原语。
- 验收：rfc164/185/186/187 全部工作组 e2e 不变。

### RFC-188-T6｜replayPendingMerges 收编 + 源级锁
- replay 改用 `mergeBackAndSettle`；落 allowlist 源级锁（design §6.3）。

## 依赖与排期

```
T1 → T2 → T3 → T4 → T5 → T6
```

**开工前置**：等 RFC-187 PR-3 余项（并发 session 在做）落定，避免 scheduler.ts
/nodeIsolation.ts 双向 churn；T5b 独立 RFC 排在本 RFC 之后（design §5）。

## 验收清单

- [ ] AC-1~AC-4（proposal §6）逐项绿。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check`
      + `bun run build:binary` smoke。
- [ ] Codex 设计门（批准前）+ 实现门（合并前）findings 全折。
- [ ] STATE.md / design/plan.md 索引同步。

## 附录：本 RFC 显式不做、留候选的同族缝

- wrapper resume-to-running 三连样板（loop/fanout/git 各一段近逐字 8 行注释 +
  `setNodeRunStatus(allowTerminal)`）；
- `markWrapperTerminal + broadcastNodeStatus` ~20 对手工配对（可并成一个
  原语调用）；
- `deriveFrontier` 12 位置参数 → 结构体入参（对齐 `deriveWakeSet` 人体工学）。

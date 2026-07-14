# RFC-189 任务分解

> 读法：先 `proposal.md` → `design.md`。子任务 `RFC-189-Tn`；单 PR。

## 任务

### RFC-189-T1｜migration + backfill + 互 oracle golden
- `wg_round` 列 + CTE backfill（design §2；CTE 不可行退启动迁移器，设计门
  拍板）；journal 计数锁 bump；混排 golden（design §7.1）。

### RFC-189-T2｜写路径：三 mint 点打戳 + retry_index 回归 attempt
- leader/assignment/message-turn；wrap-up 轮 +1；协议重试同轮。
- `mintNodeRun` overrides 增 `wgRound`（工厂单点，grep 守卫自动覆盖）。

### RFC-189-T3｜读路径：countRoundsUsed 改 max 口径
- `max(wg_round WHERE status≠canceled) ?? 0`（design §4 canceled 边角）；
  rfc187-rounds-accounting 换 oracle 重锁（AC-4）。

### RFC-189-T4｜wire + 前端
- shared NodeRun schema 可选 `wgRound` + 后端投影 + ws 帧；
- 房间/抽屉轮标签改读列；`displayRetryForRun` 按 grep 结果删除或收窄
  workflow-only；`d1248df4` 两场景回归锁。

### RFC-189-T5｜e2e 重验
- rfc187 maxrounds-wrapup / rfc185 fan-out 在新口径下跑绿；
  full backend suite（migration 备忘：全量跑，防 journal 级联红）。

## 依赖

```
T1 → T2 → T3 → T5
        ↘ T4 ↗
```

**开工前置**：与 RFC-188 无依赖可并行，但两者都触 workgroupRunner mint 区
——若 188 已批，先 188 后 189（189 的 mint 改动落在收编后的站点上更小）；
并发 session 的 RFC-187 PR-3 余项落定后再动 workgroupRunner。

## 验收清单

- [ ] AC-1~AC-5（proposal §5）逐项绿。
- [ ] 五门 + `build:binary` smoke + Playwright；migration 后全量 backend
      suite（备忘：不许只跑 migration 子集）。
- [ ] Codex 设计门 + 实现门 findings 全折。
- [ ] STATE.md / design/plan.md 索引同步；完工登记与 P-X-XX 同级。

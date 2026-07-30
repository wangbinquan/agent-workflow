# RFC-236 · 循环包装器达到迭代上限后的处理策略 — plan

状态：Done（2026-07-30；设计门、实现门均 APPROVED，P0/P1/P2=0；本地实现与验证完成）。

## 任务

- [x] **RFC-236-T1 现状定位与语义确认**：追踪
      `WrapperGitLoopEdit → workflow validator → runLoopWrapperNode → deriveFrontier`，确认现有
      exhausted 默认、output promotion、wrapper-private canonical 与 downstream done-only
      契约；用户确认字段/default/最后一轮输出/其他错误不吞的精确语义。
- [x] **RFC-236-T2 设计门与用户批准**：proposal/design/plan 对抗复审关闭
      P0/P1/P2；用户于 2026-07-30 明确回复“ok”批准实施。
- [x] **RFC-236-T3 Shared/validator 契约**：新增 strict shared policy reader、新 validation
      field key/code/target/i18n；覆盖 missing=false、boolean、畸形 fail-closed、YAML/copy/sync
      保留。
- [x] **RFC-236-T4 Scheduler 成功收尾单源化**：抽 `completeLoopWrapperIteration`，让提前满足与
      max-continued 共用 output kind/archive promotion、wrapper iso merge、冲突/失败和 done
      广播；仅在 done 成功后写结构化 warning；默认 exhausted 字节不变。
- [x] **RFC-236-T5 Inspector 开关**：复用 `<Switch>`，紧跟 maxIterations，接 atomic
      history/undo-redo、semantic validation anchor 和中英文 label/hint；不新增 CSS。
- [x] **RFC-236-T6 自动化与真实验证**：shared/backend/frontend 定向回归；passthrough +
      真实 git canonical、最后一轮 output/artifact、下游、失败/取消/停泊/merge failure、
      resume；desktop light/dark、390px、持久化与 history 真实浏览器检查。
- [x] **RFC-236-T7 文档、全门与实现门**：同步 authoritative design/proposal/plan，运行
      typecheck/lint/test/format/depcheck 与相关 e2e；实现门关闭 P0/P1/P2；更新 RFC index /
      STATE。

## 顺序

```text
T1 → T2 设计门/批准 → T3 shared+validator
                         ↓
                    T4 scheduler → T5 frontend → T6 验证 → T7 实现门/收口
```

T3 与 T4 的 runtime 接线不可拆开发布：旧/畸形值必须同时被 validator 与 scheduler 同口径
解释。T5 可在 T3 field key 落地后接线。

## 实现切片

单一 RFC、单一实现批次；无 migration、无 schema-version bump。提交时按共享树规则使用精确
pathspec，不夹带当前 RFC-235 的并行改动。

## 不变约束

- `continueOnMaxIterations` 缺失/false = 当前 exhausted failure。
- 只有精确 true 开启；非 boolean fail closed。
- `maxIterations=N` 最多执行 N 轮。
- continue 只容忍“最后一轮 inner scope 成功但 exit condition 仍 false”。
- inner failed/canceled/awaiting 与 merge conflict/failure 不被吞。
- continue 的最后一轮 output content/kind/archive 与 loop-private canonical 必须共同交付。
- continue wrapper 写 done；`exhausted` 不改为条件性成功状态。
- downstream 继续走 generic done/fresh 与 scope projection，不新增 scheduler 旁路。
- 任务使用 frozen workflow snapshot，不热读 canonical definition。
- 不新增 DB migration、NodeRunStatus 或 task warning 状态。
- UI 复用公共 Switch，紧跟最大迭代次数，不新增 CSS。

## 自动化验收清单

- [x] shared policy reader 全矩阵。
- [x] validator + runtime 非 boolean 双门 fail closed。
- [x] 旧定义缺字段 exhausted 回归保持。
- [x] true + 永不满足：N 轮、最后一轮 outputs、done、下游继续。
- [x] 提前满足：现有成功语义不变；continued warning 只存在于 reason-specific done 后分支。
- [x] output kind/archive 与真实 git wrapper canonical 合并。
- [x] failed/awaiting 有开关定向回归；canceled/merge conflict/failure 在 policy 分支前返回且
      既有全量回归保持。
- [x] generic done/fresh resume 与下游 retry 继续保证已完成 loop 不重跑。
- [x] schema passthrough、YAML/storage、sync diff 与 task snapshot 字段守恒。
- [x] Inspector DOM 顺序、开关 round-trip、history、原生 checkbox、中英文。
- [x] desktop light/dark/390px、reload 持久化、undo/redo、无横向溢出与 console error。
- [x] typecheck/lint/format/depcheck、完整 shared/frontend 与 backend 全量/受影响隔离复跑。
- [x] 实现门 0 open P0/P1/P2。

## 用户批准记录

三件套与设计门先于生产实现落档；用户于 2026-07-30 明确回复“ok”批准实施。批准后才开始
修改 `packages/**`，最终实现门见
[`implementation-gate-2026-07-30.md`](./implementation-gate-2026-07-30.md)。

用户随后明确授权“提交上库”；本次发布只提交 RFC-236 精确路径，push 后按最终 SHA 核验远端
祖先关系与 CI，不夹带共享工作区的其它改动。

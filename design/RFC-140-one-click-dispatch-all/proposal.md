# RFC-140 批量下发一次点击全下发（questioner 改派塌缩 + deferred 自动串行补发）

状态：Draft（待用户批准）
触发：2026-07-03 任务 QMGP5（`01KWFZRQFPZFQQEM8JTCHQMGP5`）复活后 16:21 批量下发 10 条只下发
5 条（`dispatchedEntryCount=5 deferredEntryCount=5`），designer 5 条卡 staged 且续跑 running
期间无法补发 → 用户「为什么是补发，应该要一次性下发所有才对」→ 两项方案拍板（对称塌缩 +
自动串行补发）。

## 背景

### 实况（QMGP5，2026-07-03 16:20-16:21）

反问者节点 `agent_1k2ftd` 发起第二轮 cross 反问（5 问）。用户在看板 staged 全部 10 条承接
行（5 questioner + 5 designer），并把 **q1 的 questioner 行改派到设计节点 `agent_m7p3n1`**
（16:21:01），随后批量下发（16:21:09）：

- 设计节点 home 上同批出现两类互斥 cause——q1 questioner（`cross-clarify-questioner-rerun`）
  + q1-q5 designer（`cross-clarify-answer`）；
- RFC-128 §5.2.13 auto-split 按 aging + CAUSE_PRIORITY 选中 questioner 类下发（mint retry
  14），**designer 5 条全部 defer**（留 staged）；
- retry 14 running 期间 in-flight 门拒绝任何补发（`task-question-node-dispatch-in-flight`）
  ——用户必须等它 done 后**自己记得回来再点一次**。

### 两个独立缺口

**缺口 A（同题重叠——本 case 的根源）**：q1 的 questioner 行被改派到设计节点后，与 q1 的
designer 行语义完全重叠（同一条 Q&A、同一个目标节点），而「questioner 续跑」的 inline-resume
语义（续提问者被打断的 session）对设计节点根本不成立。RFC-138 定义了镜像方向（designer 行改
派到提问节点 → 塌缩为 questioner scope、只跑一遍）；**本方向（questioner 行改派到该轮设计节
点）从未定义**，于是两行并存 → 强制拆批 + 设计节点把同一条 Q&A 处理两遍。

**缺口 B（真异类混批的接续无人值守）**：auto-split 拆批本身对「不同题的两类 cause 落同一节
点」（如 self 轮答案 + cross designer 反馈）是语义正确的——一条 node_run 只有一个
`rerun_cause`（RFC-128 §5.2.12 cause 序列化）。但 deferred 批次的下发**依赖用户人肉回来重
点**：第一批续跑 done 时系统不自动接续、也无提醒；deferred 状态甚至不落库（`reason` 只是瞬
时返回值），daemon 重启后无从知晓。

## 目标

1. **一次点击全下发**：用户点一次「批量下发」，所有 staged 条目全部进入确定性的下发轨道——
   同 home 同 cause 立即下发；同 home 异 cause 自动串行（第一条续跑 done 后系统自动补发下一
   批，逐批收敛，全程无人值守）。
2. **对称塌缩**（缺口 A）：cross 轮 questioner 行改派到**该轮设计节点**（`targetConsumerNodeId`）
   时，语义等价于把该题 scope 事后改为 `designer`——删 questioner 行、该题只剩 designer 行
   （同题只跑一遍、单份投递），提问节点靠 echo 回执看到该题 Q&A（RFC-134 语义）。塌缩后本
   case 的改派不再产生混批。
3. **deferred 可见**（缺口 B 的 UI 面）：被 defer 的条目在看板上有明确状态（「等待 X 节点当
   前续跑结束后自动下发」），用户不需要理解 cause 序列化机制。

## 非目标

- **不推翻 cause 序列化**（RFC-128 §5.2.12）：不把两类 cause 合进一条 rerun（用户拍板放弃
  「合并单 rerun」方案——session 模式选择、审计模型、测试锚连动的手术过大）。真异类混批仍是
  两条 rerun **串行**，只是接续自动化。
- **改派到第三节点**（非提问节点、非该轮设计节点）的 questioner 行为逐字不变（仍走 override
  + echo，RFC-127/131/134 机制）。designer 行改派语义不变（RFC-138 塌缩 + override 均不动）。
- **不改 auto-split 的选择规则**（aging + CAUSE_PRIORITY 破平）。
- **不改 in-flight 门 / 双台账守卫**（RFC-133 / RFC-139 语义原样）。
- **仅 staged 未点发的条目不自动下发**：自动补发只针对「用户点过批量下发但被 auto-split
  defer」的条目（`auto_dispatch_deferred_at` 有值）；stage 而未点发 = 用户还在暂存区斟酌，
  系统绝不越权代发。
- 塌缩不追溯已下发行（`dispatched_at` 已盖 → 409 `task-question-already-dispatched`，与
  override 路径同边界；此时该题修订已在轨道上，零新增 mint——镜像 RFC-138 D6 裁决）。

## 用户故事

- 我答完一轮跨节点反问、把某题改派给设计节点处理，点一次批量下发——所有题一次性进入执行，
  不需要理解「questioner/designer 两类续跑」的机制差异，更不需要盯着任务回来补点。
- 我把 self 轮和 cross 轮的答案混在一起批量下发到同一个设计节点——系统自动按序跑两条续跑，
  第二批不需要我介入。
- daemon 中途重启，deferred 批次照样在续跑结束后自动下发（登记落库）。

## 验收标准

1. **QMGP5 形态回归**：q1 questioner 改派到该轮设计节点 → 塌缩（响应 `action:
   'collapsed-to-designer'`，questioner 行删除、该题 designer 行存在且可下发、echo 行物化给
   提问节点）；随后批量下发 10→9 条全部一次下发（两 home 各单一 cause，`deferredEntryCount=0`）。
2. **塌缩边界**：改派到第三节点 → 常规 override（golden-lock 逐字不变）；questioner 行已
   dispatched → 409；designer 行不存在（原 scope=questioner）→ 塌缩时 insert-if-missing 补
   建（seal 戳归一化）；scope 表双写 lockstep（clarify_rounds + cross_clarify_sessions）。
3. **自动串行**：同 home 真异类混批（self + designer 不同题）批量下发 → 第一批 mint +
   deferred 批次盖 `auto_dispatch_deferred_at`；第一条续跑 done 后 **scheduler tick 自动下发
   deferred 批次**（`dispatched_by='__system__'`），无人工介入；嵌套 defer（三类 cause）逐批
   收敛。
4. **越权防护**：仅 staged 未点发（`auto_dispatch_deferred_at` 为空）的条目在续跑 done 后
   **不被**自动下发。
5. **重启韧性**：deferred 登记落库；daemon 重启 + 任务 revival 后 tick 照常自动补发。
6. **补发失败自愈**：自动补发撞 409（别的 home 又 in-flight）→ 静默留待下一 tick，不失败任
   务、不丢登记。
7. UI：deferred 条目显示等待状态徽标 + 塌缩知会（镜像 RFC-138 `tq-collapse-notice`）；i18n
   zh/en。
8. `bun run typecheck && bun run test && bun run format:check` + binary smoke + CI 全绿；
   migration 附带 bump `upgrade-rolling.test.ts` journal 计数断言。

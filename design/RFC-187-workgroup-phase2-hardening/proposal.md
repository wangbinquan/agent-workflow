# RFC-187 工作组 Phase 2/3 硬化——反问收口 · 收尾优雅化 · 合并可信 · 启动护栏

> 状态：Draft
> 承接：[`design/workgroup-e2e-audit.md`](../workgroup-e2e-audit.md) §8 Phase 2/3 + RFC-186 非目标清单
> 前置已落地：RFC-184（host 输出隔离）· RFC-186（首绿 P0-A + 恢复 P0-B + 真实 e2e）· RFC-185（fan-out opt-in）
> 实证支撑：[`project_workgroup_adversarial_probes`] 三次 live 探针（2026-07-14，生产 daemon + glm-5.2）

## 背景

RFC-186 把工作组从「10 任务 0 done」带到了**第一次真实绿**：leader/member 首轮不再死于信封手滑（统一 `FOLLOWUP_POLICY`），任意重启中途不再永久死（interrupted 恢复 + 重启对账），并焊死了真实子进程 e2e。三种模式（leader_worker / free_collab / dynamic_workflow）现均可端到端跑到 done。

但审计 §8 的 Phase 2/3 明确列了一批**未动的潜伏项**。RFC-186 落地后，本 session 用三次**刁钻 live 探针**主动去撞这些潜伏项，把「理论隐患」变成了**实测实锤**——其中两项远比审计预估的严重：

### 实证探针结论（2026-07-14）

| 探针 | 配置 | 结果 | 命中审计项 | 实测严重度 |
|---|---|---|---|---|
| **C** | `maxRounds:1`，autonomous | 任务 `failed`「hit max_rounds (1)」**但 worker 已产出 `hello.txt`** | §3-7 | **活儿干完了却报 failed**——交付物在 canonical 里躺着，任务却是红的 |
| **B** | 非自治，leader 被要求先反问 | leader 反问 park **10 次**（10×`__wg_leader__ done` + 10×`__wg_clarify__ awaiting_human`），任务 `failed`「hit max_rounds (10)」 | §5 F3 / F8 | **非自治 leader 反问整条链断了**——人从没被真正问到，N 个 clarify session 全孤儿化，任务撞轮数红掉 |
| **A** | fan-out，两 writer 写同一 `shared.txt` | 两 writer 都往 **leader 的 iso**（绝对路径）写 → 成员自己的 iso 全空 → merge-back 合并零 → canonical 空，任务却 `done` | §4-2 衍生（新发现） | **静默零交付**——done 但 canonical 无任何改动，无框架护栏识别 |

三条实锤把 Phase 2/3 从「锦上添花的硬化」重新定性：其中 **F3（非自治 leader 反问全断）** 与 **§3-7（干完活报 failed）** 已达「一类配置直接不可用 / 用户被明确误导」级别，应作为本 RFC 的 P0/P1 头等；**§4 零交付 done** 是可信度硬伤（用户看到 done 就以为有产出）。

## 目标

1. **反问收口（F3/F8）**：leader 发起的反问 park 对引擎**可见**——非自治组落 `awaiting_human` 让人能答、答后续跑；不再每轮重唤 leader 空转到 max-rounds。park 原因标注区分 `leader-idle`（真空转）vs `leader-clarify`（等人答）。
2. **收尾优雅化（§3-7/§3-3）**：`maxRounds` 触顶不再无脑 hard-fail——最后一轮强制 wrap-up（有产出则 declare done / 无则 park 待人），且协议重试多铸的 leader 轮**不计入** `maxRounds`（RFC-186 把 `WG_PROTOCOL_RETRIES` 提到 3，直接放大了这个膨胀）。
3. **合并可信（§4 新发现 + §4-2/3/4/6）**：`done` 但 canonical 零 delta 的工作组任务要有**显式信号**（不静默成功）；fan-out 重叠写改**逐路径救回**（干净子树落地、仅冲突路径 park）；merge agent 移出全任务 `writeSem`（消 head-of-line）；conflict-human 行不孤儿化 iso；同波 fan-out 共享 base 快照。
4. **启动护栏（TRAP-1）**：创建/启动就绪检查加「无可派 producer」「leader-only 花名册」警告，不再放行必死配置。
5. **测试可信（TRAP-3）**：收紧唯一的 Playwright 工作组断言（禁 `failed` 当通过）+ wg-aware stub。

## 非目标

- **不重构 free_collab 收敛/livelock**（审计 §3 旁注）——单列后续，本 RFC 不碰 fc 排空逻辑。
- **不引入跨迭代反馈端口 / 新工作组状态机**——沿用现有 `pending/running/awaiting_human/awaiting_review/done/failed/...`。
- **不做框架级绝对路径沙箱**——探针 A 暴露的「成员写 leader iso」根因是弱模型把绝对路径写进 brief；框架无法阻止子进程写任意路径，本 RFC 只做**检测 + prompt 收敛**（协议块指引相对路径 + 零 delta done 信号），不做进程级 chroot/沙箱。
- **不改 RFC-185 fan-out 的 opt-in 语义** —— fan-out 仍默认关；本 RFC 只硬化其开启后的合并路径。

## 用户故事

- **US-1（非自治 leader 反问，F3）**：我建了个非自治工作组（我想全程把关），leader 需要澄清需求时向我提问。**期望**：任务落 `awaiting_human`，我在房间里看到问题、回答，leader 拿到答案继续。**现状（实测）**：leader 反问被引擎无视，每轮重问，10 轮后任务 `failed`，我从没被真正问到。
- **US-2（收尾，§3-7）**：我给工作组设了轮数上限防跑飞。任务做完了活儿（文件已产出）但恰好在上限轮。**期望**：任务 `done`（或至少 `awaiting_review` 让我确认），产出可见可用。**现状（实测）**：任务 `failed`，我以为白跑了，其实交付物就在 worktree 里。
- **US-3（fan-out 合并可信，§4）**：我开了 fan-out 让多个 writer 并发。**期望**：要么产出合并进 canonical，要么冲突时明确告诉我「N 个文件没合进去」。**现状（实测）**：任务报 done 但 canonical 空空如也，没有任何信号说产出丢了。
- **US-4（启动护栏，TRAP-1）**：我的花名册只有一个只读审计 agent（没有能写代码的 producer）。**期望**：创建/启动时就警告「这个组没有可派活的成员」。**现状**：绿灯放行，leader 只能正确判 BLOCKED，引擎当协议错误 failed。

## 验收标准

### PR-1（P0/P1，探针实锤三项）
- **AC-1（F3）**：非自治组 leader 发 `<workflow-clarify>` → 任务转 `awaiting_human`（非继续 running）；房间可见问题；答复后 leader 续跑；引擎**不再**在未答期间重唤 leader。回归：一个 restart→resume 也保持 awaiting_human。真实 e2e：`scenario-opencode` 脚本化 leader 首轮发 clarify，断言任务 `awaiting_human` 且 `__wg_leader__` 轮数 = 1（不膨胀到 max-rounds）。
- **AC-2（§3-7）**：`maxRounds` 触顶时，若有未聚合产出/已完成 assignment → 最后一轮强制 leader wrap-up（declare done 或 gate）；纯无产出空转才 park/fail。真实 e2e：`maxRounds:1` + 单派单场景断言任务**非 `failed`**（done 或 awaiting_*），且 `hello.txt` 在 canonical。
- **AC-3（§4 零 delta done）**：工作组任务到 `done` 且 canonical diff 为空 + 存在 assignment 声称有产出 → 落**显式 note/告警**（`errorSummary` 或专门字段），不静默成功。单测：纯函数 `detectZeroDeltaDone(diffStat, assignments)` golden。

### PR-2（P1 硬化）
- **AC-4（§3-3）**：`countRoundsUsed` 不计协议重试铸的 leader 轮（退休其 `rerunCause` 或按逻辑轮去重）。单测锁：4 次信封重试的 leader 轮 = 1 逻辑轮。
- **AC-5（§4-2/3）**：fan-out 重叠写 → 干净路径落地、仅冲突路径 park + 结构化「丢了 N 文件」note；merge agent 不持 `writeSem`（仅最终 materialize 夺锁）。
- **AC-6（TRAP-1）**：`workgroupLaunchReadiness` 加 `no-producer`/`no-non-leader-worker` 码；创建/启动/前端 banner 同源可见。单测锁三态。
- **AC-7（F8）**：park 原因枚举分 `leader-idle` vs `leader-clarify`；遥测/房间显示正确原因。

### PR-3（P2 潜伏）
- **AC-8（§4-4）**：工作组 conflict-human 行保 iso/不删 refs（或显式 abandon），restart→resume 不 failTask 整任务。
- **AC-9（§4-6）**：同波 fan-out 成员共享单次 base 快照（合并 base 确定化）。
- **AC-10（F2 残留）**：给 interrupted/idle 工作组任务发消息/deliver/patch → 对任何可恢复态触发 kickResume（当前仅 `awaiting_human`）。
- **AC-11（TRAP-3）**：Playwright 工作组断言禁 `failed` 当过；stub-opencode 产合法 wg 信封。
- **AC-12（§3-2）**：leader emit `continue` 不带 assignments → autonomous 无条件 nudge / 非自治须带阻塞说明（收口 continue-no-dispatch）。

### 全程门槛
- `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；CI 五门 + binary smoke + Playwright 绿。
- 每项改动带测试（纯函数预言优先 + 源码文本锁兜底 + 真实 e2e 覆盖 PR-1 三锤）。

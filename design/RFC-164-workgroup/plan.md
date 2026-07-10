# RFC-164 plan——任务分解与 PR 拆分

> 规模判断：本 RFC 是子系统级（新资源 + 新调度分支 + 新前端域），**单 PR 不现实**，
> 拆 6 个 PR，每个独立过全量门禁（typecheck×3 / lint 0 warn / format / 后端全量 / 前端 vitest /
> binary smoke），主干持续绿。每个任务自带测试（改动即带测，无"先实现后补测"档）。

## PR-1 资源面（自洽，未接任何执行路径）

- **T1** shared：`WorkgroupSchema` / `WorkgroupMemberSchema` / Create/Update body schemas
  （mode/三开关/max_rounds/completion_gate/成员行校验：lw 必有 leader、display_name 组内唯一、
  human 必填 display_name）。测试：zod 正反例。
- **T2** migration A（journal +1）：`workgroups` + `workgroup_members` 建表（design §1.1/1.2），
  `--> statement-breakpoint` 分隔；drizzle schema 同步。测试：迁移幂等 + 建表列锁 +
  **bump upgrade-rolling journal 计数锁**。
- **T3** ACL：`resource_grants.resourceType` 枚举扩 `'workgroup'`；`services/resourceAcl.ts`
  注册第六类（list 过滤 / detail 404 同形）；`services/resourceRefs.ts` 扩「保存组时校验新增
  成员 agent 引用」。测试：未授权 404/过滤、公私切换、grants、引用校验。
- **T4** CRUD：`services/workgroups.ts` + `routes/workgroups.ts`（GET/POST/PUT/DELETE +
  members 子资源，照 mcps 抄）。测试：路由级 CRUD + 校验错误路径。
- **T5** 前端资源页：`/workgroups` 列表 + `/workgroups/$id` 编辑（成员编辑器 / leader 单选 /
  `.segmented` mode / Switch 开关 / NumberInput 轮数），`nav.ts` 并入 `workflows` 组，
  i18n 双语。测试：表单校验（lw 必 leader、fc 开关禁用）、列表/编辑渲染、role 断言。
- **T6** PR-1 门禁 + Codex 增量审查。

## PR-2 协议与引擎内核（纯库，未接线）

- **T7** migration B（journal +1）：`workgroup_assignments` + `workgroup_messages` +
  `workgroup_member_cursors` 建表（design §1.4/1.5/1.6）。测试：列锁 + 计数锁 bump。
- **T8** `services/workgroupLifecycle.ts`：assignment 状态机转移表 + CAS（照 lifecycle.ts 风格）。
  测试：全转移矩阵（非法转移抛错）。
- **T9** shared envelope 端口：`wg_assignments`/`wg_messages`/`wg_decision`/`wg_result`/
  `wg_tasks_add` zod 载荷 schema + 解析器。测试：合法/畸形 JSON/未知成员/空数组/超限。
- **T10** `services/workgroupContext.ts` 注入器纯函数：`selectMemberSlices`（三开关 2³ × lw/fc
  矩阵）、`resolveVisibility`（fc 覆写）、花名册/章程/协议块渲染（leader/worker/fc 三版）、
  水位线增量切分、`normalizeTitle` 去重键。测试：矩阵逐格 + 协议块文案锚点（含禁转派）。
- **T11** 唤醒/终止纯函数：`deriveWakeSet`（lw 批语义 / 人类单不阻塞 / fc 代领前置态 /
  **基于成员游标的 @ 消息唤醒判定**〔design §1.6/§6.3，幂等〕）、`decideWorkgroupOutcome`
  （done/收敛/触顶 failed/fc 死锁 failed）。测试：表驱动全分支 + 游标幂等（同消息不二次唤醒）。
- **T12** PR-2 门禁。

## PR-3 启动路径 + 回合引擎（leader_worker 后端闭环）

- **T13** migration C（journal +1）：`tasks` ADD `workgroup_id` + `workgroup_config_json` +
  索引；builtin `__workgroup_host__` seed。测试：**tasks 全字段锁 +2 列**、seed 幂等、计数锁 bump。
- **T14** 启动：`StartWorkgroupTaskSchema`（repo 字段复用 StartTaskSchema 子结构）+
  合成宿主快照（design §2）+ `startWorkgroupTask`（canViewResource 门 / config 快照 /
  collaborators 并入人类成员 / `startTask` deps 注入 stamp 两新列）+
  `POST /api/workgroups/:id/tasks`。**临时守卫：含人类成员的组拒绝启动（PR-5 撤）**。
  测试：启动全链（task 行两列 stamp / 快照三节点 / 快照 clarify wire / collaborators 并入 /
  ACL 拒绝 / 临时守卫）。
- **T15** 回合引擎：`services/workgroupRunner.ts`（runTask 按 `workgroup_id` 分流；事件循环 /
  mint 借壳行〔agentOverrideName+shardKey+rerunCause 新枚举值〕/ runtime 冻结 / globalSem /
  envelope 消费 → assignment+消息落库 / 派单即刻起跑 / leader 批唤醒 / session 续接+游标增量
  〔游标推进与 mint 同事务，design §1.6〕/ awaiting_human 泊与 resume 重入 / 触顶 failed /
  cancel 清理）。测试（fake runner 桩）：
  回合闭环（派 2 单并行→结果注入→done）、mint 行逐格锁、malformed 重试、成员失败报 leader、
  触顶、resume 幂等（CAS 双驱动）、daemon 重启重建。
- **T16** clarify 贯通 + 消息唤醒轮：成员 run 反问→round 建行→答后续跑；`direct_messages`
  开时 @ 消息 mint 消息轮。测试：贯通链 + 开关关时不唤醒。
- **T17** prompt 隔离锁（design §11 双层）+ 源码级兜底锁（runTask 分流断言 /
  renderUserPrompt workgroup 分支与 agent outputs 协议块互斥文本断言）。
- **T18** PR-3 门禁 + Codex 增量审查。

## PR-4 聊天室前端 + WS

- **T19** WS 频道（RFC-152 六触点全套，design §9）+ rfc152 双 bijection 计数 bump。
  测试：frameGate/upgradeGate + 互锁计数。
- **T20** 房间聚合 API：`GET room`（消息+派单卡分页）+ `POST messages`（@ 解析三路：
  @agent 直派 / @human 待办〔PR-5 前仅落卡〕/ 无@ 黑板）+ assignments 显式端点 + cancel。
  测试：@ 路由三路、分页、成员制门禁（非任务成员 404）。
- **T21** `WorkgroupRoom.tsx`：消息流/回合分隔线/派单卡（状态 chip + NodeDetailDrawer 直达）/
  输入框 @ 补全/右侧成员状态栏；`useWorkgroupRoomWs` invalidation。公共组件复用自查
  （Dialog/Form/StatusChip/EmptyState/.btn）。测试：渲染/卡状态/@ 补全/发送/WS 失效规则。
- **T22** 接线：`TaskDetailTab` 加 `chatroom`、`availableTabs({isWorkgroup})` 组任务默认
  chatroom+隐藏 workflow-status；~~`/workgroups/launch` 启动页~~（**Superseded by RFC-165**：
  独立启动页已下线，工作组启动并入 `/tasks/new` 统一向导；body builder 迁至
  `lib/task-wizard.ts` 的 `buildWorkgroupStartBody`，goal 字段显式断言保留）；tasks 列表
  徽标 + `TaskSummarySchema.workgroupId`。测试：组/非组 tab 集对照锁、启动 body 组装、徽标。
- **T23** PR-4 门禁 + i18n/CSS 收敛（`.workgroup-` 命名空间）+ 视觉对齐自查截图。

## PR-5 人类成员 + 确认门 + 中途介入

- **T24** 人类单：deliver 端点（正文/结构化表单双形态归一 delivery 消息）+ 房间待办卡两入口 +
  收件箱第三源 `pending-count`（failure-soft）+ **撤 T14 临时守卫**。测试：双形态归一、
  下一轮消费注入、pending 计数、守卫撤除后启动含人组。
- **T25** 确认门（design §8.2 生命周期兼容版）：`decision=done` × gate 开 ⇒ **最终 leader run
  （fc：mint `wg-gate` 门 run）泊 `awaiting_review`** + task `awaiting_review` + confirm 端点
  （approve→门 run done+task done / reject 必带 comment→系统消息+唤醒新一轮，不回滚 worktree）
  + 房间确认卡 + **stuckTaskDetector S1 与 S1 自动修复链对 `workgroup_id` 非空任务豁免（两
  guard）**。测试：开/关 × approve/reject 四路 + 驳回意见注入 + lifecycleInvariants 兼容锁 +
  stuck 零误报 + 修复链跳过（三测分立）。
- **T26** 中途介入：`PUT config`（白名单字段 / 加成员不补历史〔尾窗起点锁〕/ 减成员单转置 /
  系统消息）。测试：全字段路径 + 两语义锁。
- **T27** PR-5 门禁 + Codex 增量审查。

## PR-6 free_collab + 收尾

- **T28** fc 引擎分支：首轮全员并行、`wg_tasks_add` 消费 + `dedup_key` 护栏（丢弃+系统消息）、
  平台代领 CAS、失败回 open 限次（defaultNodeRetries）、收敛判定 + 平台合成总结、
  fc 硬顶（成员 run 总数）、fc 死锁 failed。测试：全分支表驱动 + 并发代领原子性。
- **T29** fc 前端：右侧任务清单面板（open/claimed/done 分组 + 取消冗余单操作）+ 启动/编辑页
  fc 态（开关禁用已在 T5，补清单面板渲染测试）。
- **T30** 全量收尾门禁：四项门禁 + binary smoke + 全 AC-1..11 对照核验 + STATE.md 完工记录 +
  Codex 实现门终审。

## 依赖关系

T1→T2→…线性为主；PR 级依赖：PR-2 依赖 PR-1（schema），PR-3 依赖 PR-2（内核纯函数），
PR-4 依赖 PR-3（引擎产生的数据），PR-5 依赖 PR-4（房间 UI 承载待办/确认卡），
PR-6 依赖 PR-5（**硬顺序，设计门 Finding-4**：人类成员启动守卫〔T14〕必须先由 T24 撤除、
人类外显能力全量就位后，free_collab 才可发布，杜绝「界面宣示多人协作、后端拒绝含人组启动」
的失配中间态）。**接受的中间态（显式声明）**：PR-1 起组编辑器可添加人类成员，PR-5 前启动
此类组被守卫拒绝——报错文案须明示「人类成员支持将在后续版本开放」。

## 验收清单（对照 proposal AC）

| AC | 覆盖 PR |
| --- | --- |
| AC-1 资源面 | PR-1 |
| AC-2 lw 回合闭环 | PR-3 |
| AC-3 fc 闭环 | PR-6 |
| AC-4 互见开关矩阵 | PR-2（纯函数）+ PR-3（接线） |
| AC-5 聊天室 | PR-4 |
| AC-6 人类成员 | PR-5 |
| AC-7 反问沿用 | PR-3 |
| AC-8 终止/确认门 | PR-3 + PR-5 |
| AC-9 中途改配置 | PR-5 |
| AC-10 复用与零回归 | 每 PR 门禁 + PR-3 分流锁 |
| AC-11 门禁/Codex/UI 复用 | 每 PR |

## 风险与缓解

- **回合引擎复杂度**（最大风险）：内核判定全部纯函数化（T10/T11）先行落测，引擎壳（T15）
  只做编排；fake runner 桩隔离子进程。
- **多人树**：迁移共三个（A/B/C 分属 PR-1/2/3），每个都会撞 journal 计数锁——按
  [reference_migration_bumps_journal_count_test] 逐次 bump；提交一律精确路径单步 commit。
- **借壳方案对既有语义的意外触碰**：`agentOverrideName`/`shardKey` 均既有列既有语义
  （RFC-127/fanout），新增只是新 `rerunCause` 枚举值——枚举扩展点全量 grep 后再动（T15）。
- **写完测试必重跑 typecheck**（bun test 不做 tsc，RFC-159 事故）；push 后查 CI。

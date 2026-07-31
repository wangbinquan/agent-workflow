# RFC-242 · 任务分解与 PR 拆分

- 状态：Draft **v2**（随设计门一轮修订同步；待用户批准后实施）
- 依赖阅读顺序：`proposal.md`（D1–D16 + 勘误）→ `design.md` v2（机制）→ 本文。
- 单 RFC 多 PR（5 个，强顺序）：交付面横跨执行器收编 / 迁移 / 两种节点 / 前端，
  单 PR 评审与回滚粒度不可控；与 RFC-164（6 PR）同理由。每个 PR 独立全绿
  （typecheck / lint / test / format:check + 定向回归），行为变化只出现在声明的 PR。

## PR-1 统一执行器（行为零变化）

| 任务 | 内容 | 锚点 / 验收 |
|---|---|---|
| RFC-242-T1 | `services/execution/types.ts` + `executor.ts`：契约四类型；`startExecution` 分发三适配器（改名收编，校验顺序/错误码/副作用逐字节不变） | design §1.1；`rfc242-executor-facade.test.ts` |
| RFC-242-T2 | **五**调用面收编：`routes/tasks.ts:198`（JSON + **multipart `handleMultipartTaskStart`**）/ `routes/agents.ts:229` / `routes/workgroups.ts:174` / `scheduleLaunch.ts:47-72` 改走 `startExecution`；源代码文本锁「routes / scheduleLaunch / launchMultipart 不得直呼 start*」 | 既有 launch 测试 + e2e 零回归 |
| RFC-242-T3 | 引擎分流注册表 `engines.ts`：`resolveTaskEngine` 收敛 `scheduler.ts:620-664`；dw fail-fast 保留 | 现有 workgroup/dw 调度测试零回归 |
| RFC-242-T4 | 统一结果投影 `projectExecutionOutcome`：workflow/agent 按 **`pickUpstreamSourceRun` 口径**（`freshness.ts:179-213`）选行；workgroup 走 `result_message_id` 锚（PR-4 前对存量任务按回退链）；error 投影 | design §1.3/§6.4；`execution-outcome-projection.test.ts`（多代行矩阵 + fc 告警行不串味） |
| RFC-242-T5 | 终态观察 `executionWatch.ts`：**注册即同步查一次**、四终态 post-commit 发射、poll fallback、行缺失语义；单槽旧 hook 不动 | design §1.4 |

## PR-2 父子任务基建（schema + 横切）

| 任务 | 内容 | 锚点 / 验收 |
|---|---|---|
| RFC-242-T6 | 迁移：tasks 四列 + node_runs `child_task_id` + 双索引；drizzle/wire additive 字段（`ref_closure_json` **永不进 wire**，回归锁）；`space_kind` 加 `'inherited'` | design §2 |
| RFC-242-T7 | 引用闭包：`collectExecutionRefs`（name 选择器域）/ lazy BFS 冻结 / `detectCallCycles`（validate-draft 降级 + launch 权威双闸；issue 载荷 **id-only**）/ 子任务闭包子集下传 | design §3.1；`workflow-call-refs.test.ts` |
| RFC-242-T8 | 深度守卫 + 全局限额 `childBudget.ts`：**可放行者扫描制**（FIFO 仅公平序，修 P0-1 队头死锁）；计数只含 `{pending,running}` 子任务；状态转移层幂等簿记 + boot 重建；等待 60s 告警；配置 `maxInvocationDepth`=3 / `maxActiveChildTasks`=8 | design §3.2；`child-budget.test.ts`（含 P0-1 死锁构造反例） |
| RFC-242-T9 | 活性与告警：`classifyRunLiveness` child-task 证据（`child-task-active`、`livenessSourceOfKind`='delegated'）；S5 freshness 委派 **+ 子 awaiting 判非 stuck** | design §4.1 |
| RFC-242-T10 | 生命周期级联：`cancelTask` 递归级联 + **持久级联标记 `canceled-by-parent-cascade`**；`deleteTask` **双向门**（父 `task-has-active-children` / 子 `task-parent-active`）+ `inherited` 跳过删盘；`runWorktreeGc` 排除 `inherited`；**`runIsoWorktreeGc` 候选收紧**（interrupted 父不回收、活/interrupted 子引用不回收，修 P0-2）；`selectResumeRollbackTargets` 排除 call 行；子任务侧 `call-row-finalized` 闸；**§4.5 计时扣除**（`humanWaitMs` 落账 + `enforceLimits` 扣除 + awaiting 击杀缓冲） | design §4.3/§4.4/§4.5/§4.2 |
| RFC-242-T11 | `.git/worktrees` 注册表互斥 `getRepoRegistrySem`（键=`--git-common-dir` 归一；add/remove/prune 临界区；锁序 writeSem ≺ registrySem） | design §7.2；`rfc242-registry-mutex.test.ts` |
| RFC-242-T12 | 任务列表查询参 `include_children` / `parent_id`（backend，**默认过滤不在本 PR 翻转**——与 UI 同 PR，见 T24） | design §8 |

## PR-3 call-workflow 节点全链

| 任务 | 内容 | 锚点 / 验收 |
|---|---|---|
| RFC-242-T13 | shared 定义层：NODE_KIND **仅加 `call-workflow`**（`call-workgroup` 留 PR-4，堵「可保存不可执行」窗口）；`CallWorkflowNodeSchema`（**`workflowName` 权威 + `workflowId` 缓存**双字段）；behaviors 行、`WORKFLOW_NODE_FIELD_KEYS` 焦点键、引用清单 `NO_NODE_REFERENCES` 登记 | design §5.1；`call-node-ports.test.ts` |
| RFC-242-T14 | 端口派生：`PortDeriveContext.workflowByRef`（`'forbidden'`/`null` 两态）+ deriver；**五个 declaredPorts 消费面逐面接线**（画布/validator lazy targets/wrapperCandidates 共享 query/controlFlowEdge/dropTarget） | design §5.2 |
| RFC-242-T15 | 引用基建：extract×2 + 四 assert 点 RefCheckGroup；YAML 导出剥 id 缓存；**`IMPORT_REF_TYPES` 扩 `workflow`/`workgroup`** + `resolveImportRefs` 分支 + 前端映射 UI + **悬空 name 导入成功、launch fail-closed** | design §5.3/§5.5 |
| RFC-242-T16 | validator `4f.` 段（措辞统一「validate-draft 展示、launch 强制」）：存在性 / 端口完整性（upload 拒绝、output 重名）/ 跨定义环（id-only）/ 入边规则 / dw 生成物拒绝 call 节点 | design §5.4 |
| RFC-242-T17 | 调度执行 `services/callNode.ts`：D→L→W→F→M（不 acquire globalSem 源锁；F 幂等；失败映射含级联标记判别）；W 步 poll 兼驱 `humanWaitMs` 与 live 信息 | design §6.1/§6.2；`rfc242-call-workflow.test.ts` |
| RFC-242-T18 | 恢复与重试：adoption **锚定被派发行**（fanout `parentNodeRunId+shardKey`）四分支；`setNodeRunStatus` interrupted 复位逃生舱 + **禁 mint 源锁**；resume-child 失败重读回落；**R 按 merge_state 分段**（与 `replayPendingMerges` 所有权交接）；retryNode 前置取消旧子 | design §4.2；`rfc242-call-lifecycle.test.ts` |
| RFC-242-T19 | 叠加形态：fanout per-shard（分片行锚定不互认 + 限额背压 + fail-all 不变）+ loop 逐轮 + git wrapper diff 窗口锁定 | design §6.2 末段；`rfc242-fanout-call.test.ts` |

## PR-4 call-workgroup 节点

| 任务 | 内容 | 锚点 / 验收 |
|---|---|---|
| RFC-242-T20 | NODE_KIND 加 `call-workgroup` + `CallWorkgroupNodeSchema`（name/id 双字段 + goalTemplate）；迁移 `workgroup_task_state.result_message_id`；engine done 分支落结果锚（lw/fc 两写入点） | design §5.1/§6.4 |
| RFC-242-T21 | `startWorkgroupTaskFromFrozen`（保留 launch 门 ④–⑦；collaborators 并集；`autoCommitPush=false` 强制）；goal 模板渲染字面性；`result` 投影消费 + dw 字典序拼接 | design §6.3；`rfc242-call-workgroup.test.ts` |
| RFC-242-T22 | 失败映射（`workgroup-not-ready` / `max-rounds` / `fc-deadlock` / `dw-reject-exhausted`）与完成门停子任务链路 + §4.5 计时扣除覆盖 workgroup 门 | design §9 |

## PR-5 前端 + 列表口径 + e2e + 收尾

| 任务 | 内容 | 锚点 / 验收 |
|---|---|---|
| RFC-242-T23 | 画布：NODE_TYPES / 节点组件 / palette `calls` section / 两 Inspector（公共原语；**「引用不可见」占位态**）/ dropTarget / nodeTitle / i18n 双 locale | design §8/§5.2；组件测试 |
| RFC-242-T24 | 列表与口径**同 PR 翻转**：服务端默认 `parent_task_id IS NULL` + 父行展开 + 「含子任务」筛选 + 子任务父徽章；**overview 计数同口径排除子任务**；任务详情调用节点卡片（状态 chip + 直链）；子任务页 `parentTaskId` **访问权降级呈现** | design §8；列表/overview/详情测试 |
| RFC-242-T25 | e2e：真实 daemon call-workflow 链 + call-workgroup 链（stub 模型）；视觉对齐自查（CLAUDE.md 前端规程 4） | Playwright 2 场景 |
| RFC-242-T26 | 文档收尾：`docs/dev-gotchas.md` 跨任务锁序约定条目；`design/plan.md` 索引状态回填；STATE.md 收尾 | — |

## 验收清单映射

proposal §5 十条 ↔ PR：1→PR-1；2→PR-1；3→PR-3（T13-T16）；4→PR-3（T17-T19）；5→PR-4；
6→PR-2/3（T9/T10/T18）；7→PR-2（T7/T8）；8→PR-5（T24）；9→PR-3（T17/T19）；
10→每 PR 门禁 + 双门。

## 风险登记

- scheduler.ts 单文件高频冲突面——新逻辑集中 `services/callNode.ts`，主文件只加分支
  与接线；与并行 RFC 错峰合并。
- 注册表互斥（T11）触碰既有热路径——设计门保留降级选项（仅新链路持锁）。
- 设计门残余决策点见 design §12（饥饿老化 / dw 端口透传 / 限额默认值等，均不阻塞批准）。
- 设计门一轮 findings（2 P0 + 6 P1 + 14 P2）处置全录 `./design-gate-2026-07-31.md`。

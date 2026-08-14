# RFC-304 · 任务分解

> 产品视角见 [proposal.md](./proposal.md)，技术设计见 [design.md](./design.md)。
> 用户拍板：**一份 RFC 写完，plan.md 里拆多个 PR**（proposal A7）；**第一个 PR 交框架地基**（A8）。

## 0. 拆分原则

CLAUDE.md §RFC workflow 第 5 条允许「确需拆分时在 plan.md 说明并分别立 PR」。本 RFC 必须拆，
理由是单 PR 既无法评审也无法回滚，且中途任一处返工会阻塞全部。拆分沿两条线：

1. **地基先于能力**：工作项 + 阶段引擎 + 钩子是所有能力的共同底座，先独立交付并用最简流程验证。
2. **一条能力一个 PR**：每个能力 PR 交付后都**端到端可验收**，不留"跑不起来的半成品"。

每个 PR 独立满足 `bun run gate:local` 全绿 + 自带测试（CLAUDE.md §Test-with-every-change）。

## 1. 任务清单

### 地基（PR-1）

| # | 任务 | 依赖 |
| --- | --- | --- |
| T1 | 新建 `modules/code-capability/` 骨架：七层目录 + public 合同占位；边界规则接入既有 import 守卫 | — |
| T2 | `code_work_items` / `code_work_rounds` / `code_round_stages` 表与迁移 | T1 |
| T3 | 工作项状态机（domain 纯函数）+ CAS 写入（照搬 `lifecycle.ts` 姿势）+ 转移表穷举测试 | T2 |
| T4 | `StageContract` / `StageDef` 类型与注册；`kind: 'program'\|'ai'\|'script'` 强制标注 | T1 |
| T5 | `StageEngine`：按序推进、落 `code_round_stages`、失败传播 | T3,T4 |
| T6 | `DeterminismGuard`：envelope 提取 → schema 校验 → 领域校验 → 同会话重试 → 换会话重跑 → 失败 | T4 |
| T7 | `HookRunner`：抽出不依赖 `WorkflowNode` 的脚本调用面（复用 `assembleScriptEnv` + 受管子进程）；pre/post 挂载；注入数据白名单合并；blocking 语义 | T5 |
| T8 | 阶段契约版本化：钩子声明版本，升版后旧钩子显式报迁移 | T7 |
| T9a | **新增 execution kind `code-round`**（design D5）：`StartExecutionRequest` 增变体、task-execution 侧 participant、进程归属、取消与恢复语义。**须先与 task-execution owner 对齐**——这是本 RFC 唯一触及既有执行模块的改动 | T1 |
| T9 | `TaskLauncherPort` + 适配：起一轮 = 起一个 `code-round` task；新增独立任务类型并接入列表筛选 | T3,T9a |
| T10 | 抢占：新事件到达取消在跑轮次，幂等且不产生孤儿行 | T9 |
| T11 | 源码层负扫描：`kind:'program'` 阶段不得出现 agent 派发；`SAFE_FORWARD_ENV` 未被修改 | T4,T6 |
| T12 | 用一条最简内置流程（`prepare-worktree → 一个 program 阶段 → ledger`）端到端验证地基 | T5–T10 |

### 两层配置与模板（PR-2）

| # | 任务 | 依赖 |
| --- | --- | --- |
| T13 | `capability_frameworks` / `capability_bindings` 表；两类资源接入既有资源框架（owner/visibility/grants/复制） | T1 |
| T14 | 部门层写权额外要求 `scripts:author`；小组层不得写入脚本与钩子字段（服务端遮蔽 + 拒绝） | T13 |
| T15 | 参数继承：框架声明 `paramSchema` 与默认值，绑定覆盖；解析顺序与来源可追溯 | T13 |
| T16 | `repo_capability_config`（仓库 × 能力矩阵）+ 仓库 ACL 判据接入 | T13 |
| T17a | **扩 RFC-271 的闭合集合**（设计门 P1：它今天不是通用包格式）：`ResourcePackageTypeSchema` 只接受六种（`packages/shared/src/schemas/resourcePackage.ts:18`）、`BundleOp` 是固定十二分支 union（`packages/shared/src/bundle/op.ts:87`）、`bundle.ts:42` 同样只识别六类。需逐项扩：type enum、bundle payload、BundleOp 变体、引用闭包解析、serialize/parse、preview/commit apply provider、importer | T13 |
| T17b | 两类资源接入配置包：闭包、`requirements`、`secrets[]` 脱敏索引 + 往返测试 | T17a |
| T18 | 内置两套：标准 GitLab/GitHub 框架（不接自建系统）+ 五套默认 agent 绑定，`built-in` + `public` | T15 |

### 代码平台发布能力（PR-3）

| # | 任务 | 依赖 |
| --- | --- | --- |
| T19 | 扩 `CODE_HOST_ACTIONS`：GitLab `draft_notes` 创建 / `bulk_publish`；GitHub `pulls/reviews`（带 `comments[]`）。注册表是 `satisfies Record<CodeHostAction, ...>`，**两家都必须给 binding**——GitLab 独有的 draft_notes 在 GitHub 侧显式标 `unsupported` + reasonKey（`singleRequestReview`），反之亦然，否则 typecheck 红 | — |
| T20 | position 组装（domain 纯函数）：两家各自形态，新增/删除/上下文行 | — |
| T21 | 批量发布器：草稿逐条 → 部分失败清理已建草稿 → 整轮失败；GitHub 单请求语义 | T19,T20 |
| T22 | `thread.resolve` 批量化用于 `cleanup-previous` | T19 |

### MR 检视（PR-4）—— 第一条端到端能力

| # | 任务 | 依赖 |
| --- | --- | --- |
| T23 | `split-diff`：按目录层级聚合 + 体量上限，确定性 | T4 |
| T24 | `review-shard`（并行 AI 段）+ `review-global`；aiSchema 定义 | T6,T23 |
| T25 | `validate-findings`：结构 + 行号在**原始 diff** 内（不读当前工作树，锁 AC-4） | T6,T23 |
| T26 | `gate`：确定性排序 → 阈值过滤 → 上限截断 + 未展开计数 | T25 |
| T27 | `code_findings` 台账 + `fingerprint`（行号不入指纹）+ `dedupe` | T2 |
| T28 | `cleanup-previous`：resolve 上轮 bot 线程，保留人类回复 | T22,T27 |
| T29 | `publish`：草稿攒齐一次性发布 + 锚不上的并入总览评论 | T21,T26 |
| T30 | 采纳信号：`resolved`（回读线程）与 `code_changed`（下轮比对锚定行）分列落账 | T27 |
| T31 | `mr-review` 阶段契约 v1 装配 + webhook 触发路由（含"bot 自动提的 MR 可配置不检视"） | T23–T30,T16 |

### 前端最小面（PR-5）

| # | 任务 | 依赖 |
| --- | --- | --- |
| T32 | `/code` 路由与导航；仓库 × 能力矩阵配置页（复用既有表单原语） | T16 |
| T33 | 状态机流转图第一、二层：工作项状态 + 展开当前轮阶段 | T5 |
| T34 | 任务列表按新任务类型筛选 | T9 |

### MR 监视器（PR-6）

| # | 任务 | 依赖 |
| --- | --- | --- |
| T35 | 四个脚本契约（collect / classify / arbitrate / select）+ 返回 schema 校验 | T7 |
| T36 | 主循环：事件唤醒 → 四脚本 → 起一轮；**零轮询**断言 | T35,T9 |
| T37 | 默认优先级仲裁（框架未覆盖时）：冲突 > 评论 > CI；CI 内三档 | T35 |
| T38 | 多项工作包：一轮内依次做完、统一推送一次 | T36 |
| T39 | 冲突检测与报告（**不修**） | T36 |
| T40 | 闭环：MR 合并/关闭 → `closed`，停止后续 | T36 |

### 评论驱动改码（PR-7）

| # | 任务 | 依赖 |
| --- | --- | --- |
| T41 | `decide-form`：单文件 + 连续行数在阈值内 ⇒ suggestion，否则 patch | T4 |
| T42 | suggestion 渲染（两家语法）与发布 | T41,T19 |
| T43 | patch 路径：贴 diff → `awaiting` → 关键词识别 → `verify-baseline` → push | T41,T3 |
| T44 | 权限：suggestion 放宽到仓库写权限者；推送锁 MR 作者，bot MR 读 `initiatorUserId` | T43 |
| T45 | 源分支变化作废 + 回帖说明 | T43 |

### 需求实现（PR-8）

| # | 任务 | 依赖 |
| --- | --- | --- |
| T46a | **新增 issue 事件面**（设计门核实：今天完全不存在）：`CODE_HOST_EVENT_TYPES` 增 `issue_labeled` / `issue_comment`；GitLab adapter 放开 `noteable_type === 'Issue'` 分支并解析 label hook；GitHub adapter 放开非 PR 的 `issue_comment` 与 `issues.labeled`；变量表补 issue 侧字段；触发器 UI 与校验跟进 | — |
| T46b | 三入口：issue 标签 webhook / `/code` 界面 / 平台 API | T16,T46a |
| T47 | 模板声明参数表 → 平台渲染表单 + 校验（界面与 API 共用同一校验） | T15,T46 |
| T48 | 入口脚本：只给引用时取回 `{title, body, attachments, writebackHandle}` | T7,T46 |
| T49 | `clarify` 分流：有回写句柄且框架支持 ⇒ 回写 issue 评论；否则落平台。**回答的收取同样依赖 T46a**——answer 需带 round/question 标记以关联到具体那一问，并给提问者回执；issue 侧双向通道不可用时**拒绝启用该入口并说明原因**，不静默回退到平台 clarify（否则报告人永远等不到他以为会出现在 issue 里的问题） | T48,T46a |
| T50 | `implement` → `run-target-gate`（读目标仓 CLAUDE.md/CONTRIBUTING）→ `self-review`（复用 PR-4 阶段）→ `open-mr` | T31 |

### CI 修复（PR-9）

| # | 任务 | 依赖 |
| --- | --- | --- |
| T51 | 采集/分类脚本接入自研流水线（框架侧样例脚本 + schema 校验） | T35 |
| T52 | `fix` → `validate-fix`（跑门禁脚本）→ 重跑循环上限 3 轮 | T6,T51 |
| T53 | `anti-cheat-check`（程序）：删断言 / 加 skip / 测试行净减 ⇒ 要求论证，缺则本轮失败 | T52 |
| T54 | 三轮未成功 ⇒ 停止并回帖汇总每轮尝试 | T52 |

### 前端完整面（PR-10）

| # | 任务 | 依赖 |
| --- | --- | --- |
| T55 | 状态图第三层：每次 AI 调用（envelope 校验结果、重试次数），可跳转任务详情 | T33,T6 |
| T56 | 轮次切换回看 | T33 |
| T57 | 模板管理页：两层资源的列表、复制、配置包导入导出 | T17 |
| T58 | 采纳率与运行度量面 | T30 |

## 2. PR 顺序与并行性

```
PR-1 地基 ──┬─► PR-2 配置 ──┬─► PR-4 检视 ──┬─► PR-6 监视器 ──► PR-9 CI 修复
            │               │              ├─► PR-7 评论改码
            │  PR-3 发布 ───┘              └─► PR-8 需求实现
            └─► PR-5 前端最小面                       │
                                          PR-10 前端完整面 ◄──┘
```

- **PR-3 可与 PR-1/2 完全并行**（它只动 `codeHost` 动作注册表，与新模块无交集）。
- **PR-4 是第一个用户可见价值点**，也是 PR-7/8/9 的前置（三者都要"自己审自己"）。
- **PR-6 之后 PR-7/8/9 可并行**，各自独立可验收。

## 3. 验收清单

| PR | 覆盖的 AC（proposal §9） | 门禁 |
| --- | --- | --- |
| PR-1 | **AC-8（主）**、AC-9、AC-10、AC-20、AC-23、AC-27、AC-28 | 状态机穷举 + 负扫描 + 两级重试三档用例 + 最简流程集成 |
| PR-2 | AC-18、AC-19、AC-21、AC-22、AC-24（框架部分） | 权限拒绝用例 + 参数继承用例 + 配置包往返 |
| PR-3 | —（为 AC-1/3/6 提供能力） | 两家发布载荷断言 + 部分失败清理 |
| PR-4 | AC-1、AC-2、AC-3、AC-4、AC-5、AC-6、AC-6b、AC-7、AC-7b、AC-8（接线）、AC-24 | position 纯函数表驱动 + 完整一轮集成 + 第二轮三集合对账 + fork MR 端到端（两家）|
| PR-5 | AC-25（前两层）、AC-27 | 组件测试 + e2e 冒烟 |
| PR-6 | AC-11、AC-12、AC-15、AC-28 | 零轮询断言 + 多项工作包一次推送 + 抢占无孤儿 |
| PR-7 | AC-16、AC-17 | 权限拒绝 + awaiting 全链 + 基线变化作废 |
| PR-8 | AC-8（本能力 AI 阶段的接线证明）、AC-14c、AC-22 | 三入口参数校验 + issue 事件面往返 + clarify 出站/入站两条路径 |
| PR-9 | AC-13、AC-14 | anti-cheat 结构检查用例 + 三轮上限 |
| PR-10 | AC-25（第三层）、AC-26 | e2e：配置 → 发起 → 状态图三层 → 切轮次 |

## 4. 风险与前置

| 风险 | 应对 |
| --- | --- |
| draft_notes / bulk_publish 在部署侧版本上的实际行为（proposal §10-1） | PR-3 先做一次真实实例探测；不可用则退化为"逐条发布 + 明确的通知代价"，并回改 proposal B10 |
| 上下文行 position 的接受条件（§10-2） | PR-3 探测；纯函数已按"同时给 old/new"实现，实测后仅改常量 |
| 抽出不依赖 `WorkflowNode` 的脚本调用面（T7） | 该重构触及 RFC-253 既有实现，**必须保持 script 节点行为逐字节不变**，以既有 script 测试为回归网 |
| 新任务类型接入既有筛选（T9） | 需确认任务类型枚举的扩展点，避免在 `routes/`/`services/` 平铺层加分支 |
| 自研流水线脚本 schema 覆盖率（§10-7） | PR-9 前先用真实日志样本验证 schema，不足则扩字段而非放宽校验 |

## 5. 不在本 RFC 范围

- fanout 内层 kind 扩展与内链（RFC-294 W8，需 W7 先落地，**另立新号**）。
- 冲突修复、主干流水线修复、跨 MR 批量视图（proposal §11）。
- 顺手记账：`routes/workflows.ts:60` 的 `import {} from '@/services/workflow.yaml'` 空导入死代码，
  属 CLAUDE.md §6 可直接清理的例外，不占本 RFC 任务号。

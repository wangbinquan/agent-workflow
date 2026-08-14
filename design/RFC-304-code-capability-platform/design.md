# RFC-304 · 技术设计

> 产品视角见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)。
> 本文的一切设计从 proposal §2 的**两条宪法**推导；与宪法冲突的设计一律作废。

## 1. 目标架构对齐（RFC-294，CLAUDE.md §RFC workflow 第 8 条）

### 1.1 落位：新增 bounded context `code-capability`

RFC-294 §3 列出「最终后台**至少**形成以下 bounded contexts」共 13 个，其中没有承载本 RFC 的一档：

- `integration` 的职责是「webhook、schedule、code-host ingress/egress 及其**触发合同**」——它是**通道**，
  本 RFC 的工作项、阶段序列、优先级仲裁、意见台账都不是通道语义，塞进去会让 integration 从
  「事件进出」膨胀成「代码协作业务」。
- `task-execution` 拥有 Task/NodeRun 生命周期。工作项是**比 task 长一个数量级**的业务对象
  （跨事件、跨天、跨多个 task），把它并进去会污染 RFC-294 W7 正在收敛的 NodeRun 身份轴。
- `collaboration` 是 human gate（review/clarify/question），本 RFC 消费它而不属于它。

因此新增 `code-capability`。RFC-294 的措辞是「至少」，新增不与总纲冲突，但**这是本 RFC 的第一条
偏离项，需用户确认**（§1.4）。

### 1.2 模块内分层

```
modules/code-capability/
  domain/           工作项状态机与转移表 · 阶段契约 · 优先级仲裁规则 · 意见指纹
                    position 组装规则 · 采纳信号判定 —— 纯函数，零 IO
  application/      命令与查询：发起 / 唤醒 / 推进一轮 / 发布 / 落账 / 读模型
  engine/           StageEngine（阶段执行）· HookRunner · DeterminismGuard（R3/R4/R5）
  ports/            CodeHostPort · ScriptRunnerPort · TaskLauncherPort · LedgerPort
                    · ClarifyPort · WorktreePort（application-owned，接口在此、实现在 infrastructure）
  infrastructure/   sqlite 台账与工作项存储 · code-host 适配 · 脚本执行适配
  public/           commands / queries / participants / events / types
  inbound/          HTTP 路由适配 · webhook 事件适配 · 定时唤醒适配
  composition/      装配（唯一 new 具体实现的地方，不做业务判断）
```

与既有 `integration` 模块的形态一致（`modules/integration/{domain,application,infrastructure,public,composition}`）。

### 1.3 跨模块依赖：只走 public 合同

| 依赖 | 用途 | 合同 |
| --- | --- | --- |
| `integration.public` | 归一化 webhook 信封、code-host 出站调用 | 事件订阅 + 调用命令 |
| `task-execution.public` | 起一轮（= 一个 task）、查状态、取消抢占 | 启动命令 + 状态查询 + 事件 |
| `source-control.public` | worktree 准备与回收、diff 读取 | 命令 |
| `resource-catalog.public` | agent 解析、模板资源 CRUD 与 ACL | 查询 + 命令 |
| `collaboration.public` | 反问（clarify）发起与作答回收 | 命令 + 事件 |

**禁止**：读对方的表、import 对方 `domain/` 或 `infrastructure/` 下任何符号、复用对方的全局单例。
新增代码**不得**在 `routes/` 或 `services/` 平铺层落任何跨域 facade。

### 1.4 偏离项清单（呈用户确认）

| # | 偏离 | 理由 | 备选与代价 |
| --- | --- | --- | --- |
| **D1** | 新增第 14 个 bounded context | 三个候选 context 收编它都会破坏各自的职责边界（§1.1） | 并入 `integration`：让通道模块承载业务聚合，后续 W-wave 拆分成本更高 |
| **D2** | 引入**第二套生命周期状态机**（工作项），与 task 状态机并存 | 两者层次不同：工作项跨多个 task；等待人回应发生在工作项层，故不存在"挂着一个 task 空等三天" | 复用 task 状态机：需要 task 支持天级挂起，与 RFC-097 转移表和恢复语义正面冲突 |
| **D3** | 编排层不落 `workflow_definitions`，自带阶段序列定义 | 阶段序列平台写死且版本化，与用户可编辑的工作流定义语义不同；混存会互相污染校验规则 | 复用 workflow 表：用户会在工作流列表里看到一堆不可编辑的系统行 |
| **D4** | 脚本挂载点直接消费 `scriptRun` 的执行机制而非 script **节点** | 钩子与适配脚本不是工作流节点，没有画布位置与端口连线 | 造成第二套脚本执行实现——**不接受**，故复用机制、不复用节点 |

D4 不算真偏离（复用机制是对的），列出是为了说明「为什么钩子不是 script 节点」。

## 2. 领域模型

### 2.1 工作项（CodeWorkItem）——聚合根

一个工作项 = 一个被跟进的外部对象。**身份键**：

```
(provider, projectRef, capability, anchorRef)
例：('gitlab', 'platform/api', 'mr-review',  '412')      一个 MR 的检视
    ('gitlab', 'platform/api', 'mr-monitor', '412')      同一个 MR 的监视
    ('gitlab', 'platform/api', 'requirement', 'issue-88') 一个需求
```

`mr-review` 与 `mr-monitor` 是**两个**工作项而非一个：proposal E1 拍板「检视独立于监视器」，
两者的触发源、闭环条件、台账内容都不同。它们通过同一个 `anchorRef` 关联，在状态图上并列展示。

### 2.2 工作项状态机

```
                     ┌──────────── 同一对象的新事件（抢占在跑的轮次）
                     ▼
  idle ──event──► queued ──►  running  ──publish ok──►  settled ──┐
                     ▲            │                        │       │
                     │            ├─需要人回应─► awaiting ──┘       │
                     │            │                 │              │
                     │            └──►  failed      │ 源分支变 → 作废
                     └──── 人回复 ────────────────────┘              │
                                                                    ▼
                          外部闭环（MR 合并/关闭 · 线程 resolve · 流水线转绿）→ closed
```

转移表（CAS 写入，照搬 `services/lifecycle.ts` 的 `trySetTaskStatus` 姿势）：

| from | event | to | 副作用 |
| --- | --- | --- | --- |
| `idle`/`settled`/`awaiting` | 外部事件到达 | `queued` | 若有在跑轮次 → 请求 `task-execution` 取消 |
| `queued` | 调度取用 | `running` | 起一个 task（一轮） |
| `running` | 轮次完成且已发布 | `settled` | 落台账 |
| `running` | 轮次产出需人回应 | `awaiting` | 记录等待句柄（线程 id / clarify 会话 id） |
| `awaiting` | 人回复 | `queued` | 起**新一轮**，不复活旧 task |
| `awaiting` | 基线 sha 变化 | `settled` | 作废并回帖说明 |
| `running` | 轮次失败 | `failed` | 平台内告警，MR 静默 |
| `failed` | 人工重试 / 新事件 | `queued` | |
| 任意非 `closed` | 外部闭环事件 | `closed` | 停止一切后续 |

**不变量**：同一工作项同时最多一个 `running` 轮次（proposal G7）。抢占通过取消旧 task 实现，
新轮不等待旧轮清理完成——旧 task 的取消由 `task-execution` 既有语义保证幂等。

### 2.3 轮次（Round）

一轮 = 一次 `queued → running → 终态`，物化为**一个 task**。轮次记录：

```
roundSeq          从 1 递增，永不复用
capability        本轮执行哪条能力
templateRef       本轮用的框架版本 + 绑定版本（快照，非引用——中途改配置不影响在跑的轮）
baselineSha       本轮基于哪个 commit（awaiting 作废判定、position 组装都要它）
workPackage       仲裁脚本返回的本轮工作包（可含多项，E8）
taskId            task-execution 侧的 id
stageContractVer  本轮使用的阶段契约版本
```

### 2.4 意见与台账（Finding / Ledger）

```
fingerprint    sha256(normalize(file) + ':' + normalize(body核心)) —— 跨轮去重的唯一依据
                行号**不进指纹**：代码一动行号就变，进指纹会让同一问题反复重提
externalId     发布后拿到的 comment/thread id
publishedRound 首次发布于哪一轮
resolvedAt     信号一：线程被 resolve
codeChangedAt  信号二：下一轮发现该锚定行的代码实际变了
degradedReason 未能锚定到行时的原因（行不在 diff / 文件不在 MR / 基线漂移）
```

两个采纳信号**分列存储、不合成单一指标**（proposal C6）。

### 2.5 模板：两层

```
CapabilityFramework（部门层）        CapabilityBinding（小组层）
  scripts: {entry, collect,            frameworkRef      ← 一个能力只引用一个框架
            classify, arbitrate}       agentBySlot: {}   ← 每个 AI 步骤用哪个 agent
  hooks: [{stage, phase, script,       promptBySlot: {}
           blocking}]                  params: {}        ← 覆盖框架默认值
  paramDefaults: {}                    paramSchema 由框架声明、平台渲染表单
  stageContractVer
```

两者都是资源（owner / visibility / grants / 复制 / 配置包导出）。`CapabilityFramework` 的写权限
额外要求 `scripts:author`——它承载脚本与钩子，等于 daemon 全凭据面（proposal C2）。

## 3. 数据模型

新增表（全部落在 `code-capability/infrastructure`）：

| 表 | 要点 |
| --- | --- |
| `code_work_items` | 身份键唯一索引；`status`；`currentRoundId`；`anchorMeta`（MR/issue 元信息快照）；`initiatorUserId`（C3 的"事实作者"）；`closedAt` |
| `code_work_rounds` | `workItemId` + `roundSeq` 唯一；`taskId`；`baselineSha`；`workPackage`；`templateSnapshot`；`stageContractVer`；`outcome` |
| `code_round_stages` | 每阶段一行：`stageName`、`status`、`startedAt/endedAt`、`attemptCount`、`envelopeValidation`（供状态图第三层） |
| `code_findings` | 台账，见 §2.4；`(workItemId, fingerprint)` 唯一 |
| `capability_frameworks` | 部门层模板资源 |
| `capability_bindings` | 小组层模板资源 |
| `repo_capability_config` | 仓库 × 能力矩阵：`repoId` + `capability` 唯一，指向一个 binding，带启用开关与触发配置 |

`initiatorUserId` 是 C3 的落点：bot 开的 MR 上，「作者确认推送」的判定读它而不是 MR 的 author。

## 4. 阶段引擎

### 4.1 阶段契约与版本化

每条能力有一个**平台内置、代码内定义**的阶段序列，带契约版本号：

```ts
interface StageContract {
  capability: Capability
  version: number                    // 阶段集合或语义变化时 +1
  stages: readonly StageDef[]
}
interface StageDef {
  name: string                       // 公开契约，钩子按它挂载
  kind: 'program' | 'ai' | 'script'  // 宪法 R1/R2 的强制标注
  parallel?: boolean                 // 并行段：钩子整段前后各一次（F5）
  requires: readonly string[]        // 需要的前置产物 —— 结构校验依据
  produces: readonly string[]
  aiSchema?: JSONSchema              // kind==='ai' 必填，宪法 R3
}
```

`kind` 字段不是注释而是**强制约束**：`kind: 'program'` 的阶段其实现不得调用任何 agent 派发
（源码层负扫描锁定，AC-10）。

钩子声明它针对的 `stageContractVer`；平台升版后，声明旧版本的钩子**显式报需要迁移**而不是静默
跳过（F9 / AC-23）。

### 4.2 确定性守卫（宪法 R3/R4/R5）

`DeterminismGuard` 包住每个 `kind: 'ai'` 阶段：

```
run AI step
  → 提取 envelope（复用 services/envelope.ts 的 extractLastEnvelope + nonce）
  → 按 aiSchema 校验结构
  → 领域校验（行号在 diff 内、file 在改动集合内、severity 合法…）
  → 通过 ⇒ 产出确定值，进入下一阶段
  → 不通过 ⇒ 带**具体错误**同会话重试（≤ N 次）
              ⇒ 仍不过 ⇒ 丢弃会话、换新会话重跑（≤ M 次）
              ⇒ 两级耗尽 ⇒ 阶段失败
```

同会话重试与换会话重跑的区别是有意的：前者便宜且保留已读代码的上下文，后者跳出已经跑偏的上下文。
nonce 沿用脚本/agent 同一套（`services/scriptPorts.ts` 的注释已明确 nonce 防的是上游内容伪造，
不防作者本人——对钩子注入数据而言这正是所需语义）。

### 4.3 钩子执行

- **位置**：每个阶段边界 `pre:<stage>` / `post:<stage>`；并行段整段前后各一次。
- **执行机制**：复用 `services/scriptRun.ts` 的 `assembleScriptEnv` + 受管子进程，**不复用 script 节点**（D4）。
- **上下文**（F10）：环境变量给工作项基本信息（`AW_CWI_*`：capability / anchor / round / baselineSha /
  worktree / repos），当前阶段的输入输出走文件（大对象如 findings 列表 spill 到 `AW_INPUT_DIR`）。
- **权力**（F6）：
  - 副作用——直接改工作树；
  - 注入数据——envelope 输出，平台按阶段定义的可注入字段白名单合并（如 `promptSuffix`、`extraContext`）；
  - 中止——非零退出且声明了 `blocking: true` ⇒ 本轮失败。
- **失败语义**（F8）：每个钩子自己声明 `blocking`。非阻断钩子失败只记事件。

## 5. MR 监视器

### 5.1 主循环

```
外部事件（MR / note / pipeline webhook）
  → 唤醒工作项（不轮询，N7/E3）
  → collect   脚本：拉全量状态（含自研流水线门禁）      → CollectResult
  → classify  脚本：把失败日志分类                      → Issue[]
  → arbitrate 脚本：按优先级选出本轮工作包（可多项）     → WorkPackage
  → select    脚本：为工作包选 agent 与提示词           → AgentPlan
  → 起一轮（一个 task），依次做完这批，统一推送一次      （E8）
  → 回到唤醒等待
闭环：MR 合并 / 关闭 → closed
```

四个脚本全部由**部门层框架**提供；平台只定 schema、不猜实现（§3.1 外部系统适配原则）。
默认优先级（框架未覆盖时）：冲突 > 评论 > CI；CI 内：编译 > codecheck > UT 覆盖率（E6）。

### 5.2 脚本契约

```ts
// collect —— 输入：工作项上下文（env）。输出（envelope）：
interface CollectResult {
  conflict: boolean
  unresolvedComments: Array<{ threadId: string; author: string; body: string; anchor?: Anchor }>
  gate: { status: 'pass'|'fail'|'running'|'unknown'; runId?: string; rawLogRef?: string }
  headSha: string
}
// classify —— 输入：collect 的 gate + 日志。输出：
interface ClassifiedIssue { type: string; file?: string; line?: number; message: string; raw?: string }
// arbitrate —— 输入：CollectResult + ClassifiedIssue[]。输出：
interface WorkPackage { items: Array<{ kind: string; ref: string }>; note?: string }
// select —— 输入：WorkPackage。输出：
interface AgentPlan { bySlot: Record<string, { agent: string; promptSuffix?: string }> }
```

四者**全部是脚本，无 AI 参与**（宪法 R1，AC-10 源码层锁定）。

## 6. 阶段序列（内置）

### 6.1 `mr-review`

```
resolve-target(program) → prepare-worktree(program) → fetch-diff(program)
→ split-diff(program) → review-shard(ai, parallel) → review-global(ai)
→ validate-findings(program) → gate(program) → resolve-positions(program)
→ dedupe(program) → cleanup-previous(program) → publish(program) → ledger(program)
```

- `split-diff`：按目录层级聚合，受行数上限约束（B7）。同目录改动尽量同块；超限再切。**确定性**：
  同一 diff 必然得到同一分块（供重跑复现）。
- `review-shard` 的 worktree 是可写一次性树（B8）；agent 可跑测试甚至试改。
  **行号锚定**：`fetch-diff` 产出的原始 diff 是唯一锚定基准，agent 自身改动不影响锚定（AC-4）——
  实现上 `validate-findings` 用 `fetch-diff` 的产物校验，不读当前工作树状态。
- `gate`：先按 (severity, file, line) 确定性排序，再按阈值过滤、按上限截断。

### 6.2 `mr-comment-fix`

```
resolve-target → collect-thread(program) → prepare-worktree → apply-change(ai)
→ validate-change(program) → decide-form(program) → publish-suggestion(program)
                                                 ↘ post-patch(program) → [awaiting]
                                                     ← 人回关键词 → verify-baseline(program) → push(program)
```

`decide-form`（B/C1）：改动限于单文件且连续行数在阈值内 ⇒ 走原生 suggestion（无需写权限）；
否则走贴 diff + 等确认。`verify-baseline` 在推送前校远端 sha，变了就放弃（C7）。

### 6.3 `requirement`（issue 修复 + 设计文档实现，合并）

```
resolve-input(program|script) → materialize-attachments(program) → prepare-worktree
→ comprehend(ai) → [信息不足 → clarify(program) → awaiting]
→ implement(ai) → run-target-gate(program) → self-review(复用 mr-review 的核心阶段)
→ open-mr(program) → ledger
```

`resolve-input`：参数够用则直接进；只给了引用（如 issue 编码）则跑入口脚本取回
`{title, body, attachments, writebackHandle}`（D5）。`clarify` 按 D2 分流：有 `writebackHandle`
且框架实现了回写 ⇒ 回写 issue 评论；否则落平台 clarify。

### 6.4 `ci-fix`

```
collect(script) → classify(script) → arbitrate(script) → select(script)
→ prepare-worktree → fix(ai) → validate-fix(program) → self-review(ai)
→ anti-cheat-check(program) → push(program) → ledger
```

`anti-cheat-check`（E7）：对本轮 diff 做结构检查——删除断言 / 新增 skip / 测试行净减少 ⇒ 标记高
严重度并要求 `fix` 阶段的 envelope 里带上"为什么这个测试本来就该挂"的论证；缺论证则本轮失败。
这一步是**程序**，不是让 AI 自评。

### 6.5 `mr-monitor`

不是线性序列，是 §5.1 的循环。它的每一次"起一轮"派发到上面四条之一。

## 7. 行级定位与批量发布

### 7.1 position 组装（程序，无 AI）

```
GitLab   拉 GET /projects/:id/merge_requests/:iid → diff_refs{base_sha,start_sha,head_sha}
         新增行 → {position_type:'text', new_path, new_line, ...diff_refs}
         删除行 → {position_type:'text', old_path, old_line, ...diff_refs}
         上下文行 → old_path+old_line 与 new_path+new_line **同时**给（待实证 §10-2）
GitHub   {path, line, side, start_line?, start_side?}；commit_id 由 review 统一给
```

锚定判定完全基于 `fetch-diff` 的产物：行必须在本次 diff 的 hunk 覆盖范围内。不在 ⇒ `degraded`。

### 7.2 批量发布

```
GitLab   逐条 POST draft_notes（失败即整体放弃并清理已建草稿）→ 一次 bulk_publish
GitHub   一次 POST /pulls/{n}/reviews，body=总览，comments[]=行级意见
```

**部分失败语义**：草稿阶段任一条失败 ⇒ 删除本轮已建草稿、整轮失败，MR 上不留半截（B10 的
"一次性发布"在失败路径上同样成立）。锚不上的意见并入 `body` 总览（B11）。

## 8. 权限与凭据

| 面 | 判据 | 说明 |
| --- | --- | --- |
| 配置仓库 × 能力 | 该仓库的管理权（走既有仓库 ACL） | 不新增权限体系（G6） |
| 编辑小组层 binding | 该 binding 资源的写权 + 引用的 agent 可见 | 普通资源 ACL |
| 编辑部门层 framework | 资源写权 **且** `scripts:author` | 承载脚本与钩子 = daemon 全凭据（C2） |
| 叫机器发 suggestion | 代码平台侧对该仓有写权限 | 反查平台权限（C2） |
| 叫机器推送 | MR 作者；bot 开的 MR ⇒ `initiatorUserId` | C3 |
| 平台 API 发起 | 普通 PAT + 对目标仓的可见性 | 发起不涉及特权配置 |

**凭据边界不变**：agent 进程的 `SAFE_FORWARD_ENV` 白名单逐字节不动（N5 / AC-20）；一切需要凭据的
外部访问都发生在**脚本**里（脚本继承 daemon 环境，`services/scriptRun.ts:325`）或**平台代发**
（code-host 调用，RFC-269 的 token 密封路径）。

## 9. 失败模式

| 场景 | 处理 |
| --- | --- |
| AI 输出不合 schema | R4 两级重试；耗尽则阶段失败（AC-8） |
| 脚本非零退出 | 按该脚本/钩子声明的 blocking 决定阻断或记事件（F8） |
| `diff_refs` 拉不到 | 整轮失败；MR 静默、平台告警（B17） |
| 全部意见都锚不上 | 仍发布一条总览评论，`published=0 / degraded=N`，轮次算成功 |
| 草稿部分失败 | 清理已建草稿、整轮失败，MR 上不留半截（§7.2） |
| 推送时远端已变 | 放弃并回帖请重叫（C7） |
| 等待期间源分支变化 | 工作项从 `awaiting` 作废回 `settled`，回帖说明（§2.2） |
| daemon 重启 | 轮次是 task ⇒ 复用既有 interrupted 修复；工作项状态由轮次终态驱动重算 |
| 抢占时旧 task 尚未清理完 | 新轮不等待；旧 task 取消幂等由 task-execution 保证 |
| 工作项引用的 binding 被删 | 轮次用的是模板**快照**，在跑的轮不受影响；下一轮拒绝启动并告警 |

## 10. 与既有机制的耦合点

| 既有机制 | 耦合方式 | 风险 |
| --- | --- | --- |
| webhook 入站（RFC-257/259） | 订阅归一化信封，新增一条"代码能力路由" | 低——不改入站链路 |
| 任务引擎 | 每轮起一个 task，新增独立任务类型（G7） | 中——需确认任务类型枚举扩展点 |
| code-host 调用（RFC-269） | 复用动作注册表与凭据；**新增**批量发布与 draft_notes 动作 | 中——动作表新增列 |
| 脚本执行（RFC-253） | 复用 `assembleScriptEnv` 与受管子进程 | 中——需要抽出不依赖 WorkflowNode 的调用面 |
| clarify（RFC-023 家族） | 反问走 `collaboration.public` | 中——需要"外部回写"这条新通道 |
| 配置包（RFC-271） | 两类新资源接入闭包与 requirements | 低——资源框架通用 |
| 资源 ACL（RFC-099/231） | 两类新资源按既有六类同构接入 | 低 |

## 11. 测试策略

按 CLAUDE.md §Test-with-every-change，以下 case **必写**：

**纯函数预言（首选可断言面）**

- 工作项状态机转移表：全部合法转移 + 非法转移被拒（表驱动穷举）。
- `fingerprint` 归一化：行号变化不改变指纹；正文空白/大小写归一；不同问题不碰撞。
- `split-diff`：同一 diff 必得同一分块；超限切分；空 diff；单文件超限。
- position 组装：新增行 / 删除行 / 上下文行 / 文件重命名；GitLab 与 GitHub 两家各一组。
- 锚定判定：行在 hunk 内 / 边界 / 外；文件不在 diff。
- `gate`：排序确定性、阈值过滤、上限截断与"未展开条数"计数。
- 优先级仲裁默认规则：冲突 > 评论 > CI；CI 内三档。

**确定性守卫**

- envelope 不合 schema ⇒ 同会话重试 ⇒ 换会话重跑 ⇒ 阶段失败，三级各一条。
- 领域校验失败（行不在 diff）触发重试而非直接发布。
- **源码层负扫描**：`kind: 'program'` 阶段的实现中不出现 agent 派发调用（AC-9/10）。
- **源码层负扫描**：`SAFE_FORWARD_ENV` 未被本 RFC 修改（AC-20）。

**集成**

- 完整一轮 mr-review：假 webhook → 假 code-host → 断言发布载荷（草稿条数、bulk_publish 一次、
  总览含 degraded 计数）。
- 第二轮去重：同指纹不重发；上轮线程被 resolve。
- 抢占：running 中新事件到达 ⇒ 旧 task 取消、新轮启动、无孤儿行。
- awaiting 全链：贴 patch → 回关键词 → 新一轮推送；以及源分支变化 ⇒ 作废。
- 钩子：pre/post 各一，含注入数据、中止、非阻断失败三种。
- 阶段契约升版 ⇒ 旧钩子报迁移。
- 两层配置：部门改默认值，未覆盖的小组跟随、已覆盖的不变。

**权限**

- 非 MR 作者叫推送被拒；bot MR 上 `initiatorUserId` 可叫、他人不可。
- 小组层写脚本/钩子被拒；PAT 拿不到 `scripts:author`。

**e2e**（Playwright）

- `/code` 配置矩阵 → 发起 → 状态图三层展开 → 切轮次回看。

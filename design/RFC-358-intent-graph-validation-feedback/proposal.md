# RFC-358：意图构建看得见工作流图校验——第二层校验接进意图链路

- 状态：Draft（r2 — 已折入 2026-09-04 设计门两路评审的全部 findings）
- 提出：2026-09-04
- 关联：RFC-234（意图构建器，本 RFC 补齐其未实现的承诺）、RFC-235（意图 UX）、RFC-291（提交后修改）、RFC-348（能力全景注册表）、RFC-294（目标架构总纲）

## 1. 背景

用户实证：**意图构建器创建出来的东西过不了校验**。

追下去发现平台有两层校验，而意图链路只跑第一层：

|                                                                                                                                                                                             | 查什么                                                                                                                                                                                                                                           | 谁在跑                                                                                                           | 意图链路          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------- |
| **第一层**：变更集校验 `validateDraftChangeset`（`modules/intent/application/resolveChangeset.ts:139-251`）                                                                                 | update 目标句柄存在/类型匹配/必须 detail 挂载、密钥 carrier 必须 sentinel、agent `branchPorts ⊆ outputs`、凭据模式扫描、工作流 `$schema_version` 必须等于 `WORKFLOW_SCHEMA_VERSION`、模板引用语法合法性（RFC-292）、typed ref 走查、tempRef 无环 | 每轮 turn 结束时（`turnEngine.ts:657`）                                                                          | ✅ 跑，且闭环完整 |
| **第二层**：工作流图校验 `validateWorkflowDef`（`modules/resource-catalog/infrastructure/legacy/workflow.validator.ts:691`，3339 行 / 133 处判据 / **108 个错误码，其中 14 处为 warning**） | 边的端口是否存在、wrapper 边界规则、fanout 结构、clarify 多重性、call 闭环与自调用、模板变量**有无来源**、exit condition 是否落在分支端口、agent 的 skill/MCP/plugin 闭包是否可解析……                                                            | 工作流编辑器面板（`POST /api/workflows/:id/validate{,-draft}`）、启动任务前的 `services/taskLaunchGate.ts:53-66` | ❌ **一次都不跑** |

注意两层在「模板」上只是**部分**重叠：第一层查引用语法是否合法，第二层的 `prompt-template-unresolved` 查变量**有没有来源**。名字合法性（`validateFinalNameForType`）不属于第一层——它在 apply 期的 `resolveIntentBundle` 里跑（`resolveChangeset.ts:540`）。

第一层的闭环是通的：错误落进 draft 的 `validation_json` → 前端红牌并禁用提交（`packages/frontend/src/routes/intent.detail.tsx:650`、`:761`）→ 下一轮渲染进 INTENT.md 的 `## BLOCKING validation errors on the current draft (fix ALL of these)`（`modules/intent/domain/intentDoc.ts:200-206`）→ agent 自己修。

第二层则从生成到落库全程缺席：turn 不跑，apply 也不跑——提交侧的 workflow 分支只做 `WorkflowDefinitionSchema.parse` + `migrateWorkflowDefinitionToLatest` + 引用可用性（`modules/resource-catalog/infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants.ts:948-955`、`:736-773`），整个文件里 `validate` 一次都不出现。

于是链路是：**意图侧全绿 → 落库成功 → 打开编辑器或点启动，validator 才第一次开口**；而构建器 agent 从头到尾没见过这些错误，也就没有任何自愈机会。

### 1.1 这是实现缺口，不是设计取舍

RFC-234 §9.2/§9.3 要求 apply preflight 跑三项静态校验，**其中两项已落地、只有工作流图校验这一项没有**：

| RFC-234 承诺的         | 现状                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| canonical schema 复跑  | ✅ 已落地（`legacyIntentApplyResourceParticipants.ts:949` 等各资源分支）                                                                               |
| `validateGroupShape`   | ✅ 已落地（`packages/shared/src/schemas/workgroup.ts:320`，经 `CreateWorkgroupSchema.superRefine` 挂上，意图 apply 的 workgroup 分支 `:978` 真的跑到） |
| **workflow validator** | ❌ **未落地**（本 RFC）                                                                                                                                |

出处：`design/RFC-234-intent-driven-builder/proposal.md:60`「静态校验（schema / **workflow validator** / 引用解析）全做」；同 RFC `design.md:326`（§9.2）「逐类型静态校验（**workflow validator 全五检** / `validateGroupShape` / agent 引用链）」；`design.md:335-336`（§9.3）「覆盖后**重物化完整资源对象并重跑全部 canonical schema + validator**」。

还有一条**源码内**的同款陈述至今未兑现，比设计文档更硬：`packages/shared/src/schemas/intentChangeset.ts:303-305` 的注释写着「full structural validation runs after resolve via `services/workflow.validator.ts`（design §9.2）」。

### 1.2 本机实证（2026-09-04，生产库只读快照）

对 `~/.agent-workflow/db.sqlite` 的快照逐个跑 `validateWorkflowDef`：

- 43 个工作流中 **7 个由意图创建**（`intent_provenance`），其中 **1 个带 error**：`demo-20260730-code-audit-fix` 的 `review-input-source-not-markdown`（review 节点的被审源接在 `wrapper-fanout` 上）——**正是第一层看不见、第二层才知道的规则**；
- 手工建的工作流里另有 6 个带 error（`code-host-param-missing` ×9、`prompt-template-unresolved` ×4 等）——说明「保存不校验」是平台既有形态（`legacy/workflow.ts` 的 `prepareWorkflowSave` 里零 validate），不是意图独有；
- 19 个 draft 里只有 **1 个**曾报 blocking error（4 条，下一轮 agent 自己修绿）——第一层闭环确实有效，只是**覆盖面窄到几乎总是绿**，于是「绿」失去了信息量。

## 2. 目标

1. **意图构建与意图修改的每一轮，agent 都能看到工作流图校验的 error**，并在同一个会话里自己修掉。
2. 图校验的 error **阻塞提交**，与第一层 blocking error 同等对待、同一处展示。
3. 图校验红时**自动再开一轮**让 agent 自修（至多 1 轮），减少用户来回。
4. **提交（apply）阶段二次硬拦**，把「确认之后 live 库变了」这类漂移挡在事务外，兑现 RFC-234 §9.2。
5. **同一变更集内新建 / 修改的资源，以变更后的形态参与校验**——包括 agent 的端口、同批新建的 skill / MCP / plugin，以及同批新建的被调用工作流。少任何一类都会把合法变更集判成红。
6. 上述能力在 SQLite 与 PostgreSQL 两个 provider 上**同形**。

## 3. 非目标

- **不给 agent / skill / MCP / plugin / workgroup 新增任何校验规则**。但工作流图校验器天然会**经由 agent 去校验**它的 skill / MCP / plugin 闭包（`workflow.validator.ts:1716-1830`），所以本 RFC 必须把同批新建的这三类资源注入校验上下文——那不是新增校验面，而是让既有校验不产生假阳性。
- **不拦截「改 agent 弄坏既有工作流」**（决策 D6）：改 agent 的 `outputs` 会让引用它的既有工作流不可启动，而平台目前只在**删** agent 时有下游守卫（`legacy/agent.ts:766-816` 的 `agent-in-use`），**改**没有（两个 provider 皆无）。本 RFC 只在确认页做知情提示 + 记 `docs/audit-backlog.md`，不阻塞。
- **不管存量**：已落库的带红工作流（本机 43 个里 7 个）不在本 RFC 范围；它们在启动任务时本来就被 launch gate 拦住。
- **不改 validator 自身的判据**：只把既有校验器接进来，不新增、不放宽、不收紧任何一条工作流规则。
- **不改「保存不校验」的平台形态**：工作流编辑器的保存路径维持现状。
- **不做真实试跑**：与 RFC-234 §3 一致。

## 4. 用户故事

- **US-1（构建）**：我描述「实现 → 分片审计 → 修复」的流水线，agent 产出的工作流把 review 节点接到了 fanout 上。**现在**：确认页直接红牌指出 `review-input-source-not-markdown`，并自动再跑一轮把它改成接 agent 节点；我看到的第一版就是能启动的。**此前**：确认页全绿，我提交、跳到工作流页点启动，才被 `workflow-invalid` 拒。
- **US-2（修改）**：我在某工作流上点「意图修改」说「给审计节点加一个安全维度、输出单独端口」。agent 同时改了 agent 的 `outputs` 和工作流的连线。**现在**：图校验用**改后**的 agent 投影判断端口是否存在，两处一致才算绿。
- **US-3（一次建一整套）**：我说「建一个技能 + 一个用它的 agent + 一个调用另一个新工作流的主工作流」。**现在**：同批新建的技能与被调工作流都在校验上下文里，不会误报 `skill-not-found` / `call-workflow-ref-missing`。
- **US-4（漂移）**：我生成完草稿去泡了杯咖啡，其间同事改了我引用的那个 agent 的输出端口。**现在**：点提交被拒并告诉我具体原因，零资源落库。

## 5. 验收标准

- **AC-1**：变更集里含工作流 op 时，每个 op 的 definition 都跑一次 `validateWorkflowDef`；error 级 issue 以 `<opId>:` 前缀进入 draft 的 blocking 列表（前缀是前端按 op 卡片分组的既有约定，`intent.detail.tsx:268`、`:665`、`:721`，**冒号后无空格**）。
- **AC-2**：blocking 列表非空时提交按钮禁用（复用既有判据，不新增开关）。
- **AC-3**：图校验的 error 出现在下一轮 INTENT.md 的 blocking 段；**warning 不出现**（决策 D1）。
- **AC-4**：warning 在确认页单独一段展示，不阻塞提交。
- **AC-5**：一轮产出的 changeset 带图校验 error 时，自动铸一轮重修；该轮仍红则停下交给用户，**不会有第三轮**（决策 D2）。自动轮在 UI 上可识别，并照常计入生成轮预算。
- **AC-6**：提交阶段对每个工作流 op 用**最终 canonical id** 再跑一次图校验；红则以 `intent-workflow-invalid` 拒绝，零资源落库（决策 D3）。错误文案按 issue 成因分类，不一律说「资源已变化」。
- **AC-7**：同一个坏变更集，SQLite 与 PostgreSQL 两个 provider 给出**同一组** issue code（固件避开两 provider 既有的 skill 可用性口径差，见 design §8）。
- **AC-8**：本 bundle 内新建的 agent 与被本 bundle 修改的 agent，其端口以**变更后**的形态参与图校验；update op 省略的字段是否沿用存值，**逐字段**与 apply 期的口径一致。
- **AC-9**：同批新建的 skill / MCP / plugin 注入校验上下文，不产生 `skill-not-found` / `mcp-not-found` / `plugin-not-found` 假阳性；同批新建的工作流注入 call 闭包，不产生 `call-workflow-ref-missing` 假阳性。
- **AC-10**：畸形定义（未过 `WorkflowDefinitionSchema` 的 loose 定义）产出一条可读的 op 级 blocking error，**不得让整轮崩溃**。
- **AC-11**：图校验 error 条数有上限（每 op 20 / 全局 64），超出部分**显式标注**截断条数（遵循 `intentDoc.ts:14` 的「Any truncation is explicitly labeled」约定）。
- **AC-12**：图校验不可用（查库失败）时 draft 照常落地，标记 `graphValidationUnavailable`，提交按钮按不可用禁用，下一轮 INTENT.md 不渲染图校验段（决策 D7）。
- **AC-13**：变更集含 agent update 时，确认页列出引用该 agent 的既有工作流数量与名称，标明「本次未校验」（决策 D6）；该信息**不进** INTENT.md。

## 6. 行为变更清单（呈用户确认）

按 CLAUDE.md §RFC workflow 第 7 条逐项列出**此前能通过、此后不能**，以及一条范围外的既有行为修正：

| #       | 变更                                                                                                  | 影响                                                                                                                                                                                                                                                                                                              | 判据               |
| ------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| B-1     | 意图草稿含图校验 error 时**前端不再能提交**                                                           | 服务端的提交门（`domain/applyClaim.ts:58-89` 的 `requireCommittableDraft`）**从来不看 `validation_json`**，今天「blocking 禁提交」也只由前端按钮实现。本 RFC 维持该形态：直连 API 仍可提交，但会被 AC-6 的 apply 期图校验拦下                                                                                     | AC-1 / AC-2 / AC-6 |
| B-2     | 提交阶段新增二次硬拦，可能出现「确认页是绿的、点提交被拒」                                            | 触发面不止 live 库漂移，还包括：copy 归一（见 B-5 修掉的那部分之外的残余）、本功能上线前产生的存量草稿、`finalName` 槽改名导致按名字的 call 边断掉。文案按成因分类                                                                                                                                                | AC-6               |
| B-3     | 每次图校验红会**自动消耗一轮生成预算**                                                                | `intentBuilderMaxGenerateRounds` 缺省 50，但**生成轮与反问轮共用同一个上限**（`intentSqlPersistence.ts:453-462`），且余量对用户完全不可见。`intent-budget-exhausted` 需补一条说明「自动修复轮也计入」的中英文案                                                                                                   | AC-5               |
| B-4     | 会话轮次里会出现用户没主动发起的 agent 轮，**且该轮期间整个会话被锁**                                 | 自动轮占住 `inFlightTurnId` 期间，发消息 / 回答反问 / 批准挂载 / 提交全部被 409 拒。UI 须显式标识「正在自动修复图校验错误」并保证取消入口显眼                                                                                                                                                                     | AC-5               |
| **B-5** | **copy 出来的副本此后会继承源行的 `outputKinds` / `branchPorts` / `role` / `outputWrapperPortNames`** | **本 RFC 范围外的 apply 行为变更**（2026-09-04 用户裁决 D5）。现状 copy 的 create 分支不做 sidecar 回填（`legacyIntentApplyResourceParticipants.ts:809-822`），而 update 分支做（`:823-858`），于是「复制一个 builtin agent 再改」会静默丢掉这四个字段——这本身是既有缺陷。修掉它同时消除了 draft/apply 的口径分叉 | design §3.6        |
| B-6     | 确认页新增一段「引用该 agent 的既有工作流」提示                                                       | 纯增量信息，不阻塞任何操作                                                                                                                                                                                                                                                                                        | AC-13              |

三条收缩（B-1 / B-2 / B-3）都不关闭任何既有部署形态，只是把「本来就会在启动时失败」的产物提前拦下。B-5 是修复既有静默丢字段的缺陷。

## 7. 决策记录

**2026-09-04 第一轮拍板：**

- **D1 warning 只在 UI 显示，不进 INTENT.md**。理由：本机快照里 warning 绝大多数是 `clarify-no-iteration-cap` 这类建议性规则，塞进 prompt 会稀释真正的 blocking 段。**代价**：agent 看不见 warning，会反复产出同一形态——低成本缓解是把这几条系统性 warning 写进 RFC-348 teaching registry 的 `mistakes`（design §10，任务前移到批次 2）。
- **D2 自动重试 1 轮，仍红交给用户**。理由：端口没连、模板变量没来源这类 agent 一看就能改；反复自修则会白烧预算。
- **D3 apply 阶段二次硬拦**。理由：与 RFC-234 §9.2 原设计一致，且能挡住 draft→apply 之间的 live 库漂移。
- **D4 存量不在本 RFC 范围**。理由：存量的红在启动时已被拦，不会静默跑错。

**2026-09-04 第二轮拍板（设计门评审后）：**

- **D5 copy 分叉：补齐 apply 的 copy sidecar 回填 + 错误文案分类**（选项 a/b/c 中的 b+c）。理由：根因消除，且顺手修掉一个既有缺陷；代价是引入一条范围外行为变更，已列为 B-5。
- **D6 改 agent 弄坏既有工作流：不拦截，确认页知情提示 + 记 backlog**。理由：「先改 agent、再改工作流」是合法的迭代节奏，拦截会破坏它；但用户有权知道影响面。
- **D7 图校验查库失败：draft 照落 + 标记不可用**（而非整轮 error）。理由：两种口径都不给假绿，但后者会把模型这一轮已经 canonical 化的产出整个丢弃，白费一轮。

# RFC-234 意图驱动的资源构建 — design

状态：Draft v2（2026-07-28；设计门一轮 6 P0 + 8 P1 + 2 P2 全采纳折入，修订账 §14，
原始 findings 见 `codex-design-gate-2026-07-28.md`）。阅读顺序：proposal → 本文 → plan。

## 0. 总览：一轮的生命周期

```
使用者消息/答案/批准挂载 ──► 平台组装上下文（context epoch = context_revision）
                     ├─ inventory/  可见资源清单摘要（六类；含会话句柄 res#…）
                     ├─ mounted/    挂载元素依赖闭包完整 dump（脱敏；逐资源基线入 manifest）
                     └─ INTENT.md   平台概念说明+会话历史（有界压缩）+当前草稿回显+输出协议
                   ──► runSystemAgent（一次性进程：封印二进制 + ephemeral store +
                        containment；工具=只读文件工具白名单，无写/无 Bash/无 MCP/无网络）
                   ──► stdout 信封解析（<workflow-output nonce>，nonce 持久在 turn 行）
                        ├─ port summary   （必有，短文本）
                        ├─ port questions （问题单，与 changeset 互斥）
                        ├─ port changeset （结构化 JSON 变更集，引用只用句柄/tempRef）
                        └─ port requests  （挂载申请→仅生成待批准建议，用户点头才入下轮）
                   ──► 校验器 → 落 intent_turns + 铸不可变 draft revision → WS → UI
使用者确认提交（携 draftRevision+draftHash+clientMutationId）
                   ──► apply 管线（apply journal 持久 claim → 插件预装 → skill 预 stage →
                        槽位覆盖重物化+全量复验 → 单事务落库 → roll-forward 发布 →
                        provenance → 回执；重复请求幂等返回原回执）
```

意图 agent 全程接触不到 DB、平台家目录、网络与其他进程；它唯一的世界是一次性工作
目录（只读），唯一的输出通道是信封。

## 1. 执行链路：runSystemAgent 公共原语（T2）

现状：`memoryDistiller.ts` 与 `runtimeSmoke.ts` 是仅有的两个 `driver.buildSpawn`
（`SystemAgentSpawnContext`）调用方（grep 证实仅 `memoryDistiller.ts:1135` 与
`runtimeSmoke.ts:216`），两者手写了近乎相同的
`mkdtemp → worktree/run(0700) → containmentCoordinator.admit → buildSpawn →
wrapSpawnPlanSandbox → Bun.spawn(detached) → 有界 pump → TERM→宽限→KILL→reap →
先 reap 后 cleanup` 序列。新建 `services/systemAgentRun.ts` 抽取该序列；
distiller/smoke 改薄适配层，既有套件全绿为 T2 验收线。

### 1.1 工具面：受资格认证的只读 profile（设计门 P0-1 修订）

设计门证实"给 buildSpawn 透传任意 permission map"在两端都不成立：OpenCode 的
hermetic 配置在 permission 尾部对系统 agent 重新 deny 全部文件工具（RFC-224 §5.1，
`runtime/opencode/hermetic.ts` 权限尾），改动它属于 verified 链路语义变更；
claude-code driver 则忽略 permission 形状并以 bypass 模式继承环境。因此：

- `SystemAgentSpawnContext` 增加 `systemPermissionProfile` 字段，取值为**冻结枚举**
  `'all-deny'（默认，现状） | 'intent-read-v1'`——不是任意 map。
  `'intent-read-v1'` = 只读文件工具白名单（read/glob/grep/list）allow、
  **其余一切（含 write/edit/bash/webfetch/task/MCP）deny**。该枚举在
  `verifiedSystemPlan` 内物化为受控 permission 尾，成为 RFC-224 资格认证面的一部分：
  行为资格套件新增"intent-read-v1 下工具枚举实测"（能读 worktree、不能写、不能
  bash、symlink 逃逸被拒）。
- **意图 agent 无写权 ⇒ 信封是唯一输出通道**（§3 的尺寸不变量因此是硬合同）。
  dump 全部由平台在 spawn 前写好。
- **runtime 准入 fail-closed**：`intentBuilderRuntime` 只接受行为资格认证通过
  `intent-read-v1` 的 protocol（v1 即 `opencode` 直连 codec）；claude-code 等
  无法证明该 profile 的 driver 在 `routes/config.ts` 校验期即拒绝
  （`intent-runtime-unsupported`），不存在"配置进去、运行时降级"路径。
- containment profile 仍为 `runner-filesystem-v1`（platformHomeIsolation +
  immutableArtifactView）：无写、无 Bash/MCP ⇒ 无模型控子进程，拓扑成立；构建期
  静态守卫锁死"`systemPermissionProfile` 含任何 bash/write allow ⇒ 抛错"。

### 1.2 工作目录与清理（设计门 P1-7 修订）

意图轮的 scratch 不落 OS tmpdir，改在
`~/.agent-workflow/intent-scratch/{turnId}/`（0700，`worktree/`+`run/` 布局沿
`verifiedSystemPlan.ts:107-113` 结构约束）。回收合同：

- 成功路径：reap→store cleanup→整目录删除（distiller 同型屏障）。
- 失败路径：目录**保留**并在 turn 行记 `scratchRetained:true`（诊断），由
  **boot + 每小时 GC** 收口：turn 已终态且超过 `intentScratchRetentionHours`
  （默认 24h）→ 校验进程组死亡后删除。dump 内容本就全量脱敏（§8），残留风险
  有界，但仍不允许无限保留。
- distiller/smoke 的既有"失败留残骸"策略不变（T2 行为零变化）；仅 intent 有
  持久回收责任方。

### 1.3 并发、预算与尺寸

- 模块级 `Semaphore(2)`（`util/semaphore.ts:10`）；单会话单飞
  （`in_flight_turn_id`）。
- 单轮 `timeoutMs` 默认 600_000；`stdoutCapBytes` 默认 **8 MiB**，与信封解析
  rolling 上限（`runner.ts:2742` 同源常量）对齐——传输链上不再存在低于变更集
  合法上限的瓶颈（尺寸不变量见 §3.2）。
- 输入侧确定性压缩（设计门 P1-6）：INTENT.md 各节字节预算固定——最近 K=8 轮
  逐字保留，更早轮次仅保留（角色, kind, summary 首行）结构化一行；反问答案
  **永不压缩**（决策事实）；任何截断显式标注。压缩规则纯函数 + golden 测试。
- `services/limits.ts` 1Hz 只覆盖 tasks；意图轮的界由本原语 timeout+TERM/KILL
  承担，与 distiller 同型。

## 2. 数据模型（T3，migration +1）

五张新表（ULID 主键、int 时间戳，对齐 `db/schema.ts` 风格）：

- **`intent_sessions`** — `id` · `owner_user_id` · `title` · `status:
  'active'|'archived'` · `context_revision`（**单调 context epoch**：挂载变化/
  rebase/批准披露/提交成功时 +1，设计门 P0-3）· `context_manifest_json`
  （**基线 manifest**：本 epoch 实际 dump 的**每个**资源一行
  `{handle, resourceType, resourceId, fence, dumpHash}`——含闭包成员，不只挂载
  根，设计门 P1-2；fence 形状见 §7）· `current_draft_id`（nullable）·
  `in_flight_turn_id` · `turn_seq` · `commit_seq` · `budget_json` ·
  `created_at/updated_at`。会话可见性=**创建者 + 系统 admin**（`isAdminActor`，
  **不含 manager**——设计门 P1-8 按拍板 D26 收敛；manager 与他人一样 404 同形）。
- **`intent_turns`** — `id` · `session_id` · `seq` · `role` · `kind:
  'message'|'answers'|'mount-approval'|'questions'|'changeset'|'error'` ·
  `content_json` · `context_revision`（发起时的 epoch；**结果落库时 CAS 校验，
  epoch 已前进的晚到结果只归档为 error(`intent-context-superseded`)，绝不装配为
  当前草稿**，设计门 P0-3）· `envelope_nonce`（**spawn 前与 turn 行同事务持久**，
  解析/审计单源；重试=新 turn 行+新 nonce，设计门 P2-1）· `run_meta_json` ·
  `scratch_retained` · `created_at`。
- **`intent_drafts`** — `id` · `session_id` · `revision`（单调）·
  `changeset_json`（**不可变全文**）· `validation_json` · `draft_hash`
  （规范化 JSON 的 SHA-256）· `produced_by_turn_id` · `context_revision` ·
  `created_at`。turn 只存 draft id；"恢复上一版"=把旧 revision 重设为
  current（新 draft 行复制，历史不灭），设计门 P1-5。
- **`intent_apply_journal`** — `id` · `session_id` · `client_mutation_id`
  （**UNIQUE(session_id, client_mutation_id)**，设计门 P0-6）· `draft_id` ·
  `draft_hash` · `state: 'prepared'|'applying'|'committed'|'failed'` ·
  `prepared_artifacts_json`（插件 generation、skill staging/op id 清单）·
  `receipt_json`（成功回执：applied refs + versions）· `error` ·
  `created_at/updated_at`。**幂等**：同 `(session, clientMutationId)` 重放→直接
  返回原 receipt（或原 error）；boot 恢复按 journal 收敛（§9.5）。
- **`intent_provenance`** — 同 v1：`(resource_type, resource_id, commit_id,
  session_id, created_at)`，PK 前三列；不进任何 prompt（grep 锁）。
  提交记录本身并入 journal 的 `receipt_json`（v1 的 `intent_commits` 表取消，
  journal 即提交台账；`commit_seq` 仅计成功数）。

## 3. 变更集契约（T1，`packages/shared/src/schemas/intentChangeset.ts`）

### 3.1 会话句柄（设计门 P1-1 修订）

平台为**每个**进入 inventory / dump 的资源分配会话内不透明句柄
`res#<type>#<n>`（映射只存服务端 manifest；对齐 RFC-167 `member#N` 前例
`dynamicWorkflow.ts:175`）。模型侧协议**从不出现** ULID、ownerUsername 或任何
用户名——inventory/dump/变更集三处引用同一句柄体系：

```jsonc
{
  "$schema_version": 1,
  "ops": [
    { "opId": "op-1", "action": "update",
      "resourceType": "workflow",
      "target": "res#workflow#3",          // update 必填：manifest 内句柄
      "payload": { /* portable 全文档 */ } },
    { "opId": "op-2", "action": "create",
      "resourceType": "agent",
      "tempRef": "$new:security-auditor",  // create 必填
      "payload": { /* … */ } }
  ]
}
```

- payload 内跨资源引用**只允许** `res#…` 句柄或本变更集 `tempRef`；名称仅作
  展示字段。裸 ULID / username / 未知句柄 → 校验错误（`intent-ref-unknown`），
  消歧问题随句柄唯一性消失（不再需要 ownerUsername selector）。
- update 携带完整快照而非补丁（对齐平台全文档 OCC 保存语义）；展示 diff 由平台
  对基线计算，不信任 agent 自述。
- 每类型 payload 收敛自既有 zod（agent→`CreateAgentSchema` portable 变体；
  workflow→`WorkflowDefinitionSchema` 句柄形态；workgroup→
  `WorkgroupDraftSnapshotSchema` 变体，human 成员仅 `{displayName, roleDesc}`
  占位；skill→`{name, description, frontmatterExtra, bodyMd,
  files:[{path, content}]}`；mcp→`CreateMcpSchema` 变体+密钥哨兵（§8）；
  plugin→`{name, spec, optionsJson, description, enabled}`+凭据模式扫描（§8））。
- 解析 seam 唯一：`services/intent/resolveChangeset.ts` 把句柄/tempRef 解析为
  canonical id（句柄查 manifest；tempRef 拓扑排序，成环=错误）。
- `requests` 端口（挂载申请）：**只生成待批准建议**。UI 以 chip 呈现，使用者
  逐项点头（`mount-approval` turn）后才进入下一 context epoch 的 dump；**不存在
  自动挂载**——被注入指令的 dump 内容无法自主扩大披露范围（设计门 P1-4；是对
  拍板 D19 的收紧：申请→建议，批准权在使用者）。会话维护"已批准披露清单"=
  manifest 本身。

### 3.2 尺寸不变量（设计门 P1-6 修订）

schema 级硬上限，全部低于传输瓶颈（stdout 8 MiB = 解析 rolling 8 MiB）：

- skill `files`：≤32 个 / 单文件 ≤128 KiB / 单 skill files 总量 ≤1 MiB；
- 变更集规范化 JSON 总量 ≤2 MiB；超限=结构化校验错误（提示 agent 拆分为多次
  提交或缩小范围），**不存在合法却发不出去的正例**——golden 测试锁"最大合法
  payload 可完整走通 生成→解析→应用"。

### 3.3 信封端口

复用 `<workflow-output nonce="…">`（emit/parse 单源 `services/envelope.ts`，
last-envelope-wins `:240`，端口成帧 `:357`，malformed 检测 `:308`）。nonce 每轮
新 mint 并**持久于 `intent_turns.envelope_nonce`**（§2）。端口：`summary`（必有，
≤2 KiB）；`questions` 与 `changeset` 互斥其一（问题单 ≤5 题、2-4 选项，沿
`prompt.ts:896` 结构约束）；`requests` 可选。协议块 `buildProtocolBlock`
（`prompt.ts:769`）追加于用户 prompt 尾。两端口同缺/同在、JSON 非法、zod 失败
→ turn=error，UI"重试本轮"（新 turn/新 nonce，同 context epoch 前提下重放）。

## 4. 工作目录 dump 契约（T4，`services/intent/dumpBuilder.ts`）

```
worktree/
  INTENT.md                  # 平台模型速写、会话目标、历史（§1.3 压缩规则）、当前
                             # 草稿回显（含校验错误）、句柄清单、输出协议+schema 摘要
  inventory/{agents,skills,workflows,workgroups,mcps,plugins}.md
                             # 摘要：句柄+name+描述+端口/能力一行一条；>500 截断显式标注
  mounted/
    res.workflow.3/workflow.yaml       # 目录名=句柄；serializer 输出句柄不输出 id
    res.agent.7.md
    res.skill.2/SKILL.md + files/**
    res.workgroup.1.yaml               # human 成员仅 displayName/roleDesc
    res.mcp.4.yaml                     # §8 闭集脱敏投影
    res.plugin.5.yaml                  # spec 经 redactGitUrl；本机路径剥离
```

- 挂载根自动携带依赖闭包（BFS，ACL 过滤；不可见依赖以 `hidden-dependency`
  占位，不泄名称）。**闭包内每个实际 dump 的资源都进 manifest 并记 fence**
  （§2/§7，设计门 P1-2）。
- 全部 dump 与历史文本入 prompt 时套 RFC-200 `fenceUntrusted(nonce)`
  （`orchestratorAgent.ts:197-225` 用法）；围栏只是注入缓解，**不是授权边界**
  ——授权边界在 §3.1 的批准制挂载与 §9 的服务端复验。
- 身份隔离：serializer 白名单输出；`owner_user_id`/username/
  `workgroup_members.user_id`/grants/provenance 零出现。双层锁（全字段夹具
  单测 + 源码 grep 锁，rfc099-prompt-isolation 同型）。
- 新增 shared 序列化器（T1）：`agent-md-serialize.ts`（与 `parseAgentMarkdown`
  round-trip golden，`agent-md.ts:113`/KNOWN_KEYS `:49-85`）；workgroup/mcp/
  plugin YAML serializer（前后端单源）。

## 5. 系统 prompt 与运行时配置

- 系统 prompt 冻结在源码（英文，distiller 同型 `memoryDistiller.ts:97`）：角色、
  六类资源建模规则、只输出信封、只用句柄/tempRef、密钥哨兵规则、反问触发标准、
  语言指令（`intentBuilderLang` 或跟随使用者输入语言）、管理员追加指令段
  （受信配置，置尾部独立段）。
- config 键：`intentBuilderRuntime` · `intentBuilderLang` ·
  `intentBuilderTurnTimeoutMs` · `intentBuilderStdoutCapBytes` ·
  `intentBuilderMaxGenerateRounds`（默认 50）· `intentBuilderMaxQuestionRounds`
  （默认 5）· `intentBuilderScratchRetentionHours`（默认 24）·
  `intentBuilderExtraInstructions`（≤8 KiB）。接线照 distiller 模式：
  `routes/config.ts:50-72` 校验循环（含 §1.1 的 protocol fail-closed 项）、
  `runtimeRegistry.ts:489` `RuntimeRefConfig` 删除引用检查、settings System
  Agents 卡（`settings.tsx:1160` 区、`lib/settings-drafts.ts:26/38`）。

## 6. API / WS（T7）

`routes/intentSessions.ts`（multiAuth + 行级 owner；**系统 admin 只读旁路，
manager 无旁路**；权限点 `intentSessions:read/:write` 进 `auth/permissions.ts`，
PAT 可收紧）：

- `POST /` `{message, hint?}`；`GET /`（自己的；admin `?all=1`）；`GET /:id`
- `POST /:id/messages` `{message}` · `POST /:id/answers` `{answers}` ·
  `POST /:id/mount-approvals` `{approve:[requestId], reject:[requestId]}`
  ——三者受理条件：无 in-flight turn，否则 409
- `POST /:id/mounts` / `DELETE /:id/mounts/:handle`（挂载→context_revision+1）
- `POST /:id/rebase` → 重建**整个闭包 manifest**（原子替换，epoch+1，草稿
  stale）
- `POST /:id/cancel-turn`；`POST /:id/archive` / `reopen`
- `POST /:id/commit`：
  ```jsonc
  { "clientMutationId": "…",             // (session, id) 唯一，幂等重放
    "draftRevision": 7,
    "draftHash": "sha256:…",            // 必须等于服务端该 revision 的 hash
    "decisions": [ { "opId": "op-1", "applyMode": "modify"|"copy",
                     "slots": [ {"slotId": "…", "value": "…"} ] } ] }
  ```
  `slots` 只能填**服务端在校验阶段签发的槽位**（§9.3）。

WS：`/ws/intent-sessions`（registry 条目 + owner-only revocation；
`shared/schemas/ws.ts:434` channel builder）。事件：`intent.turn.*`、
`intent.draft.updated`、`intent.apply.*`、`intent.session.updated`。
api-contract-coverage 登记全部新路由。

## 7. OCC 基线围栏（D11 + 设计门 P0-3/P1-2）

三层围栏，缺一不可：

1. **context epoch**：turn 结果落库 CAS `context_revision`；晚到=归档 error。
2. **draft 绑定**：commit 必须携带 `draftRevision + draftHash`，且该 draft 的
   `context_revision` == 会话当前值、会话无 in-flight turn——"页面 A 用旧确认
   提交页面 B 新草稿"被 hash 精确拦下。
3. **资源 fence**：manifest 中**每个**被 update 的资源按类型复验——agent
   `{updatedAt, aclRevision}`；skill 复合 token（`schemas/skill.ts:60-67`）；
   mcp/plugin `configHash`；workflow/workgroup `{version, snapshotHash}`。任一
   失配 → 409 `intent-baseline-stale` 携 `{staleHandles, current}` → UI 冲突
   横幅 → rebase → 重生成。

create 类命名：呈现时预检+就地改名（D24），事务内 owner-scope unique 兜底
（violation → `intent-name-conflict` 打回，零落库）。

## 8. 密钥与身份的双向隔离（D15/D16 + 设计门 P0-2，安全核心）

**闭集 secret-slot 投影**（不是启发式补丁）：每类资源定义**穷举的凭据载体清单**，
dump 投影与入向校验共用同一张表（shared 单源 `intentSecretSlots.ts`）：

| 资源 | 载体（全部处理） |
| --- | --- |
| mcp(local) | `config.env.*` 值；`config.command[1:]` **全量** `‹redacted-arg-N›`（仅 argv[0] 保留）；`timeoutMs` 等白名单标量保留 |
| mcp(remote) | `config.url` → 仅保留 scheme+host+path（**userinfo 与 query 剥除**并标注）；`headers.*` 值；oauth 秘密 |
| plugin | `spec` 经 `redactGitUrl` 同源逻辑（userinfo/token 剥除）；`options_json` **所有字符串值**遮蔽（键名保留） |
| agent/skill/workflow/workgroup | `frontmatterExtra`/自由 JSON 中命中启发键（token/secret/key/password/credential，忽略大小写）的值遮蔽 |

**出方向**：以上投影产出 dump；夹具含真值的单测断言零泄漏；最终物化对象、
错误消息与诊断字段（stderrTail 等）统一过同一遮蔽器再落库/外显。

**入方向**：changeset 中上述载体位置只接受哨兵 `"‹secret›"` 或空；此外对
**全部** payload 字符串跑凭据模式扫描（URL userinfo、`--token=`/`-p ` 形态、
高熵 base64/hex ≥32 字符）——命中 → `intent-secret-value-forbidden`（既拦幻觉
凭据也拦回流泄漏）。误报由使用者在确认界面对该槽位显式"标记非密钥"放行
（决策落 journal 审计）。

**确认时补填**：真值只存在于 commit 请求体 `slots` 与 canonical service 落库
路径；journal 快照中该槽位固化为哨兵。人类成员绑定同槽位机制（`UserPicker`），
平台复验 active（`assertHumanMembersActiveInTx` 同源）。用户身份不进 dump/
prompt（§4）。

## 9. Apply 管线（T6，`services/intent/applyChangeset.ts`）

对外不变量：**要么全部资源以终态可见落库，要么零资源可见**；同一
`clientMutationId` 至多生效一次。

### 9.1 Claim（持久，幂等入口）

`dbTxSync`：校验 draftHash/epoch/无 in-flight（§7）→ INSERT journal
`state='prepared'`（UNIQUE(session, clientMutationId)；已存在 → 直接返回其
receipt/error，**零副作用**，设计门 P0-6）。会话级互斥拒绝并发 commit。

### 9.2 Preflight（无副作用）

zod → resolveChangeset（句柄/tempRef→id）→ ACL：update 目标
`requireResourceOwner`；**`applyMode:'copy'` 规范化为 create**——对基线继承+
修改后的**全部**直接引用、依赖闭包与 human 成员按新资源全量复验
（`assertRefsUsableInTx` 语义，**无 grandfather**；对齐 RFC-231 copy 先例
`workflow.ts:232-235` / `workgroups.ts:222-245`，设计门 P0-4）→ 逐类型静态
校验（workflow validator 全五检 / `validateGroupShape` / agent 引用链）→
命名预检 → fence 预检 → 拓扑排序（skills/mcps/plugins → agents →
workflows/workgroups；同批引用被 copy 元素的 op 重接线到 copy 结果，重接线
以 opId 为锚、确认界面已预览）。

### 9.3 槽位覆盖与重物化（设计门 P1-3）

校验阶段服务端签发槽位 `(opId, slotId, exactJsonPointer, kind:
secret|humanBinding|finalName|secretWaiver)`；commit `decisions[].slots` 只允许
命中签发集（多/漏/错型 → 422）。覆盖后**重物化完整资源对象并重跑全部 canonical
schema + validator**，重算 final hash 并与确认页展示 hash 一致（服务端重算，
不信任客户端）。

### 9.4 副作用与单事务

1. **插件预装**（可补偿）：逐个新插件走既有安装器；generation/缓存 id 记入
   journal `prepared_artifacts_json`（**先记后装**）；任一失败 → 逆序清理**本次
   调用创建的**半成品 → journal `failed` → 零落库（D27）。
2. **skill 预 stage**（可补偿）：reserve→files（`skill.ts:182-301` 同型，
   reserving 不可见）；op/staging id 记 journal。
3. **单 `dbTxSync`**：journal `prepared→applying` CAS → 按拓扑执行六类
   canonical service 的 in-tx 内核（`agent.ts:207-220` 模式；为 workflow/
   workgroup/mcp/plugin 抽 `createXxxInTx`/`saveXxxInTx`，外壳行为不变、既有
   套件回归锁）→ fence 复验 → unique 兜底 → skill ready 翻转+版本行 →
   provenance → journal `committed` + receipt。**actor=会话 owner 贯穿**
   （禁 null actor——RFC-231 记录过 `dwSaveAsWorkflow` 事故）。
4. **roll-forward 发布**：tx 后执行 skill live 树幂等发布（authoritative 读
   走版本快照，live 树为派生物）；广播（`broadcastXxxCreated` 家族 + intent
   WS）。

### 9.5 崩溃收敛（设计门 P0-5）

boot + 每小时 GC 按 journal 收敛：`prepared/applying` 且事务未落（无
committed 标记）→ 逆序清理 prepared_artifacts（插件缓存、skill staging/
reserving 行）→ `failed`；`committed` 但发布未完成 → 重放幂等 roll-forward。
`applying` 状态因单事务性质只可能是"事务未提交即崩溃"——数据侧无残留，仅清
副作用。守卫测试对五个断点逐一注入崩溃（§13）。

明确排除：本管线不出现任何对六类资源表的 raw SQL 直写（源码文本锁，AC-9）。

## 10. 前端（T8-T12）

v1 结构同前版，增量修订：时间线新增 `mount-approval` 卡（requests → 逐项
批准/拒绝 chips）；提交 Stepper 第 2 步渲染**服务端签发槽位**（密钥
`type=password`、humanBinding=UserPicker、finalName、secretWaiver）；提交按钮
携 `draftRevision+draftHash`；草稿面板顶部显示 draft revision 与"恢复此版"
（历史 revision 列表）；冲突横幅区分 `intent-baseline-stale`（rebase 引导）与
`intent-context-superseded`（晚到轮已归档提示）。其余（画布 `intent-preview`
surface、工作组结构预览、skill 文件树 DiffViewer、MarkdownDiffView、脚本后缀
警示、入口接线、provenance badge、i18n 双语）同前版 §10。

## 11. 失败模式清单

| 场景 | 行为 |
| --- | --- |
| spawn 失败/超时/输出超限 | turn=error（failureCode+stderrTail 过遮蔽器）；scratch 失败保留→GC（§1.2） |
| 信封缺失/malformed/端口互斥违规/zod 失败/尺寸超限 | turn=error 结构化定位；重试=新 turn 新 nonce |
| 凭据模式命中 | `intent-secret-value-forbidden` 定位到槽位；可 waiver（§8） |
| 晚到轮（epoch 已前进） | 归档 error `intent-context-superseded`，不装配草稿 |
| commit：draftHash/epoch 失配 | 409 精确拒绝（§7 层 2） |
| commit：fence 失配 | 409 `intent-baseline-stale` → rebase → 重生成 |
| commit：命名撞车 | tx 内 unique 兜底 → 零落库 → 打回改名 |
| commit：插件安装失败 | 逆序清本次半成品 → journal failed → 零落库 |
| commit：响应丢失/重放 | 同 clientMutationId → 原 receipt 幂等返回 |
| daemon 崩溃（五断点任一） | journal 收敛：prepared/applying→清理+failed；committed→roll-forward（§9.5） |
| daemon 重启时轮在飞 | boot 置该 turn error（进程组亡；ephemeral store 走 `opencodeStoreRecovery.ts:81`） |
| 轮预算耗尽 | 会话 notice；设置可调；可归档 |
| dump 超限 | inventory 截断显式标注；挂载树过大拒绝并提示缩小范围 |

## 12. 与现有模块的耦合点

1. `runtime/types.ts` `SystemAgentSpawnContext.systemPermissionProfile`（冻结
   枚举）+ `verifiedSystemPlan` 权限尾物化 + **RFC-224 行为资格套件扩项**
   （intent-read-v1 工具枚举/symlink 实测）——这是对 verified 面的显式扩展，
   不是绕过；qualification 套件按 CLAUDE.md 要求复跑。
2. distiller/smoke 重构到 `runSystemAgent`（行为零变化，套件锁）。
3. config 八键 + `routes/config.ts`（含 protocol fail-closed）+
   `RuntimeRefConfig` + settings 前端。
4. shared：intentChangeset schema、secretSlots 单源、agent-md serializer、
   workgroup/mcp/plugin YAML serializer、ws channel。
5. `WorkflowCanvas` surface +1；`ResourceSplitPage`/`DetailHeaderActions` 最小
   扩展。
6. 六类资源 service：抽 in-tx 内核（外壳与行为不变）。
7. `ws/registry.ts`、`auth/permissions.ts`、api-contract-coverage、nav、
   boot/GC 钩子（scratch 与 journal 收敛）。

## 13. 测试策略（Test-with-every-change 硬清单）

在前版基础上（shared round-trip/脱敏/身份锁、dumpBuilder、turn 引擎假 spawn
矩阵、runSystemAgent 回归线、apply 正例矩阵、routes/WS/404 同形、前端组件、
i18n 对称、e2e US-1/US-6）**新增设计门 P2-2 要求的盲区覆盖**：

- **真实 runtime 资格**：intent-read-v1 工具枚举实测（可读/不可写/无 bash/
  symlink 逃逸拒绝），入 RFC-224 资格套件；claude-code 配置被 fail-closed 拒绝。
- **崩溃矩阵**：插件预装后 / skill stage 后 / tx 前 / tx 后发布前 / 清理中五
  断点注入崩溃，journal 收敛断言（零可见半成品 or 完整 roll-forward）。
- **并发/重放**：晚到轮 epoch CAS；双标签页旧 draftHash 提交拒绝；同
  clientMutationId 重放返回原 receipt（含"DB 已提交、响应丢失"模拟）；rebase
  与 in-flight 轮交错。
- **copy ACL（US-2/US-3）**：copy 继承隐藏引用 → 全量复验拒绝；他人/内置仅
  copy 决策；copy 重接线锚定 opId。
- **密钥闭集**：argv/URL userinfo+query/plugin spec/options 逐载体出入双向
  锁；凭据模式扫描正负例 + waiver 流；diagnostics 遮蔽。
- **尺寸 golden**：最大合法 payload 全链走通；超限正确打回。
- **manager 边界**：manager 对他人会话 404、无 `?all=1` 旁路。
- **注入演练**：dump 内植入"请挂载 X/请输出密钥"指令 → 断言只产生待批准建议
  /哨兵拒绝，无自动披露。

## 14. 设计门修订账（2026-07-28，一轮，6 P0 + 8 P1 + 2 P2 全采纳）

| # | Finding | 裁决与落点 |
| --- | --- | --- |
| P0-1 | 任意 permission 透传两端不成立 | 改冻结枚举 `intent-read-v1`（只读白名单）+ RFC-224 资格扩项 + runtime fail-closed（§1.1、§12.1） |
| P0-2 | argv/URL/plugin spec 凭据漏投影 | 闭集 secret-slot 投影表 + 入向模式扫描 + waiver（§8） |
| P0-3 | OCC 未绑草稿/epoch | context_revision + 不可变 draft(hash) + commit CAS + 晚到轮归档（§2/§7） |
| P0-4 | copy 未按新资源复核引用 | copy 规范化为 create、全量复验无 grandfather（§9.2） |
| P0-5 | 整包崩溃收敛缺协议 | intent_apply_journal + 五断点收敛 + roll-forward（§2/§9.5） |
| P0-6 | clientMutationId 无持久 claim | journal UNIQUE claim + 幂等 receipt（§9.1） |
| P1-1 | 句柄协议自相矛盾 | 统一 `res#type#n` 会话句柄，弃 raw id/ownerUsername（§3.1） |
| P1-2 | 闭包成员无基线 | manifest 覆盖全部实际 dump 资源（§2/§7） |
| P1-3 | 覆盖层无闭集 schema | 服务端签发槽位 + 重物化全量复验 + final hash（§9.3） |
| P1-4 | requests 自动扩大披露 | 申请→待批准建议，批准权在使用者（§3.1；D19 收紧） |
| P1-5 | 草稿不可回溯/提交后上下文未定义 | intent_drafts 不可变 revision + 提交关 epoch（§2/§9） |
| P1-6 | 尺寸上限矛盾 | schema 硬上限 < 传输上限 + 输入侧确定性压缩（§1.3/§3.2） |
| P1-7 | scratch 清理矛盾 | app-home 私有 scratch + journal 记账 + boot/小时 GC（§1.2） |
| P1-8 | 审计权悄扩到 manager | 收敛为 `isAdminActor` 仅系统 admin（§2/§6；D26 对齐） |
| P2-1 | nonce 无权威列 | `intent_turns.envelope_nonce` 同事务持久；重试=新 turn 新 nonce（§2） |
| P2-2 | 测试盲区 | §13 新增六组盲区覆盖 + plan T13 崩溃矩阵 |

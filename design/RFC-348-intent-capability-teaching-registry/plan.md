# RFC-348 任务分解（r12）

状态：Approved r12（2026-08-30 用户批准 D1～D12 并授权实现 + 提交推送；三项另裁已折入）。按依赖图在 `main` 上实现，
单 RFC 多笔提交（见 §PR），精确 pathspec 提交。r12 变更以 ★ 标出（r2～r11 的 ☆ 保留）。

## 任务

### T1 — shared 合同与常量下沉（`packages/shared`、消费者 import 切换）

- [x] T1.1 `schemas/workflow.ts`：新增 `LOOP_EXIT_CONDITION_KINDS` / `LoopExitConditionKind`（D1b）。
- [x] T1.2 `schemas/intentChangeset.ts`：`IntentAgentPayloadSchema` 增 `branchPorts: AgentBranchPortsSchema.optional()`（D5）；
      ★ `IntentMcpPayloadSchema` remote 变体 `config` 增 `oauth`（对象 strict | `false`，与 `McpOAuthConfigSchema` 同键）；
      ★ `intentSecretSlots.ts`：`findNonSentinelSecretCarriers` 增 `/payload/config/oauth/clientSecret`，`projectMcpForDump` 改为只脱敏
      `clientSecret`（D2 ②）。
- [x] T1.3 `schemas/intentSession.ts`：`CreateIntentSessionSchema.hint` → `z.enum(INTENT_RESOURCE_TYPES).optional()`（D4b）。
- [x] ☆ T1.4 `schemas/agent.ts`：`OPENCODE_PERMISSION_ACTIONS` / `OPENCODE_PERMISSION_KEYS` / ★ `OPENCODE_PERMISSION_WILDCARD_KEY`
      （从 `services/runtime/opencode/boundary.ts:152` 搬入）；`boundary.ts` 与 `services/runtime/claudeCode/permissionMap.ts` 改 import（D5d）。
- [x] ☆ T1.5 消费者切换（行为、错误码不变）：`modules/task-execution/domain/loopExitCondition.ts`（union 由常量派生，逐 variant
      字段校验保持）、`modules/task-execution/public/queries.ts` `isValidLoopExitCondition`、`services/workflow.validator.ts`
      `readExitConditionKind`、前端 `canvas/inspector/WrapperGitLoopEdit.tsx:163-168` 下拉由常量 map 生成、
      `i18n/en-US.ts:6307` / `zh-CN.ts:12550` 帮助文案补 `port-inactive`。
- [x] T1.6 测试（实际文件名，实现门 r5 #4 勘正）：`packages/shared/tests/rfc348-loop-exit-condition-kinds.test.ts` +
      `packages/backend/tests/rfc348-loop-exit-kind-roster.test.ts`（新）；`packages/shared/tests/rfc348-intent-changeset-additions.test.ts`（新，
      `branchPorts` / `oauth` schema 正向接受与 strict 拒绝、`clientSecret` 载体、dump 投影；★ `⊄ outputs` 的 draft 报错测试在 T5.6）；`rfc234-intent-routes` 补
      `hint` 枚举 201/422；frontend `tests/rfc348-exit-kind-roster-consumers.test.ts`（源码级锁：下拉由 roster map、两处帮助文案含全部 kind）；
      `boundary` / `permissionMap` 既有测试不改即绿。

### T2 — intent 纯域注册表（`packages/backend/src/modules/intent/domain/teaching/`）

- [x] T2.1 `types.ts`：`FieldTeachingFor<F>`（Scalar / Object / Omitted 三态，含 `nested` / `mistake`）/ `IntentVariantTeaching<S>`（以判别值联合键控）/
      `IntentNodeAvailability` / ★ `AuthorableAvailability` / `IntentPassthroughFieldSource` / ★ `AuthorableNodeTeaching` /
      `SynthesizedNodeTeaching` / `NodeTeachingOf` / `IntentResourceTeaching` / `ShapeOf` /
      ☆ 分配式 `KeysOf`（终止分支只有 ZodObject 贡献键）/ `VariantValues` / `OptionFor` / `FieldTeachingFor<F>` 与
      `TeachingFieldsOf<S>`（对象 / 对象数组 / 变体字段强制 `nested`）/ `ResourceFieldsOf` / `StrictNodeSchemaOf` / `NodeTeachingOf`
      mapped type / ★ `AuthorableNodeTeaching<Fields, Sources>`（passthrough 必带、strict 不得带 `fieldSources`）——全部按
      design §1.1 **已编译验证的原文**落地（探针零错误、负例八个、变异五处），不得再改写为草图。
- [x] T2.2 `nodeKinds.ts`：`INTENT_NODE_TEACHING satisfies { [K in NodeKind]: NodeTeachingOf<K> }`（mapped type；★ `code-round`
      条目无 `fields`）；14 项（13 可创作 + `code-round`）全部登记；
      嵌套子表（`ScriptOutputPortSchema` / `CodeHostCustomRequestSchema` / `WrapperFanoutPortSchema` / `PortRefSchema` / limits）；
      passthrough 五 kind 的 `fieldSources`（★ 文件路径以仓根为基）；现有形态句、说明句、反例句逐字迁入；补
      `continueOnMaxIterations` / `port-inactive` / `branch`；clarify 两 kind 的端口 notes 由常量派生（D5e）；删 `overrides`。
- [x] T2.3 `resourceTypes.ts`：`INTENT_RESOURCE_TEACHING satisfies { [K in IntentResourceType]: IntentResourceTeaching<ResourceFieldsOf<IntentPayloadSchemaOf[K]>> }`
      （六类根表全部受 schema 约束；★ mcp 根为 `IntentVariantTeaching`）；☆ 变体子表（mcp `config`
      local / remote 含 `timeoutMs`，☆ 以 `VariantValues` 键控；workgroup `members` agent / human）；嵌套子表（agent `inputs[]`、
      ★ agent `skills[]` project option、★ skill `files[]` 元素、workgroup `switches`、workflow `definition`）；★ `runtime` 教学句
      含「只选 enabled 行」；补 `branchPorts` / `permission`（`renderPermissionGrammar()` 含 `'*'`）/
      `runtime`（指向 `inventory/runtimes.md`）/ ★ agent `skills` 的 handle | project 两形态说明 / ★ mcp `oauth` 创作句（另裁②：omit / false / 对象三态，update 省略即保留）；☆ `bodyMd.mistake` 挂 `systemPrompt` 反例、`optionsJson.mistake` 挂 `options` 反例。
- [x] ☆ T2.4 `workflowParts.ts`：`WORKFLOW_INPUT_TEACHING satisfies Record<WorkflowInputKind, {base, extra, extraSources}>`
      （★ `base` 以 `WorkflowInputSchema` 键控；`extra`：upload 以 `UploadInputSchema` 键控，text / files / enum / git 四种
      passthrough 扩展字段以字面量键控并带 `extraSources` 读点——`workflowLaunchInputs.ts` 的 `numberField/stringField/as-cast`
      与前端创作面 `InputEdit.tsx` + 启动面 `launch/{DynamicInput,FilesPicker,EnumPicker,GitPicker,UploadPicker}` /
      `webhookAgentAuthoring.ts` / `routes/tasks.new.tsx` / `lib/task-wizard.ts`（★ 测试常量清单）；☆ `INPUT_FIELD_OWNERSHIP` 字段归属表，含
      `authorable:false` 的 `presentation:[text]` / ★ `agentKind:[text,upload]`）、`WORKFLOW_EDGE_TEACHING`、
      `WORKFLOW_OUTPUT_TEACHING`、☆ `WORKFLOW_PORT_REF_TEACHING`（review `inputSource` / 边 `source,target` / output `bind`
      共用，★ 三处以引用复用）。
- [x] T2.5 `reconciliation.ts`：☆ 按 design §1.4 的「逐层键比较 + 对象级覆盖棘轮」实现：★ `ReconciliationEntry[]` 共 29 条（r12：+`mcp.remote.config.oauth`）
      （两侧显式 `paths` + 键视图；agent root / inputs[] / skills[project]、plugin root、skill root、mcp local/remote root + config、
      workflow root / definition / inputs[] base / upload / nodes[] 基础 / nodes[<kind>]×8 / portRef / edges[] / outputs[]、
      workgroup root / members[]（`variants` 逐变体映射）/ switches）+ ★ `RECONCILIATION_UNCOVERED_PLATFORM_OBJECTS` 只含
      `agent.skills[]<managed>`（`nodes[].position` 由 excluded 子树覆盖、`<remote>.config.oauth` 由 entry 认领，重复认领即红）+ 空的
      `RECONCILIATION_UNCOVERED_INTENT_OBJECTS` + 节点基线 24 / 18 / 树外 9；退出门 = T1.2 之后的源码下测试绿。
- [x] T2.6 `platformMap.ts`：`INTENT_PLATFORM_RESOURCE_MAP satisfies Record<AclResourceType, …>`；`managedAt` 用真实入口
      （`/code/config/employees` / `/code/config/action-templates` / `/code/config/verification-profiles` / `/code/policies` /
      `/digital-employees`；`capability_template` 登记 api-only）；九类 `purpose` 文案逐条对照 RFC-304 / 309 / 310 / 317 / 330
      的 proposal §1 校对。
- [x] T2.7 `render.ts`：六个渲染函数（design §2）+ `renderPermissionGrammar`，全部纯函数；`?` 由 `required` 插入并断言无 `??`。
- [x] T2.8 测试：`tests/intent-teaching-registry.test.ts`（☆ AST 正反向扫描——validator `read*`、launch 的
      `numberField/stringField/as-cast`、☆ 前端固定清单文件的形参属性访问（★ 每文件 ≥1 命中、总集非空）——+ 三份初始集合基线
      + 反向自检样本、路由表对照、端口常量、
      六类字面量序列源码锁、字段旁 `mistake` 位置、mcp `oauth` 创作句、★ runtime「只选 enabled 行」句锁、★ skills project / files
      子表字段渲染断言、★ PortRef 表三处同一引用）、`tests/intent-teaching-reconciliation.test.ts`（★ 规则 1 逐层键比较含
      `variants` 与教学表键视图 + 规则 2 对象节点覆盖棘轮（24 / 18 基线）+ 规则 3 反向自检：顶层 / 嵌套 / 变体 `zzzFake` 键、
      未登记嵌套对象、删掉一条真实 entry 各必须报）、
      ☆ `tests/intent-teaching-exhaustive.test.ts`（普通测试文件，仓内先例 `rfc148-adt-contracts.test.ts:30-46`；★ 八个
      `// @ts-expect-error — <说明>` 夹具：缺登记三向 + 扩字段三向 + 新增变体一向 + 新增对象字段只登记父字段一向；一律写成
      `const _x = … satisfies …` 声明并在 `test()` 里 `expect([...].length).toBe(8)` 引用，避开 `no-unused-expressions`）。
- [x] T2.9 `tests/architecture/rfc294-review-module-layer-rules` 对新文件零违规。

### T3 — `services/intent/intentDoc.ts` 重组为渲染装配

- [x] T3.1 删除全部 kind / 类型字面量；按 design §2 节顺序调用渲染器；`IntentDocInput` 增 `requestedArtifactType`（实现门 r1 #4 / r4 #1：Reference rules、工作目录布局、Output contract 也迁入渲染器，`intentDoc.ts` 源码级锁零字面量）。
- [x] T3.2 「Common mistakes」只收跨字段反例；工作目录布局补 `inventory/runtimes.md`。
- [x] T3.3 五个既有契约测试**不改断言**即绿（AC-9）；`rfc234-intent-doc.test.ts` 补 AC-1/2/3/5/11 断言（含「follow the message」句锁）。
- [x] T3.4 记录全权限 doc 新旧字节数（实现报告）。

### T4 — hint 数据流（`services/intent/turnEngine.ts`）

- [x] T4.1 从首轮 user turn 读 hint → ★ `z.enum(INTENT_RESOURCE_TYPES).safeParse(unknown)` → `requestedArtifactType`（每轮）。
- [x] T4.2 `tests/rfc234-turn-engine.test.ts`：有值（第 1 轮 + 第 2 轮）/ 省略 / 存量自由文本。

### T5 — dump 与 apply seam（`dumpBuilder.ts`、`manifest.ts`、`turnEngine.ts`、新 `platformInventory.ts`、`resolveChangeset.ts`、`applyChangeset.ts`；r3 勘正：无独立 `agentPortsProjection.ts`）

- [x] T5.0 实现前核对 RFC-345 在制品：`git status --porcelain -- packages/backend/src/services/intent` 与
      `git log --oneline -5 -- packages/backend/src/services/intent`；T5.4 目标文件有他人未提交改动 ⇒ 停下问用户协调。
- [x] T5.1 agent dump 顶层 `branchPorts`。
- [x] T5.2 `inventory/runtimes.md`：★ `resolveIntentTurnConfig` 内用 `resolveAgentRuntime(db, null, cfg.defaultRuntime)` 算出
      `IntentTurnConfig.effectiveDefaultRuntime: {name, protocol}`（`dispatcher.ts:82-83` 原样透传，未改动）；`runIntentTurn` 注入它，
      `listRuntimes` 结果（name / protocol / enabled）由 `dumpBuilder` 内部读取（实现门 r1 勘正）；header 写有效默认与 ★「只选 enabled 行」句、
      无行时合成一行、`(default)` 恰一次。
- [x] ☆ T5.3 `inventory/agents.md` 行带 `inputs` / `outputs`：默认投影 `loadAgentPortsFromDb` 在 `dumpBuilder.ts` 内（两列窄投影），
      `IntentDumpInput.loadAgentPorts` 为可注入 seam，`buildIntentDump` 对截断后的 `kept` agent id 调用一次（D5c；实现门 r1/r2 勘正：无独立
      `agentPortsProjection.ts`，`turnEngine` 不注入；spy 测试锁调用边界）。
- [x] ★ T5.3b 九类只读清单（D3 ③）：新 `services/intent/platformInventory.ts`（`PLATFORM_ONLY_INVENTORY_LOADERS satisfies
      Record<PlatformOnlyResourceType, (ctx: PlatformInventoryContext) => …>`，各类型既有行加载 + resource-catalog public `filterVisibleRows`，
      employee_tool 合并平台内建目录）；`createDefaultIntentPlatformInventory(db, overrides?)` 组装 `IntentPlatformInventory` 端口，经
      `RunIntentTurnDeps.platformInventory?` → `IntentDumpInput.platformInventory?` 注入（缺省 DB 组装；实现门 r5 #3 勘正），`buildIntentDump` 生成
      `inventory/platform/<type>.md`（≤200 行、截断标注、无 handle；loader 失败 ⇒ 整轮 durable error）。
- [x] T5.4（必做、需协调）`resolveChangeset.ts` agent case 透传 `branchPorts`、★ mcp case 按 pointer 回填 `oauth.clientSecret`、
      `deriveIntentSlots` 为其发槽；`applyChangeset.ts` agent update presence-aware（省略 ⇒ 从 `existing` 回填 `branchPorts`
      ★ 与 `outputKinds / role / outputWrapperPortNames`；`[]` / `{}` / `'normal'` ⇒ 清除）；★ mcp update 的 oauth 沿用逻辑保留、显式值覆盖。
- [x] T5.5（可跳过档）三条三目链 + `summarizeInventoryRow` + fence 构造改 `satisfies Record<IntentResourceType, …>` 表；两处 `switch`
      加 `const _exhaustive: never = op`。撞上在制品即跳过并记债。
- [x] T5.6 测试：`tests/intent-agent-branch-ports.test.ts`（新，AC-4 / AC-18 四态 + 挂载后下一轮 dump）；★ `tests/intent-mcp-oauth.test.ts`
      （AC-17）；★ `tests/intent-platform-inventory.test.ts`（AC-16）；`rfc234-dump-builder.test.ts` 加带
      `branchPorts` 夹具；turn-engine 测试补 runtimes（header 有效默认 / 无行合成 / Intent Builder runtime ≠ 全局默认 / disabled /
      无 binaryPath）与 agent 行端口名（投影恰一次）断言；dump 既有测试不改即绿。

### T6 — 前端派生（六处）

- [x] T6.1 `IntentCreateComposer.tsx`：选项由 `INTENT_RESOURCE_TYPES` 派生，图标表 `satisfies Record<IntentResourceType, …>`。
- [x] T6.2 `IntentMountDialog.tsx`：`MOUNT_TYPES = INTENT_RESOURCE_TYPES`。
- [x] T6.3 `IntentOpPreview.tsx`：`OP_PREVIEW_RENDERERS satisfies Record<IntentResourceType, (input) => ReactElement | null>`（mcp / plugin `() => null`）。
- [x] T6.4 `IntentEntryButton.tsx` / `IntentProvenanceBadge.tsx` props 类型、`routes/intent.tsx` `ARTIFACT_TYPES` / `IntentArtifactHint`
      改用 shared roster。
- [x] T6.5 测试（实际落地，实现门 r5 #4 勘正）：新 `intent-roster-derivation.test.tsx`——六处源码级锁（无手写六类 union / 数组、必须引用 shared roster、
      `satisfies Record<IntentResourceType, …>` 表、`MOUNT_TYPES` / `ARTIFACT_TYPES = INTENT_RESOURCE_TYPES`）+ 反向样本；既有
      `intent-list-inline` / `intent-op-preview` / `intent-entry-badge` / `intent-detail-inline` 不改断言即绿。

### T7 — 编译期守卫实证（AC-7 / AC-14）

- [x] ☆ T7.1 ★ 八个 `@ts-expect-error` 夹具常驻（T2.8）。红屏取证程序（★ 诊断分述）：**临时去掉一条指令** → 暴露被压制的底层
      类型错误（如 TS2741 缺属性）；**临时让目标表达式合法而保留指令**（把缺的键补上） → TS2578「未使用的 @ts-expect-error」；
      另**临时扩一个真实 schema**（如 `ReviewNodeSchema.extend({zzz: z.string()})`）→ 注册表处报错。三段 `bun run typecheck`
      红屏截取 → 恢复 → 再截一次绿；全部进实现报告。
- [x] T7.2 AC-14：临时在 validator 加 `readNumber(node, cond ? 'zzzFake' : 'maxIterations')`、在 `workflowLaunchInputs.ts` 加
      `numberField(def, 'zzzFake')` 各跑一次 `intent-teaching-registry.test.ts` 必红，记录后回退。

### T8 — 文档与索引

- [x] T8.1 `docs/dev-gotchas.md` §新增 NodeKind：第 9 处改写为「已由 `INTENT_NODE_TEACHING` 编译器保护；字段级由
      `intent-teaching-*` 测试保护」；补「新增 ACL 资源类型要在 `platformMap.ts` 声明立场」「validator 读 passthrough 字段
      一律走 `read*` helper」。
- [x] T8.2 `design/plan.md` 状态 → In Progress / Done；`STATE.md` 收口；`design/RFC-348-*/verification-report.md`
      （字节数、AC-7 / AC-14 输出、测试计数、CI run id）。

### T9 — 门与发布

- [x] T9.1 Codex 实现门（只审功能；范围限定本 RFC 文件清单；安全类内容一律弃置）并修 findings（r1～r5 共 17 条折入，r6 0 findings 通过；见 verification-report §5）。
- [ ] T9.2 精确 pathspec `git add` / `git commit -- <paths>`；push；exact-SHA Main CI 盯到绿；红了小改补一提或 revert。

## 依赖

```
T1 ──► T2 ──► T3 ──► T4
        │      │ └──► T5（T5.0 先核对 RFC-345 在制品）
        │      └──► T7（★ 显式边：T2 → T7、T3 → T7；T7 完成后才进 T8）
        └───► T6
T4/T5/T6/T7 ──► T8 ──► T9
```

与 RFC-345（W4-C）的重叠见 design §7：T1 / T2 / T6 无重叠可先行；T3 / T4 / T5 触碰 `services/intent/**` 前核对共享树。

## PR / 提交拆分

单 RFC、多笔提交于 `main`（不建分支），建议 4 笔以便归因：
① `feat(shared): RFC-348 loop exit-condition kinds + opencode permission vocabulary SSOT + intent agent branchPorts + hint enum`（T1）；
② `feat(intent): RFC-348 意图教学注册表与 INTENT.md 派生`（T2+T3+T4+T7 夹具）；
③ `fix(intent): RFC-348 dump branchPorts / runtimes / agent 端口 + update 不再清空 branchPorts`（T5）；
④ `feat(frontend): RFC-348 意图入口与预览从 roster 派生`（T6）+ 文档（T8）。
每笔 `git diff --cached --stat` 自查暂存区，只含本 RFC 路径。

## 验收清单（对应 proposal §6）

- [x] AC-1 形态 + 字段（含嵌套 / 变体）覆盖 + clarify 端口　- [x] AC-2 能力地图 + 路由对照　- [x] AC-3 hint 三态（含第 2 轮）
- [x] AC-4 branchPorts 四态 + 下一轮 dump　- [x] AC-5 漂移字段补齐 / overrides 停教　- [x] AC-6 runtimes 清单（有效默认）
- [x] AC-7 八个常驻夹具　- [x] AC-8 对账红　- [x] AC-9 既有契约测试不改即绿　- [x] AC-10 前端六处派生
- [x] AC-11 ≤32 KB　- [ ] AC-12 exact-SHA CI 绿　- [x] AC-13 agent 行端口名　- [x] AC-14 反向扫描红　- [x] AC-15 编辑器 `port-inactive`
- [x] ★ AC-16 九类只读清单　- [x] ★ AC-17 mcp oauth 往返　- [x] ★ AC-18 sidecar 省略即保留

## 设计门记录

- r1（2026-08-30）：Codex 12 条 + Claude 子代理 11 条 → 全部核实并折入 r2。
- r2（2026-08-30）：Codex 闭合复核（11 resolved / 8 wrongly resolved）+ 9 条新 findings → 全部核实并折入 r3（见 proposal §8）。
- r3（2026-08-30）：Codex 闭合复核（7 resolved / 2 wrongly resolved）+ 6 条新 findings → 全部核实并折入 r4（见 proposal §8）。
- r4（2026-08-30）：Codex 闭合复核（4 resolved / 2 wrongly resolved）+ 4 条新 findings → 全部核实并折入 r5（见 proposal §8）。
- r5（2026-08-30）：Codex 闭合复核（2 resolved / 2 wrongly resolved）+ 24/17 对象节点 walk + 5 条新 findings → 全部核实并折入 r6（见 proposal §8）。
- r6（2026-08-30）：Codex 闭合复核（4 resolved / 1 wrongly resolved）+ walk（无未认领、3 处重复认领）+ 5 条新 findings → 全部核实并折入 r7（见 proposal §8）。
- r7（2026-08-30）：Codex 闭合复核（5 resolved / 2 wrongly resolved）+ walk 干净 + 4 条新 findings → 全部核实并折入 r8（见 proposal §8）。
- r8（2026-08-30）：Codex 闭合复核（3 resolved / 3 wrongly resolved）+ 3 条新 findings → r9 以真实 `tsc` 探针验证类型机制后折入（见 proposal §8）。
- r9（2026-08-30）：Codex 复核 r8（1 resolved / 2 wrongly resolved：design 残留旧声明与旧示例）+ 3 条新 findings（0 P1）→ 折入 r10。范围含 `type-probe.md`。
- r10（2026-08-30）：Codex 复核 r9 六项 resolved + 4 条新 findings（0 P1 / 2 P2 / 2 P3）→ 折入 r11（探针 8 strict kind、`AuthorableAvailability`、词汇 / 清单）。
- r11（2026-08-30）：Codex 复核 r10 + 2 条 P3（探针 `export` / 注释，已清）→ **无 P1/P2，设计门收口**。
- 用户批准（2026-08-30）：D1～D12 + 实现 / 提交推送授权；三项另裁（sidecar 省略即保留、mcp oauth 可创作、九类列真实行）折入 r12。
- r12：待跑（Codex，只审功能；范围 = 三件套 + `type-probe.md`，重点 = 另裁三项的修订段落）。

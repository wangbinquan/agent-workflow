# RFC-348 实现验证报告（2026-08-30）

> 只审功能；本报告不含任何安全类检视项。CI 结论以 GitHub Actions 按 exact SHA 为准（见 §5）。

## 1. 交付物

| 层 | 文件 | 说明 |
| --- | --- | --- |
| shared | `schemas/workflow.ts`（`LOOP_EXIT_CONDITION_KINDS` / `LoopExitConditionKind`）、`schemas/agent.ts`（`OPENCODE_PERMISSION_{KEYS,ACTIONS,WILDCARD_KEY}`）、`schemas/intentSession.ts`（`hint: z.enum(INTENT_RESOURCE_TYPES)`）、`schemas/intentChangeset.ts`（agent `branchPorts`、remote mcp `oauth: object \| false`）、`intentSecretSlots.ts`（`/payload/config/oauth/clientSecret` 载体、`projectMcpOAuthForDump`） | D1b / D5d / D4 / D5 / D2 |
| backend 纯域 | `modules/intent/domain/teaching/{types,nodeKinds,resourceTypes,workflowParts,platformMap,reconciliation,render,permissionGrammar}.ts` | D1 / D2 / D3 / D6，RFC-294 domain 层，架构守卫零违规 |
| backend services | `services/intent/intentDoc.ts`（纯装配，零 kind / 类型 / 字段字面量）、`turnEngine.ts`（`requestedArtifactTypeOf`、`effectiveDefaultRuntime`、`platformInventory` seam）、`dumpBuilder.ts`（`branchPorts` 投影、agent 行端口、`inventory/runtimes.md`、`inventory/platform/<type>.md`）、`resolveChangeset.ts`（`branchPorts` 直通、oauth 槽 + overlay、`agent-branch-port-undeclared` 草稿校验）、`applyChangeset.ts`（四个 sidecar 省略即保留、oauth 仅省略时沿用）、`platformInventory.ts`（九类 loader + 投影 + 端口） | D4 / D5 / D5b / D5c / D3 / D2 |
| backend 消费者 | `modules/task-execution/domain/loopExitCondition.ts`（roster 双向编译锁 + 查表）、`services/runtime/opencode/boundary.ts`、`services/runtime/claudeCode/permissionMap.ts`（改 import shared 常量） | D1b / D5d |
| frontend | `routes/intent.tsx`、`components/IntentMountDialog.tsx`、`components/IntentEntryButton.tsx`、`components/IntentProvenanceBadge.tsx`、`components/intent/IntentCreateComposer.tsx`（`RESOURCE_TYPE_ICONS/LABELS satisfies Record<IntentResourceType,…>`）、`components/intent/IntentOpPreview.tsx`（`OP_PREVIEW_RENDERERS satisfies Record<IntentResourceType,…>`）、`canvas/inspector/WrapperGitLoopEdit.tsx`（下拉由 roster map）、i18n 两处 `fieldExitConditionKindHint` 补 `port-inactive` | D6 / D1b |
| docs | `docs/dev-gotchas.md` §新增 NodeKind 第 9 处条目改写；design §1.2 读点勘误、§10 债项改写；proposal §8 r12 记录 | T8 |

## 2. 验收标准对照（proposal §6）

| AC | 证据 |
| --- | --- |
| AC-1/2/3/5/11（补 `continueOnMaxIterations` / `port-inactive` / `branch` / `branchPorts` / `permission` / mcp `timeoutMs` / `oauth`，删 `overrides`） | `tests/rfc234-intent-doc.test.ts` 「RFC-348 — registry-rendered capability teaching」（73 pass） |
| AC-4 / AC-18（branchPorts 落库、省略保留、`[]` 清除、`⊄ outputs` 草稿报错、dump 顶层） | `tests/intent-agent-branch-ports.test.ts`（4 pass） |
| AC-6（hint 三态、两轮） | `tests/rfc234-turn-engine.test.ts` 「RFC-348 — requested artifact type…」（31 pass） |
| AC-7（八个 `@ts-expect-error` 夹具） | `tests/intent-teaching-exhaustive.test.ts`；红屏证据 §3 |
| AC-8（对账 29/24/18/9 + 三类反向自检） | `tests/intent-teaching-reconciliation.test.ts`（13 pass） |
| AC-9（五个契约文件不改断言即绿） | rfc234-intent-doc 68→73（只增）、intent-doc-validator-contract 41、intent-privileged-node-capability 51、rfc291-unavailable-mount 8、docs-node-kind-coverage 5、rfc304 4 —— 全绿，断言未改 |
| AC-10（AST 正反向扫描 + 三份基线 + 反向自检） | `tests/intent-teaching-registry.test.ts`（25 pass） |
| AC-12（`inventory/runtimes.md`：effective default、`(default)` 恰一次、disabled、无 binaryPath） | turn-engine 追加段 |
| AC-11（≤32 KB） | 全权限 doc 22,708 → 29,402 bytes、无权限 18,933 → 25,375 bytes（T3.4 记录；既有 `BUDGET_BYTES = 32 * 1024` 守卫仍绿，本 RFC 追加同预算守卫）；增量来自 Platform capability map / Requested artifact type / Common mistakes 三节与 permission / runtime / oauth 教学句 |
| AC-13（agent 行端口） | `tests/rfc234-dump-builder.test.ts` 追加段（10 pass） |
| AC-14（新 NodeKind 编译红） | 红屏证据 §3 |
| AC-15（前端六处派生 + 下拉五项） | `packages/frontend/tests/intent-roster-derivation.test.tsx`（4）、`rfc348-exit-kind-roster-consumers.test.ts`（2）；frontend tsc / eslint 零告警 |
| AC-16（九类真实行、可见性、无 handle、截断、仍不可入 op） | `tests/intent-platform-inventory.test.ts`（4 pass） |
| AC-17（oauth 槽、字面量拒绝、`false`、update 省略沿用 / 显式替换、dump 只脱敏 clientSecret） | `tests/intent-mcp-oauth.test.ts`（4 pass）、shared `intent-secret-slots.test.ts`（期望更新为只脱敏 `clientSecret`） |

## 3. 编译期守卫红屏证据（AC-7 / AC-14）

1. **去掉一条 `@ts-expect-error`**（`tests/intent-teaching-exhaustive.test.ts` 夹具 1「缺一个 NodeKind」）→ `bunx tsc --noEmit -p packages/backend`：
   `tests/intent-teaching-exhaustive.test.ts(47,40): error TS1360: Type '{ input: …; 'agent-single': …; … }' does not satisfy the expected type '{ readonly input: …; …; readonly review: …; … }'`（被压制的底层错误暴露）。恢复指令后零错误。
2. **给 `NODE_KIND` 加 `'zzz-fake-kind'`**（`packages/shared/src/schemas/workflow.ts`）→ `src/modules/intent/domain/teaching/nodeKinds.ts(331,12): error TS1360: Type '{ readonly input: …; … }' does not satisfy the expected type '{ readonly input: …; …; readonly 'zzz-fake-kind': …}'`。撤销后零错误（`git diff --stat` 回到本 RFC 自己的 18 行）。
3. 八个夹具全部存在时 `tsc` 对本 RFC 路径零诊断（无 TS2578「未使用的 @ts-expect-error」）。

## 4. 本地跑过的门（可选自查，非提交前置）

- `bunx tsc --noEmit`：shared / frontend 零错误；backend 在本 RFC 路径零错误（工作树里 RFC-347 并行 session 的 `auth/actor` / `routes/*` / `server.ts` 半截重构另有红，不属本 RFC，未提交）。
- `bunx eslint --max-warnings 0` 与 `prettier --check`：本 RFC 改动文件零告警。
- 测试：shared 全量 2271/2271（更新一条 oauth 投影期望后）；backend 本 RFC 新增 7 文件 + 扩展 5 文件全绿（计数见 §2）；`tests/architecture/rfc294-review-module-layer-rules` 7/7；frontend intent 五文件 + 两新文件全绿。
- 定向回归子集（`intent|rfc234|rfc291|rfc304|rfc348|docs-node|loop|permission|boundary|rfc236|rfc306|architecture|clarify|rfc253|rfc269|rfc243|rfc099`）：见 §5 的 CI；本地出现的 `rfc326-review-decision-transaction` 6 条红与本 RFC 无关（评审决策事务计数；本 RFC 未触及 review / distill 路径，该文件单跑同样红，归因于工作树里并行 session 的未提交改动，以 CI 为准）。

## 5. 门与 CI

- Codex 实现门 r1（2026-08-30，只审功能）：6 条（0 P1 / 4 P2 / 2 P3），全部折入——
  ① runtimes 清单改为 design §4 格式（`# runtimes (N)` / `Effective default: <name> (<protocol>)` / 锁句 `RUNTIME_INVENTORY_RULE` /
  `- <name> — protocol <protocol> (default) (disabled)` / 默认无行合成 `(built-in, no profile row)`），`effectiveDefaultRuntime` 改为 `{name, protocol}`，
  测试补 ≥2 profile、disabled、默认无行、Builder runtime ≠ 全局默认；② platform-only loader 失败不再吞成 `Unavailable this turn`，
  按 proposal §5 与其他 dump 读同级 ⇒ 整轮 `intent-turn-crashed` durable error（新增回归测试注入 `listRows` 抛错、断言 runFn 未跑）；
  ③ `clientSecret?:'‹secret›'` 可选标记（形态、oauth 子表说明句、两处契约断言）；④ 「Reference rules (hard)」段迁入 `render.ts`
  `renderReferenceRules()`，call 节点 kind / `workflowName|workgroupName` / `workflowRef|workgroupRef` / `workflowId|workgroupId`
  全部经 `CALL_SELECTORS satisfies {… keyof (typeof INTENT_NODE_TEACHING)['call-workflow']['fields'] …}` 类型化查表，`intentDoc.ts`
  零 kind / 字段字面量；⑤ Requested artifact type 改用 design §3 批准版两条常量（`REQUESTED_ARTIFACT_PICKED` / `REQUESTED_ARTIFACT_NONE`），
  三组测试锁原文与两轮传递；⑥ AC-16 改为九类两 actor 表驱动夹具（六类直插身份行、三类 employee 走 `IntentEmployeeAuthoringReads` 桩）+
  九类 `requests` 拒绝 + employee_tool DB/平台目录合并与重复 id 去重（`createDefaultIntentPlatformInventory(db, overrides)` 新增注入点）。
- Codex 实现门 r2（2026-08-30）：r1 六项复核全部闭合；新 2 条（0 P1 / 1 P2 / 1 P3），已折入——
  ① draft 期校验拿到 mounted agent 的既有 `branchPorts`（`DraftValidationContext.agentBranchPorts` ← `IntentDumpResult.agentBranchPorts`，
  `turnEngine` 传参），update 省略 `branchPorts` 且删掉对应 output 时在 draft 期即报 `agent-branch-port-undeclared`（文案指出「省略即保留」与修法）；
  ② `loadAgentPorts` 调用边界回归锁（恰一次、只收截断后 id、空端口行渲染 `inputs:[] outputs:[]`）。
- Codex 实现门 r3（2026-08-30）：r2 两项闭合；新 3 条（0 P1 / 1 P2 / 2 P3），已折入——
  ① 根级 `definition.outputs[]` 形态由 `WORKFLOW_OUTPUT_TEACHING` 渲染进 workflow 段（`renderOutputDeclarations()`：
  `outputs:[{name,bind:{nodeId,portName}}]`，与 `output` 节点 `ports` 同形），registry / intent-doc 各加锁；② proposal / design / plan 的
  D5b / D5c 文字与实现同步（`resolveAgentRuntime(db, null, cfg.defaultRuntime)`、runtime 行在 dump 内读、`loadAgentPortsFromDb` 在
  `dumpBuilder` 内 + `IntentDumpInput.loadAgentPorts` seam，不再有 `agentPortsProjection.ts`）；③ T5.5 的编译期穷尽守卫真正落地：
  `resolveIntentBundle` payload switch、`applyInner` create switch 各加 `default: { const _exhaustive: never = … }`，update switch 的
  既有 default 也加 never 断言。
- Codex 实现门 r4（2026-08-30）：r3 三项闭合；新 2 条（0 P1 / 1 P2 / 1 P3），已折入——
  ① `intentDoc.ts` 残余的工作目录布局与 Output contract 迁入 `renderWorkingDirectoryLayout()` / `renderOutputContract()`（op / question /
  mount-request 字段名以 `KeysOf<schema>` 键控、`INTENT_ENVELOPE_PORTS`），并加源码级锁：剥离注释后不得出现任何 kind / 资源类型 /
  payload·envelope 字段 / 清单文件名字面量；② design §0 / §1.2 / §2 / §6 / §7 与 plan T3.1 / T5 标题同步到实现（loopStrategy 读点、
  无 `agentPortsProjection.ts`、`OP_PREVIEW_RENDERERS` 的 mcp / plugin `() => null`、`platformInventory.ts`）。
- Codex 实现门 r5（2026-08-30）：r1～r4 的 13 项修复全部确认落地、无运行时回归（Codex 定向验证 shared 33 / backend 291 / frontend 6 全绿）；
  新 4 条（0 P1 / 1 P2 / 3 P3），已折入——① 「Single-turn delivery budget」迁入 `renderDeliveryBudget()`（`summary` 由 `INTENT_ENVELOPE_PORTS`
  派生，`INTENT_TURN_GUIDANCE` 随渲染器迁入 `render.ts` 并由 `intentDoc.ts` 再导出），源码锁改为先反转义模板字面量里的反引号再匹配
  （曾放过 `\`summary\``）；② design §1.3 mcp 示例 `clientSecret?`；③ AC-6 / D3 / T5.3b 文字改为实际调用链（`resolveAgentRuntime`、
  `PlatformInventoryContext` / `createDefaultIntentPlatformInventory` / `RunIntentTurnDeps.platformInventory?`）；④ T1.6 / T6.3 / T6.5 与
  design §9 测试矩阵改为真实文件名与 `OP_PREVIEW_RENDERERS`。
- Codex 实现门 r6（2026-08-30）：**0 findings，实现门通过**（r1～r5 折入项全部复核闭合；Codex 定向验证 shared 33 / backend 291 / frontend 6、三包 typecheck 全绿）。实现门六轮累计 17 条（0 P1 / 8 P2 / 9 P3）。
- 提交：__待补__（四笔 exact-pathspec 提交的 SHA）。
- GitHub Actions（exact SHA）：__待补__。

## 6. 已知债（design §10）

- platform-only 九类 loader 直接引用各模块 infrastructure / composition 工厂（bootstrap 注入端口 `platformInventory?` 已留 seam，RFC-347 落地后换成 bootstrap 组装）。
- passthrough 字段仍只有测试级保护；`turnEngine` / `dumpBuilder` 仍在 `services/`。

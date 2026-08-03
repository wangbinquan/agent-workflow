# RFC-251 任务分解 —— 恢复 OpenCode 插件与多代理

依赖顺序：T1 → T2/T3 可并行 → T4 → T5 → T6 → T7。
建议单 PR 交付（直接推 `main`，本仓不建分支）；若拆分见 §PR 拆分。

---

## RFC-251-T1 —— 抽出插件 spec 数组纯函数

- 把 `runtime/opencode/inlineConfig.ts:168-183` 的 plugin 数组构建抽为纯函数
  `buildPluginSpecArray(plugins: readonly Plugin[])`，放 shared 或 backend 公共位置
  （按现有依赖方向定，不新建包）。
- `inlineConfig.ts` 改为调用它，**行为零变化**。
- **测试**：enabled 过滤 / 按 `plugin.id` 去重 / options 非空发元组 / 空输入不产出键。

**验收**：现有 inlineConfig 相关测试不改一行仍绿。

---

## RFC-251-T2 —— 受控配置注入插件

- `BuildControlledAgentConfigInput` 加 `plugins`；`buildControlledOpencodeConfig`
  （`hermetic.ts:597`）产出 `plugin` 键（复用 T1）。
- `verifiedPlan.ts:530` 传入 `ctx.plugins`。
- **确认 `OPENCODE_PURE`**：检查 `buildHermeticServerEnv` 是否设置该变量；设了就取消
  （否则 `plugin/index.ts:177` 静默清空插件）。
- 删除 `verifiedPlan.ts:393-395` 的插件拒绝。
- **测试**：受控配置带插件时 `plugin` 键形态正确；**显式断言 env 中不含
  `OPENCODE_PURE=1`**（这是最易漏的静默失败点）。

---

## RFC-251-T3 —— 受控配置注入 dependsOn 闭包 + 放行 `task`

- `buildControlledOpencodeConfig` 注册 `dependents` 每项为 `mode: 'subagent'` 条目。
- **定稿子代理 permission 派生方式**（design §4.2 待定项 a/b），先读 opencode
  `deriveSubagentSessionPermission`（`tool/task.ts:139`）确认不会双重收敛。
- `DENIED_TOOLS` 的 `'task'` 改条件：闭包非空 → `allow`，否则 `deny`。
- 确认 skills/MCP 并集处理（design §4.3）。
- 删除 `verifiedPlan.ts:390-392` 的依赖拒绝。
- **测试**：闭包成员全部出现在 agent 注册表且 `mode: 'subagent'`；`task` 权限随闭包
  空/非空切换；嵌套闭包（A→B→C）BFS 去重。

---

## RFC-251-T4 —— 移除 attestation

- 删 `verifiedLauncher.ts:1007` 的 `verifyIdentity` 注入与调用、
  `executionIdentity.ts:750` `verifyExecutionIdentity` 及其专用类型。
- **保留** `canonicalizeIdentity` / `identityDigest` / `businessOpencodeIdentityDigest`
  （resume 校验在用，`verifiedPlan.ts:594`）。
- 按 design §5.3 重定义 inventory 来源：改为单次直读，不再两次比对。
- **测试**：session resume 的 owner digest 校验**仍然生效**（这是最危险的连带面，
  必须有独立回归锁）。

---

## RFC-251-T5 —— 清理 failure code 与策略表

- 删码：`plugin-unsupported`、`dependent-unsupported`、`instance-changed`。
  **保留 `mismatch`**（`hermetic.ts:606,611` 仍在用，见 design §5.4）。
- 同步：`shared/src/executionIdentity.ts` union、
  `shared/tests/rfc224-execution-identity-failure-taxonomy.test.ts:25-46` 有序断言、
  `i18n/en-US.ts` 与 `zh-CN.ts` 各 3 处（message / hint / `$t` 别名）。
- 删策略表 `:86-91` 两个 push，及 `enabledPluginCount` / `dependentAgentCount` /
  `field: 'plugins' | 'dependsOn'` 死代码。
- 简化 `services/executionPolicy.ts` 的 `resources` 参数与 6 处传参点。
- **测试**：taxonomy 测试更新；i18n 无残留 key。

---

## RFC-251-T6 —— UI 与本轮遗留物清理

- `AgentForm.tsx:266-278` 只保留 `model-unresolved`。
- **删除本轮已改的两条 blocker 文案**（zh/en 各 message+hint）——功能恢复后它们无意义。
- `packages/frontend/tests/agent-form-opencode-execution-policy.test.tsx`：删除插件 /
  依赖相关 4 个 case 与整个「blocker copy」describe，保留 `model-unresolved` 与
  claude-code 不拦的覆盖，文件头注释改写为 RFC-251 语境。
- **测试**：选了插件 / 可协作代理的 OpenCode 代理**不再**出现 blocker banner（回归锁）。

---

## RFC-251-T7 —— 既有测试套件分类处理 + 文档回填

- 按 design §8.2 逐个处理 32 个 RFC-224/227 测试文件，**PR 描述里列出每个文件的处置
  结论**（不动 / 改写 / 删除 + 一句理由）。**禁止 skip**。
- 五入口正向覆盖（agent create、agent update、直接启动、workgroup、scheduled）。
- 文档回填：
  - `design/plan.md` RFC 索引加 RFC-251 行；
  - `STATE.md` 顶部「进行中 RFC」→ 完工后移入已完成表；
  - `RFC-224/design.md` §1.2/§1.3/§8 加注"已被 RFC-251 推翻"；
  - `CLAUDE.md` 「Architecture concepts」中 agent/MCP 管理段落里"插件与 dependsOn
    在 verified v1 不支持"的表述更新；
  - `docs/dev-gotchas.md` 补一条：**对 opencode 行为的断言必须对当前源码复核**
    （本 RFC 即因三条过期论断而起）。

---

## PR 拆分建议

默认单 PR。若要拆，安全切点是 **T1–T3（功能恢复）** 与 **T4–T5（attestation 移除）**：
前者不依赖后者，可先交付并让用户提前用上插件与多代理；后者独立收尾。
T6/T7 跟随各自相关的 PR。

## 验收清单

- [x] T1–T7 全部完成
- [x] 保存/启动入口的 OpenCode 代理带插件 / 带 dependsOn 均可保存 + 启动
      （`rfc251-product-boundary.test.ts`：create / update / workflow launch gate /
      scheduled create，另加 `model-unresolved` 仍拒的反向锁）
- [x] `OPENCODE_PURE` 与插件选择一致（双向显式断言，`rfc251-controlled-config.test.ts`
      + `rfc224-verified-plan.test.ts` 的 manifest 端到端断言）
- [x] session resume digest 校验未被 T4 波及（`rfc224-execution-identity.test.ts`
      保留 `businessOpencodeIdentityDigest` 稳定性/敏感性/脱敏三组锁）
- [x] 既有测试逐个处置，无 skip（见下）
- [x] `typecheck` / `lint` / `format:check` / `depcheck` 全绿；frontend 696 files ·
      5909 tests 全绿；backend 全量余 2 项属于并发 RFC-250 未提交改动的失败
- [ ] 提交 + 推送后按 exact SHA 查 CI 绿
- [ ] Codex 实现门跑过并修完 findings

## 既有测试处置结论

| 文件 | 处置 | 理由 |
| --- | --- | --- |
| `rfc224-execution-identity.test.ts` | **改写** | 删 attestation 比对套件（final config identity / Agent.Info / same-instance seal）与 `makeInput` fixture；保留 canonical JSON 编解码与 `businessOpencodeIdentityDigest`；secret-safe 断言**改挂到仍存在的 digest 路径**而非删除 |
| `rfc224-verified-launcher.test.ts` | **改写** | 删 `verifyIdentity` seam 与 fake client 的 `getConfig` 录制桩；调用序列断言 `['config','providers','agents','skills','agents']` → `['providers','agents','skills']`（两处） |
| `rfc224-verified-plan.test.ts` | **扩写** | fixture 支持 `dependents` / `plugins`；新增 3 条端到端正向用例（读 manifest 断言 `plugin` 数组、`PURE` 缺席/存在、闭包注册与 root `task: allow`） |
| `rfc223-identity-structural-guard.test.ts` | **改写** | 删 6 个随 attestation 消失的 name-keyed sink 允许项，新增 2 条（`agents[dep.name]`、`resolvedParamsByAgent.get(dep.name)`）并附审阅理由；总数 140 → 136 |
| `rfc224-execution-identity-failure-taxonomy.test.ts`（shared） | **改写** | 有序码表删 3 项 |
| `opencode-identity-preflight.integration.test.ts` | **改写** | 两处 `verifyExecutionIdentity` 调用删除；改为断言受控 agent 确实注册 + 保留 RFC-234 system profile 的 live permission 断言 |
| `agent-form-opencode-execution-policy.test.tsx`（frontend） | **改写** | 本轮先加的 blocker 断言反转为「不再出现 blocker」回归锁；保留 `model-unresolved` 与 claude-code 不拦覆盖 |
| `runner-plugin-inject.test.ts` | **改写** | 源码文本锚点跟随 `pluginSpec.ts`；新增「inlineConfig 仍委托、未重新内联」反向锚点 |
| 其余 RFC-224/227 文件（direct-* / sealed-* / source-guard / store-hygiene / official-builds / fff-capability / rfc227-* / 3 个 migration 等） | **不动** | 与 attestation 无关，全部原样通过 |

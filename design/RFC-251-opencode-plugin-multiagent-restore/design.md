# RFC-251 技术设计 —— 恢复 OpenCode 插件与多代理

## 1. 现状：拦截点分三层

| 层                     | 位置                                                                                                                                                                                                   | 行为                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| ① 策略表（唯一事实源） | `packages/shared/src/executionIdentity.ts:86-91`                                                                                                                                                       | `enabledPluginCount > 0` → `plugin-unsupported`；`dependentAgentCount > 0` → `dependent-unsupported`。`:81` 对非 `opencode` 协议直接返回 `[]` |
| ② 产品边界调用点       | `services/executionPolicy.ts` 的 `assertAgentExecutionPolicy` → `agent.ts:192`（create）/ `agent.ts:423`（update）/ `agentLaunch.ts:362` / `scheduledTasks.ts:287,317` / `workgroup/launch.ts:264,405` | 违规抛 `ValidationError(permanent)`                                                                                                           |
| ③ 运行期最终门         | `services/runtime/opencode/verifiedPlan.ts:390-395`                                                                                                                                                    | `ctx.dependents.length > 0` 与 `ctx.plugins.some(enabled !== false)` 各自 `executionIdentityFailure`                                          |
| ④ UI                   | `components/AgentForm.tsx:266-278`                                                                                                                                                                     | 渲染 `agent-opencode-execution-policy` blocker banner                                                                                         |

注意 ② 中 `routes/config.ts:123,140,169` 走的是 `assertResolvedExecutionPolicy(runtime)`
**不带** `resources` 参数——只校验 model，不受本 RFC 影响；`config.ts:172` 走
`assertAgentExecutionPolicy` 受影响（切换全局默认运行时到 OpenCode 时的预检）。

## 2. 底层能力盘点：没被删，只是没接上

- **插件注入实现完整保留**：`runtime/opencode/inlineConfig.ts:119-183` —— 按 enabled 过滤、按 canonical plugin id 去重、`file://<cachedPath>` 或 `[spec, options]` 元组、仅在非空时发出 `plugin` 键。
- **多代理闭包完整保留**：`ctx.dependents`（`runtime/types.ts:426`）由 runner 一路传入（`runner.ts:789`、`:1209`）。
- **verified 路径没有复用它们**：`verifiedPlan.ts:530` 调 `buildControlledOpencodeConfig`（`hermetic.ts:597`）自建受控配置，只注册**单个** primary agent（`hermetic.ts:624-636`），且 `task` 在 `DENIED_TOOLS`（`hermetic.ts:545-557`）里。

所以工作是**把既有注入接回 verified 配置构建器**，不是重写。

## 3. 恢复插件支持

### 3.1 受控配置增加 `plugin` 数组

`BuildControlledAgentConfigInput` 增加可选 `plugins: readonly Plugin[]`，
`buildControlledOpencodeConfig` 在返回对象上按 **inlineConfig.ts:168-183 完全相同的规则**
产出 `plugin` 键。为避免两份实现漂移，把该段抽成 shared 纯函数
`buildPluginSpecArray(plugins): Array<string | [string, Record<string, unknown>]>`，
`inlineConfig.ts` 与 `hermetic.ts` 同时调用。

**契约**：仅 `enabled !== false` 的记录入选；按 `plugin.id` 去重（闭包可能重复访问）；
`optionsJson` 非空时发元组；数组为空时**不发** `plugin` 键（保持与现有受控配置字节形态一致）。

### 3.2 数据流

`ctx.plugins`（已存在于 `BusinessNodeSpawnContext`）→ `verifiedPlan.ts:530` 传入
`buildControlledOpencodeConfig` → `OPENCODE_CONFIG_CONTENT`。

### 3.3 删除拦截

移除 `verifiedPlan.ts:393-395`。

### 3.4 `OPENCODE_PURE` 的处置

平台当前是否给受控 server 设 `OPENCODE_PURE` 需在实现时确认（`hermetic.ts`
`buildHermeticServerEnv`）。若设了，**必须取消**——否则 `plugin/index.ts:177` 会把
`plugin_origins` 清空，插件静默不加载。这是本 RFC 最容易漏的一处，实现时必须有断言覆盖。

## 4. 恢复多代理支持

### 4.1 `task` 工具放行

`DENIED_TOOLS`（`hermetic.ts`）中的 `'task'` 改为**条件放行**：闭包非空时放行，
否则维持 `'deny'`。不做无条件放行——没有依赖闭包的代理拿到 `task` 只会得到
"未知 agent"错误，放行没有收益，deny 更贴合最小权限。

**放行形态必须是 pattern 映射，不能是 `'allow'`（Codex 实现门 P1，已修）**：

```
task: { '*': 'deny', <闭包成员 1>: 'allow', <闭包成员 2>: 'allow', … }
```

裸 `task: 'allow'` 会展开成 pattern `*`。OpenCode 的 `task` 工具随后对**任意**
`subagent_type` 调 `agent.get()`，而它的**内置** agent（`general`/`explore`/
`build`/`plan`…）始终在注册表里、不受我们 config 控制，各自带默认的写/shell 面。
于是「一个自身禁了 bash 的 root」可以委派给 `general` 借到能力——而父 session 只
向子会话传播三条非工具 deny（§4.2），拦不住。

映射形态下 `'*': 'deny'` 在前、成员名在后，`findLast` 让具体成员名赢、其余一律落
到 deny。

### 4.2 闭包成员注册进 agent 注册表

`buildControlledOpencodeConfig` 目前返回单 agent。改为额外注册 `dependents` 每一项，
形态对齐 opencode 的 agent registry：

```
agent: {
  [root.name]:  { ...现有 primary 条目, permission: { ...permission, task: <条件> } },
  [dep.name]:   { prompt, description, model, mode: 'subagent', hidden: false,
                  permission: <按 dep 自身 readonly / 工具面派生>, options: {} },
}
```

**已定稿（实现结论）：选 (b)——每个成员独立跑一次受控 permission 构建。**

成员条目不从 root 的 agent 条目继承任何东西，所以「什么都不声明」= 什么权限都没有。
必须自带完整 permission。

**受控键必须追加在用户覆盖之后（Codex 实现门 P1，已修）**：原实现是
`{...userPermission}` 再逐个赋值，但**给已存在的键赋值不会移动它**——用户写
`{"task":"allow","*":"allow"}` 时，平台把 `task` 改成 `deny` 却仍留在 `*` 之前，
`findLast` 选中后面的 `*` 从而放行。现引入 `CONTROLLED_PERMISSION_KEYS`
（`bash` + `DENIED_TOOLS` + `external_directory`）：先**丢弃**用户对这些键的覆盖，
再把平台值**追加到末尾**。用户的其它键（含 `*`）原样保留在前，故无 wildcard 的
合法配置最终值完全不变。

**运行期合并链（逐条源码核实，勿凭记忆）**：

1. `tool/task.ts:139` 用 `deriveSubagentSessionPermission` 造子 session 的
   permission：取**父 session** permission 中 `action === 'deny'` 或
   `external_directory` 的规则，再按需补 `todowrite`/`task` 的 deny。
2. `session/llm.ts:149-151` 算最终 ruleset：
   `Permission.merge(agent.permission, session.permission)` —— `merge` 就是
   `flat()`（`permission/index.ts:200-202`），随后 `findLast` 取最后匹配项，
   **即 session 侧覆盖 agent 侧**。

**关键区分**：平台那条长 deny 尾巴（read/edit/write/apply_patch/grep/glob/skill/
webfetch/websearch/lsp）位于**受控配置的 agent 条目**，**不在 session 上**。平台
建 session 只传 `ROOT_SESSION_PERMISSION_RULES` 三条——`question`/`plan_enter`/
`plan_exit` 全 deny（`directApiSchemas.ts:73-77`，且 `CreateSessionRequestSchema`
把它约束成恰好 3 元组）。因此被继承进子 session 的只有这三条无害 deny，成员条目
自带的 `bash: allow` 不会被压过（算 `bash` 时只有成员自己的规则匹配）。

**由此得到一条必须守住的不变量**：工具级 deny 只能加在 agent 条目上，
**绝不能加进 root session permission**——那会连坐每一个子代理，且表现为模型干不动
活而非显式失败。测试 `rfc251-controlled-config.test.ts` 对此加了显式锁。

`task` 对成员恒为 `deny`：v1 不做嵌套委派，且 opencode 对未声明 `task` 的子代理
本来就会补一条 `task: deny`（`:25`），两边一致。

### 4.3 skills / MCP 并集

**已定稿（实现结论）：本 RFC 不改动 skill 密封面。**

verified 路径的 skill 密封由 `ctx.skills` 驱动（`verifiedPlan` 的 `plannedSkills`），
该集合仍按现状构成——本 RFC 只把 `dependents` 注册进 agent 注册表，没有扩大被密封
的 skill 集合。成员因此共享本次运行已密封的 skill 面。

这是有意的最小改动：扩大密封面属于 skill 来源策略变更（非目标已排除），且需要
独立设计（每个成员的 skill 是否应互相隔离、SKILL.md 冻结块如何按成员分区）。若
后续要做，另立 RFC，走既有 managed skill 密封通道，不引入新机制。

### 4.4 删除拦截

移除 `verifiedPlan.ts:390-392`。

## 5. 移除 attestation

### 5.1 移除范围

- `verifiedLauncher.ts:1007` 的 `verifyIdentity` 注入点与其调用；
- `executionIdentity.ts:750` `verifyExecutionIdentity` 及其专用输入/证明类型（`:43`、`:61`）；
- 为 attestation 服务的第二次 `/config`、`/agent` 读取与同实例比对。

### 5.2 **必须保留**（否则连带炸掉）

- `identityDigest`（`:253`）、`businessOpencodeIdentityDigest`（`:272`）、
  `canonicalizeIdentity`（`:248`）—— **session resume 校验仍在用**（`verifiedPlan.ts:594`
  比对 `owner.identityDigest`）。删掉会打断 RFC-224 §7.1 的 session 归属机制，
  而那是非目标。
- `firstIdentityDifference`（`:380`）—— 若仅服务 attestation 报错则可删，实现时确认。

### 5.3 verified inventory 的连带问题

RFC-224 的 verified inventory 是"同实例 attestation 通过后，从第二次 sealed `/agent`
响应派生"。attestation 移除后，`verifyProviderInventory` / `verifySkillInventory` /
`writeInventory`（`verifiedLauncher.ts:1008-1011`）的数据来源与语义需要重新定义：

**方案**：保留这三者，改为**直接读一次** `/agent`、`/config/providers` 作为事实来源，
不再做"两次读取互相比对"。它们仍能捕获"选中的 provider/skill 实际不存在"这类真实错误，
只是不再声称证明了未被篡改。

### 5.4 failure code 处置

| code                                                                                                                                                                                                        | 处置             | 理由                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-unsupported`                                                                                                                                                                                        | **退役**（见下） | 功能恢复                                                                                                                                                                              |
| `dependent-unsupported`                                                                                                                                                                                     | **退役**（见下） | 功能恢复                                                                                                                                                                              |
| `instance-changed`                                                                                                                                                                                          | **退役**（见下） | attestation 专用                                                                                                                                                                      |
| `mismatch`                                                                                                                                                                                                  | **保留**         | ⚠️ 不只是 attestation 结果码——`hermetic.ts:606,611` 用它表示**受控配置构建输入非法**。删掉会留下无码可报的分支。实现时确认是否改名更清晰（改名会牵动 i18n + DB 历史值，倾向保留原名） |
| `skill-mismatch` / `provider-untrusted`                                                                                                                                                                     | **保留**         | 按 §5.3 改为直读校验，仍是真实错误                                                                                                                                                    |
| `source-changed` / `project-config-unsupported`                                                                                                                                                             | **保留**         | 属 sourceGuard，非目标                                                                                                                                                                |
| `untrusted-binary` / `containment-required` / `sandbox-required` / `bootstrap-failed` / `auth-invalid` / `model-unresolved` / `session-*` / `control-failed` / `stream-failed` / `timeout` / `store-unsafe` | **保留**         | 与 attestation 无关                                                                                                                                                                   |

**「退役」≠「删除」（Codex 实现门 P1 修正）**：本节最初写的是从闭集里删除，实现时
也确实那样做了——但 `failure_code` 是**无迁移的普通 TEXT**，而任务列表页用严格
`z.enum` 对**整个 payload** `.parse()`（`useTaskOperationsPage.ts:33`）。⇒ 升级前
因插件/依赖被拒而留下的**任一**历史任务，会让**整页解析失败**，不是那一行降级。

最终形态是把发射域与读取域拆开：

- `EXECUTION_IDENTITY_FAILURE_CODES`（可产生）：删掉这三个；
- `LEGACY_EXECUTION_IDENTITY_FAILURE_CODES`（**新增，只读**）：三个退役码，
  并入 `FAILURE_CODES` 供 schema 解析，且 `isExecutionIdentityFailureCode` /
  `isPermanentRuntimeFailure` 对它们仍返回真（旧行的重试语义不变）；
- i18n 保留三条**「历史失败」语气**的双语文案，让存量任务仍可读。

同步清理面：`shared/src/executionIdentity.ts` 两个 union、
`shared/tests/rfc224-execution-identity-failure-taxonomy.test.ts` 的有序断言与新增的
「退役码不可产生但仍可解析」回归锁、`i18n/en-US.ts` + `zh-CN.ts` 的 message/hint。
`errors.*` 命名空间的别名**不恢复**——那是 API 错误面，已无路径产生这三个码。

## 6. 策略表与 UI

- `shared/src/executionIdentity.ts:86-91` 删两个 push；`EffectiveExecutionPolicyInput`
  的 `enabledPluginCount` / `dependentAgentCount` 及 `ExecutionPolicyViolation.field`
  的 `'plugins' | 'dependsOn'` 一并删除（无调用方后即死代码）。
- `services/executionPolicy.ts` 的 `resources` 参数与 6 处传参点简化。
- `AgentForm.tsx:266-278` 只保留 `model-unresolved` 一条。
- **本轮已改的两条 blocker 文案与 `agent-form-opencode-execution-policy.test.tsx`
  中对应的 4 个 case 一并删除**；该测试文件保留 `model-unresolved` 相关断言与
  claude-code 不拦的 case。

## 7. 失败模式

| 场景                    | 表现                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件文件缺失 / 加载抛错 | opencode 走 `publishPluginError`（`plugin/index.ts:194-208`）；平台侧 RFC-031 既有的 `[rfc031/plugin-load-failed]` stderr tag → RFC-027 事件流 |
| 子代理名未注册          | opencode `tool/task.ts:133` 返回 `Unknown agent type`，作为工具错误回到模型                                                                    |
| 子代理深度超限          | opencode `tool/task.ts:111-117`；如需 >1 层需显式设 `subagent_depth`，**本 RFC 不改默认值**                                                    |
| 插件试图联网            | containment 边界（RFC-227）仍然生效，不因本 RFC 放宽                                                                                           |

## 8. 测试策略

### 8.1 必写正向覆盖

1. `buildPluginSpecArray` 纯函数：enabled 过滤 / id 去重 / options 元组 / 空数组不发键。
2. `buildControlledOpencodeConfig`：带插件 → `plugin` 键形态正确；带 dependents → agent 注册表含全部闭包成员且 `mode: 'subagent'`；`task` 权限按闭包非空条件切换。
3. `verifiedPlan`：带插件 / 带 dependents 的 ctx **不再**返回 `executionIdentityFailure`（锁死回归）。
4. 产品边界：agent create/update、直接启动、workgroup、scheduled 五个入口，带插件 / 带 dependsOn 的 OpenCode 代理**保存与启动成功**（现有 `rfc224-product-boundary-policy.test.ts` 的反向断言需改写）。
5. i18n：删除的码在两个 locale 中均无残留 key（可复用现有 parity 测试机制）。

### 8.2 既有 32 个 RFC-224/227 测试文件的处置

必须**逐个分类**，不允许整文件 skip：

- **不动**：`rfc224-direct-*`（4 个）、`rfc224-sealed-*`、`rfc224-source-guard`、`rfc224-store-hygiene`、`rfc224-official-builds`、`rfc224-fff-capability`、`rfc227-*`、三个 migration 测试 —— 均与 attestation 无关。
- **改写**：`rfc224-execution-identity.test.ts`（attestation 断言删除，digest 断言保留）、`rfc224-verified-launcher.test.ts`（移除 verifyIdentity seam）、`rfc224-verified-plan.test.ts`（两条拒绝断言反转为放行）、`rfc224-verified-inventory.test.ts`（按 §5.3 新语义）、`rfc224-product-boundary-policy.test.ts`、`shared/tests/rfc224-execution-identity-failure-taxonomy.test.ts`。
- **实现时判定**：其余按实际引用面归类，PR 描述里逐个列出处置结论。

### 8.3 门槛

`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；
推送后按 exact SHA 查 CI（并发 push 会取消 run，见 `docs/dev-gotchas.md`）。

## 9. 与现有文档的关系

RFC-224 / RFC-227 **不整体作废**——其二进制冻结、来源守卫、containment、直接 API、
session 归属部分继续有效。本 RFC 只推翻其中"插件 / 多代理不支持"与"启动后配置比对"
两项决定。落地后需在 `RFC-224/design.md` §1.2、§1.3、§8 与 `CLAUDE.md`
「Architecture concepts」相关段落加注指向 RFC-251，避免后续 session 按过期论断行事。

## 10. 已知限制（交付时明确未解决）

Codex 实现门（[记档](./codex-impl-gate-2026-08-03.md)）指出三条**已核实属实、本 RFC
未修**的问题。它们不是遗漏，而是需要独立设计或产品决策；全部登记在
`docs/audit-backlog.md`。**读本 RFC 的人必须知道这三条，否则会高估交付面。**

### 10.1 插件不受 containment 约束（P0）

插件由 OpenCode 在 **server 进程内** `import` 并被授予 `Bun.$`；而 server 在 macOS
明确不过 Seatbelt（`services/sandbox/index.ts`）、Linux 侧也未隔离网络
（`services/sandbox/policy.ts`）。shell / local-MCP 的 no-network child wrapper 完全
不介入。⇒ 恶意或被攻陷的插件可读工作区、起进程、联网外传，`sandboxMode=enforce`
也拦不住。

这不是本 RFC 引入的缺陷，而是**「支持插件」这一产品决定的固有代价**——插件按定义
就是宿主进程内执行的代码，RFC-224 当年禁它的理由之一正是这个。用户在知情下要求恢复
该功能，故不擅自加回限制。

> **与 RFC-252 的交叉影响**：RFC-252 的审计结论「业务 agent 没有 read/edit/write/
> webfetch 等**进程内**工具」成立的前提是插件被禁用。插件恢复后，等于在 agent
> permission 层**之下**多了一个进程内 shell，绕过「工具被 deny 即被摘出模型工具
> 列表」这条机制。RFC-252 的威胁模型需显式纳入「已安装且被选中的插件」。

### 10.2 ~~Linux + `enforce` 下插件根本加载不了~~（P1，**已修复**）

> **✅ 2026-08-03 已修并在真 Linux 上确证。** 下面保留原始分析作为背景；修法与
> 证据见本节末尾。

插件装在 `appHome/plugins`，而 `policy.ts` 对整个 `appHome` 打 `--tmpfs` 后只显式
bind 回 `repos`；`allowSubtrees` 是 RFC-205 impl-gate P0-3 刻意的「deny 全部
appHome、只放行本次运行所需」白名单，插件目录不在其中 ⇒ `file://<cachedPath>` 在
server 内不存在，动态 import 得 `ENOENT`。

（原判断为「只在 macOS 可用、Linux 视为不可用」，已随本节修复失效。）

**这条不是读代码推断，是实证的**，且**不需要 Linux 机器**即可复跑：
`computeSandboxPolicy` / `renderBwrapArgs` 是纯函数（`policy.ts` 注释 "Pure — no
fs access"），所以 Linux 会用的那串 bwrap argv 在任何平台上都能确定性生成。按
argv 顺序重建挂载命名空间后，实测结果：

```
tmpfs  <appHome>                 ← 整个 appHome 被盖住
bind   <appHome>/repos           ← 只有这两处被 bind 回来
bind   <appHome>/runs/<task>/<run>
plugin cachedPath -> visible=false   （最深挂载仍是那层 tmpfs）
```

随后在 **Debian + bubblewrap 0.11.0 的真容器**里、用平台自己生成的 argv 复跑，
确认 `plugin entry : ENOENT` 而 `repos marker : VISIBLE`——缺陷确证，非建模推断。

#### 修法（已落地）

`readOnlySubtrees` 表达不了这个需求：它是「在 RW allow 内部挖一个 RO 洞」，并被
校验为某个 `allowSubtrees` 的**严格后代**。插件缓存按设计**没有** RW 父级（整个
appHome 被 deny，且插件永远不该可写）。因此新增一条独立概念：

- `SandboxPolicyInput.readOnlyAllowSubtrees` —— 位于**被 deny 子树内**、**不与任何
  RW allow 重叠**的只读放行。两条约束都在 `computeSandboxPolicy` 里 fail-closed
  校验（越界或重叠直接抛，不静默降级）。
- bwrap：在 appHome tmpfs **之后**追加 `--ro-bind`；Seatbelt：在 deny 之后只补
  `(allow file-read* …)`，**不发** write allow，故 last-match-wins 下写仍被 deny。
- `verifiedPlan` 只放行**被选中插件**各自的私有安装根 `plugins/<id>`（最小权限，
  不放行整个 `plugins/`）；`file:` spec 的 cachedPath 落在 appHome 外、本就可见，
  按前缀判断跳过。

**真 Linux 复验（同一容器、同一 argv 生成路径）**：

```
read   : OK        => plugin IS loadable
write  : denied    => "Read-only file system"
repos write : OK / runDir write: OK      （无回归）
host-side integrity: 文件未被沙箱内的写入尝试篡改
```

回归锁：`packages/backend/tests/rfc251-linux-plugin-visibility.test.ts` —— 覆盖
「不放行则不可见（缺陷的成因）/ 放行后是 ro-bind / ro-bind 排在 tmpfs 之后 /
Seatbelt 只给读不给写 / 三条校验各自拒绝」。

### 10.3 闭包成员拿不到自己选的 skill（P1）

`services/scheduler.ts` 已正确合并 `dependsOn` 闭包的 skills，但 `verifiedPlan` 只把
冻结的 `SKILL.md` 追加进 **root** persona，成员拿到的是原始 `dep.bodyMd`，而 `skill`
工具本身在受控 permission 里是 deny。⇒ `auditor` 依赖的审计 skill，root 看得到、
真正执行审计的 `auditor` 看不到，**多代理能力因此是打折的**。

§4.3 已把「不改动 skill 密封面」列为非目标（扩大密封面涉及成员间 skill 是否隔离、
`SKILL.md` 冻结块如何按成员分区），故明确登记而非默认关闭。

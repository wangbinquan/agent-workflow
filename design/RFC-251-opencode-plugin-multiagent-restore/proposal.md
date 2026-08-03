# RFC-251 —— 恢复 OpenCode 运行时的插件与多代理支持

## 背景

`RFC-022`（agent `dependsOn` 多代理依赖）与 `RFC-031`（agent `plugins` 插件依赖）
在 `design/plan.md` 的 RFC 索引里都标记为 **Done**——两条链路都完整实现并交付过：

- RFC-022：保存期闭包校验（不存在 / 自引 / 环 / 反向引用）+ **运行期闭包注入 inline JSON + skills 并集** + 编辑表单依赖树；
- RFC-031：`plugins` 资源表 + 急安装到独占目录 + **runner 按 `dependsOn` 闭包合并 plugin 并集注入 `OPENCODE_CONFIG_CONTENT.plugin`**（`file://<cachedPath>` 形态，保证 spawn 零网络）。

`RFC-224`（verified OpenCode execution identity，commit `b4b3e082`）引入"启动后回头核对
配置未被篡改"的证明链时，以三条 opencode 行为论断为由，在 **OpenCode 运行时上整体禁用**
了这两个已完工功能：任何选了插件或可协作代理的代理，既存不下也跑不起来。

对本机 opencode 源码（**v1.18.4**；RFC-224 的论断基于 v1.18.3）逐条核验，三条论断
**两条与源码不符、一条系误读**：

| RFC-224 `design.md` 的论断                                           | opencode v1.18.4 源码实际                                                                                                           |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| §1.2 V2 `ConfigExternalPlugin` 不遵守 `OPENCODE_PURE`                | `plugin/index.ts:177` —— `flags.pure ? [] : (cfg.plugin_origins ?? [])`，**遵守**；`:166` 另有 `disableDefaultPlugins` 可关内置插件 |
| §1.3 官方 `run --attach` 第三次 `/agent` lookup 失败会回退默认 agent | `tool/task.ts:131-134` —— 未知 agent **直接 fail**（`Unknown agent type: ... is not a valid agent type`），不存在静默回退           |
| §1.3 HTTP `SubtaskPartInput` 能 `bypassAgentCheck`                   | `tool/task.ts:119-129` —— 该标志跳过的是**权限询问**（`ctx.ask`），agent 身份仍走 `agent.get()`；名字有误导性                       |

opencode 自身对子代理另有深度上限（`tool/task.ts:111-117`，默认 `subagent_depth: 1`）
与父→子权限收敛（`:139-155`）。三条论断里唯一仍成立的是 legacy 工具目录扫描
（`tool/registry.ts:180`，`{tool,tools}/*.{js,ts}` 且 `symlink: true`）——但它扫的是
`config.directories()`，平台早已把这些目录私有化，在受控环境下该集合本就为空。

**一条真实但已被现有机制覆盖的风险，代价是禁掉两个已完工的产品功能。**

这与平台立项初衷相悖：本平台的定位就是**驱动多个 opencode 进程作为协作代理**，
插件与多代理是用户可组合能力的一部分，不应在主运行时上整体缺席。

## 目标

1. **OpenCode 运行时恢复支持 agent 插件**——RFC-031 全链路在 verified 执行路径上重新可用。
2. **OpenCode 运行时恢复支持 `dependsOn` 多代理**——RFC-022 闭包在 verified 执行路径上重新注入并可被委派。
3. **移除"启动后回头核对配置"这一层**（attestation）——配置封装后直接执行，不再做同实例二次读取比对。

## 非目标（明确不动）

- **进程隔离**（RFC-205/227 containment、bwrap / Seatbelt、FFF 证明）——保持现状；本 RFC 不放宽任何沙箱边界。
- **直接 API 执行链路**（`directClient` / `directCodec` / `sse` / `controlProtocol`）——这是执行机制而非校验，保持现状。
- **session 归属与恢复**——owner 行、`identityDigest` / `businessOpencodeIdentityDigest` 仍用于 resume 校验（`verifiedPlan.ts:594`），**不删**。
- **skill 与 MCP 现状**——包括 `verifiedPlan.ts:396-398` 对非 `managed` skill 的拒绝。本 RFC 不触碰，避免范围蔓延。
- **claude-code 运行时**——其插件 / `dependsOn` 行为本就不受此策略约束（`shared/executionIdentity.ts:81`），不变。
- **二进制冻结 / 来源守卫 / store 卫生**——`sourceGuard`、`officialBuilds`、`storeHygiene` 保持现状。

## 用户故事

1. 作为使用者，我在代理编辑界面给一个 OpenCode 代理选了插件，**能正常保存并运行**，不再被红色 blocker 拦住。
2. 作为使用者，我给代理配了「可协作的代理」，运行时它**能把子任务委派**给闭包里的代理。
3. 作为使用者，我的代理插件在 opencode 里正常加载，加载失败时我能在事件流里看到原因（RFC-031 既有的 `[rfc031/plugin-load-failed]`）。
4. 作为管理员，我不再见到 `execution-identity-plugin-unsupported` / `execution-identity-dependent-unsupported` 这两类任务失败。

## 验收标准

- [ ] 选了插件的 OpenCode 代理可以保存（`POST/PATCH /api/agents` 不再 400）、可以直接启动、可以进工作流 / 工作组 / 定时任务。
- [ ] 选了 `dependsOn` 的 OpenCode 代理同上。
- [ ] 运行期 `OPENCODE_CONFIG_CONTENT` 内含：插件闭包并集（`file://<cachedPath>` / `[spec, options]` 元组）与 `dependsOn` 闭包成员的 agent 注册表条目。
- [ ] `task` 工具在受控 permission 中对**有非空 `dependsOn` 闭包**的代理放行；闭包为空时维持 deny。
- [ ] 代理编辑界面不再对插件 / 可协作代理显示 blocker；`model-unresolved` 这条**保留**。
- [ ] `EXECUTION_IDENTITY_FAILURE_CODES` 中作废的码全部从 union、i18n（en-US + zh-CN）、taxonomy 测试中一并移除，无残留孤儿 key。
- [ ] 现有 RFC-224/227 测试套件（32 个文件）全部重新分类处理：保留的继续绿，因 attestation 移除而失效的显式删除或改写，**不允许 skip 掉了事**。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 四项全绿；CI 按 exact SHA 查绿。

## 风险与取舍（记录在案）

移除 attestation 后，平台不再能证明"opencode 最终生效配置 == 平台下发配置"。
残留的合并面（active-org / managed / MDM / legacy mode / `OPENCODE_PERMISSION`，
见 RFC-224 `design.md:41-43`）在理论上仍可改变最终配置而不被发现。

这是**用户在 2026-08-03 明确拍板的取舍**：功能可用性优先于该层证明。

> **⚠️ 上面这段最初还写着「进程隔离（containment）作为独立防线保留不变，仍然限制被
> 执行代码的实际能力边界」——Codex 实现门证明该句对插件不成立，已删。**
>
> 插件由 OpenCode 在 **server 进程内** `import` 且被授予 `Bun.$`，而 server 在 macOS
> 明确不过 Seatbelt、Linux 侧也未隔离网络；shell / local-MCP 的 no-network child
> wrapper 完全不介入。⇒ **插件不受 containment 约束**，`sandboxMode=enforce` 也拦不住。
> 这是「支持插件」的固有代价（插件按定义就是宿主进程内执行的代码），不是本 RFC 可以
> 顺手补上的。完整分析与另两条已知限制见 [design §10](./design.md#10-已知限制交付时明确未解决)，
> 未决项登记在 `docs/audit-backlog.md`。
>
> 由此还引出一条**跨 RFC 影响**：并发落档的 RFC-252 的审计结论「业务 agent 没有
> read/edit/write/webfetch 等**进程内**工具」，其成立前提正是插件被 RFC-224 禁用；
> 插件恢复后该前提部分失效，其威胁模型需显式纳入「已安装且被选中的插件」。

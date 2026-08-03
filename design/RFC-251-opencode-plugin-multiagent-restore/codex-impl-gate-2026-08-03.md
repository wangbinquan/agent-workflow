# RFC-251 Codex 实现门（2026-08-03）

范围：分离 worktree，`git diff 23d9d6e4..9baa5ea0`（本 RFC 的完整提交）。
工具：`codex exec --sandbox read-only`（CLI 0.146.0；companion 路径因插件 1.0.6 ×
CLI 0.146.0 不兼容而绕过，见 `docs/dev-gotchas.md` §Codex）。
判定：**needs-attention —— 1 × P0 + 6 × P1 + 2 × P2**，逐条核实后**全部属实**。
不是空洞通过：findings 精确指到 `hermetic.ts` 的键序、`policy.ts` 的 tmpfs、
`useTaskOperationsPage.ts` 的整页 parse 这类只有真读代码才能发现的位置。

## 已修（6 条）

| #   | 级别 | 问题                                                                                     | 核实                                                                                                                                                                                                                                                                                  | 修法                                                                                                                                                                               |
| --- | ---- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | P1   | 受控 permission 键序允许用户 wildcard 覆盖平台强制规则                                   | **属实**。`Permission.evaluate` 是 `rulesets.flat().findLast(...)`（opencode `permission/index.ts:28-34`），而 `{...userPermission}` 后再赋值**不会移动已存在的键** ⇒ 用户写 `{"task":"allow","*":"allow"}` 时，平台把 `task` 改成 `deny` 却仍留在 `*` 之前，`findLast` 选中 `*` 放行 | 引入 `CONTROLLED_PERMISSION_KEYS`：先**丢弃**用户对受控键的覆盖，再把平台值**追加到末尾**。无 wildcard 的配置最终值不变                                                            |
| 3   | P1   | `task: 'allow'` 展开成 pattern `*`，可委派给 opencode **内置** agent（general/explore…） | **属实**。内置 agent 不在我们的 config 里但在注册表中；root session 只传三条非工具 deny ⇒ 一个禁了 bash 的 root 能借子代理拿到写/shell                                                                                                                                                | `task` 改为 pattern 映射 `{'*':'deny', <每个闭包成员>:'allow'}`，靠 `findLast` 让具体名字赢、其余落到 deny                                                                         |
| 6   | P1   | inventory / diagnostics 对插件固定报 `0`                                                 | **属实**。`verifiedInventory.ts` 结构性写死 `plugins: []`，`verifiedPlan` 写死 `pluginCount: 0`                                                                                                                                                                                       | inventory plan 增 `plugins`（sealed `file://` specifier + `sourceKind`）；新增 `selectShippedPlugins()` 作为「实际发出的插件集合」单一来源，spec 编码与 inventory 同源，不可能漂移 |
| 7   | P1   | 删除 failure code 未保留历史读取兼容                                                     | **属实且最严重**。`FailureCodeSchema` 是严格 `z.enum`，`useTaskOperationsPage.ts:33` 对**整页** `.parse()` ⇒ 升级前因插件/依赖被拒的任一历史任务会让**任务列表整页解析失败**                                                                                                          | 拆分 emit / read 两个域：新增 `LEGACY_EXECUTION_IDENTITY_FAILURE_CODES`，不在可产生集合里但并入 `FAILURE_CODES`；i18n 补回三条「历史失败」语气文案                                 |
| 8   | P2   | plugin/PURE 的「端到端」测试没查实际启动配置                                             | **属实**。断言的是 `manifest.expectedConfig`，而 launcher 消费的是 `manifest.serverEnv.OPENCODE_CONFIG_CONTENT`                                                                                                                                                                       | 测试改为解析 `serverEnv.OPENCODE_CONFIG_CONTENT` 断言 plugin 与 agent 注册表                                                                                                       |
| 9   | P2   | 设置页与 `docs/OPENCODE_CONFIG.md` 仍宣称存在已删除的 attestation                        | **属实**                                                                                                                                                                                                                                                                              | 双语文案改为「两种运行时均不做启动后配置验证」；docs 加显式移除说明；连带更新锁该文案的 `rfc237-settings-intent-claude-note.test.tsx`                                              |

## 未修 —— 需要产品/安全决策（3 条，已登记 `docs/audit-backlog.md`）

**#1（P0）插件代码不受 containment 约束。** 核实属实：插件由 OpenCode 在 **server 进程内**
`import` 并获得 `Bun.$`；而 server 在 macOS 明确不过 Seatbelt（`sandbox/index.ts:117`）、
Linux 侧也未隔离网络（`policy.ts:184`）。shell / local-MCP 的 no-network child wrapper
完全不介入。⇒ 恶意或被攻陷的插件可读工作区、起进程、联网外传，且 `sandboxMode=enforce`
也拦不住。

这不是本 RFC 引入的缺陷，而是**「支持插件」这一产品决定的固有代价**：插件按定义就是在
宿主进程里执行的代码。RFC-224 当年禁插件的理由之一正是这个。用户已明确要求恢复该功能，
故此处**不擅自加回限制**，改为如实登记并请用户在知情下确认。

**#4（P1）Linux enforce 下插件缓存被 bwrap 隐藏。** 核实属实：插件装在 `appHome/plugins`，
而 `policy.ts` 对整个 `appHome` 打 `--tmpfs` 后只显式 bind 回 `repos`；`allowSubtrees`
是 RFC-205 刻意的「deny 全部 appHome、只放行本次运行所需」白名单，插件目录不在其中。
⇒ **Linux + enforce 下插件必 `ENOENT`，功能等于没交付。**

未修的原因：修它要同时动 bwrap 的 RW/RO 叠加次序（`readOnlySubtrees` 必须是某个
`allowSubtrees` 的**严格后代**）与 Seatbelt 侧 deny-list 语义，而这段是 RFC-205 impl-gate
P0-3 修过的承重边界。它同时和 #1 是同一个未决问题的两面：**插件与 containment 的关系
从未被设计过**。应与 #1 一起在独立 RFC 里定稿，而不是顺手改。

**#5（P1）dependent 自己选的 skill 没交给 dependent。** 核实属实：`scheduler.ts` 已正确
合并闭包 skills，但 `verifiedPlan` 只把冻结的 `SKILL.md` 追加进 **root** persona，成员拿到
的是原始 `dep.bodyMd`，而 `skill` 工具本身是 deny 的。⇒ `auditor` 依赖的审计 skill，root
看得到、真正干活的 `auditor` 看不到。

本 RFC 的 `design.md` §4.3 已把「不改动 skill 密封面」写为非目标（扩大密封面涉及成员间
skill 是否隔离、`SKILL.md` 冻结块如何按成员分区，需要独立设计）。Codex 的指认成立，说明
多代理功能目前是**打折**的，故明确登记而非默认关闭。

## 门禁复跑（修完 6 条后）

`typecheck` / `lint` / `format:check` 全绿；shared 1617 pass · 0 fail；
backend RFC-223/224/227/251 + inventory 相关 544 pass · 0 fail；
frontend 696 files · 5911 tests（`rfc237-settings-intent-claude-note` 随 #9 文案同步更新）。

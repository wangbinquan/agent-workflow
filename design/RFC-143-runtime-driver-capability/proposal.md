# RFC-143 — runtime 能力对象收口（RuntimeDriver capability consolidation）

状态：Draft（待用户批准）
触发：`design/flag-audit-2026-07-07.md` §4.1「runtime 半截注册表」——全场最重的 P0 结构性欠账。用户 2026-07-07 拍板走最彻底方案（业务 spawn 一步到位全收 + 范围含 dedup 类 + live poller 空转 bug 纳入本 RFC）。

---

## 1. 背景

RFC-111 PR-A 引入了 `RuntimeDriver` seam（multica 的 Backend-factory 命名思路），目标是让「第二种 agent CLI（Claude Code）」能插进一个原本 opencode-hardcoded 的 runner。但 seam 只长了一半——`RuntimeDriver` 接口至今只有三个方法：`kind` / `parseEvent` / `buildSpawn`（`services/runtime/types.ts:139-153`），而且 `buildSpawn` **只服务 system-agent**（distiller/commit/fusion，RFC-117 收口，`SystemAgentSpawnContext` 刻意声明「NO skills/mcp/plugins/inventory」，`types.ts:103-133`）。

`types.ts:10-11` 的接口注释白纸黑字写着计划「PR-B adds `probe` / `listModels` / `captureSession`」——但这些从未落到 driver 对象上，全部成了自由函数 + 调用点 `if (runtime === 'claude-code')` 分支。实证测绘（2026-07-07）确认 driver 注册表之外散落 **22 处 runtime 判别旁路**：`runner.ts` 拿到 `driver = getRuntimeDriver(runtime)`（`runner.ts:481`）后，**全文件只调用了 `driver.parseEvent`**（`runner.ts:1068`）；业务节点 spawn 在 `runner.ts:838/861` 直接调 `buildClaudeSpawn` / `buildOpencodeSpawn` 两个自由函数，完全绕过 driver。

这个「半截注册表」有三重代价：

1. **扩展成本爆炸**：flag-audit 扩展成本总表估计「新增第三种 runtime ≈ 14-15 处 if/else」；精确测绘后是 **22 处**（横跨 runner / runtimeSmoke / runtimeRegistry / nodeRunMint / memoryDistiller / routes×3 / cli×2）。RFC 的核心价值主张——「新增 runtime = 注册一个 driver」——目前完全不成立。
2. **实证真 bug**：live subagent poller（`runner.ts:1110-1146`）对**所有 runtime 无条件启动**，claude-code 运行时每 1500ms 拿 claude 的 session id 去打开 **opencode 的 SQLite**（`resolveOpencodeDbPath`）做 BFS，恒 0 命中——纯 CPU 浪费 + 语义错误（把 claude run 指向 opencode 的库）。
3. **绕过已有单一注册表**：`BUILTIN_NAMES`（`runtimeRegistry.ts:30`）、`RUNTIME_PROTOCOLS`、`ProtocolSchema` 都已存在，但 `runtimeRegistry.ts:171` / `nodeRunMint.ts:307,373` 各自硬编码 `n === 'opencode' || n === 'claude-code'` 字面量集合旁路它们；default-binary/config-key 判别在 `runtimeRegistry.ts:239` 与 `routes/runtimes.ts:80` 有 2 份逐字拷贝；`resolveOpencodeCmd` 在 5 个 route 文件里逐字复制 5 份。

## 2. 目标 / 非目标

### 目标

- **把六类 runtime 能力差异全部内聚进 `RuntimeDriver`**：① 业务节点 spawn 组装 ② inventory 插件（注入+回读）③ live 子代理轮询 ④ 凭据桥 ⑤ 模型列表 ⑥ 默认二进制+config key；外加 ⑦ 版本探测 probe ⑧ 会话捕获 captureSessions。
- **消灭全部 22 处旁路**：runner/smoke/registry/nodeRunMint/distiller/routes/cli 里的 `runtime === 'xxx'` / `protocol === 'xxx'` / `isClaude` / 硬编码集合字面量分支，全部改为「调 driver 方法」或「查 driver capability 字段」。
- **让「新增第三 runtime」成立**：新增 = 新建一个 driver 目录 + 在 `DRIVERS` 注册一行 + 实现能力接口；各调用点零改动。以一个 mock driver 测试作为编译期/测试期证明。
- **顺带修 live poller 空转真 bug**（收成 `driver.startLiveCapture?()`，claude 不实现 → 天然消除）。
- **派生清理**：`BUILTIN_NAMES`/`RUNTIME_PROTOCOLS`/`ProtocolSchema` 从 `DRIVERS` 单一派生；`resolveRuntime` 半死三元、`nodeRunMint` 硬编码集合、`default-binary` 2 拷贝、`resolveOpencodeCmd` 5 拷贝、`resolveInternalAgentRuntime` legacyModel 半死代码一并收口/消除。

### 非目标

- **不改 opencode 的运行时行为**：`runtime-opencode-golden.test.ts` 锁定的 opencode argv/env 必须 **byte-for-byte 逐字不变**——这是最硬的验收约束。收口是「同一输出换个组织方式」，不是行为变更。
- **不引入第三个真 runtime**：本 RFC 只把接口补全到「可插」，不实现新 runtime（那是未来独立工作）。mock driver 仅用于测试。
- **不动 claude 的凭据桥 / sandbox env 语义**：`claudeSandboxEnv` 的 `IS_SANDBOX='1'` 精确串（uid===0 gate，memory `reference_claude_root_is_sandbox`）、`bridgeCredentials` 订阅凭据桥逻辑原样保留，只改「从哪里判别要不要用」。
- **不改 `RuntimeKind` type union 本身**：`'opencode' | 'claude-code'` 保留为 type-level union（冻结列类型安全）；只让运行时集合（`RUNTIME_PROTOCOLS`/`BUILTIN_NAMES`/`ProtocolSchema`）从 `DRIVERS` 派生。新增 runtime 时手加一个 union 字面量是可接受的一处（类型系统会强制补全 `DRIVERS` 表）。

## 3. 用户故事

- **作为未来接第三种 agent CLI 的开发者**：我想只新建 `runtime/<name>/` 目录、实现 `RuntimeDriver` 的能力方法、在 `DRIVERS` 注册一行，就让平台全链路支持它——而不是 grep 出 22 处 `if (runtime === ...)` 逐个补分支、还漏掉一两处导致运行时诡异行为。
- **作为运维 claude-code 任务的用户**：我不希望我的 claude 任务后台每 1.5 秒空跑一次 opencode SQLite 查询（当前 live poller 无 gate 空转）——收口后 claude driver 不声明 live 能力，poller 根本不启动。
- **作为维护者**：我想让「claude 可用性 / 默认二进制 / 内建名 / 冻结值合法性」都从**同一个 driver 注册表**派生，而不是 6-7 处各自硬编码同一份 kind 字面量集合、改一处漏其余。

## 4. 验收标准

1. **旁路清零**：`rg -n "runtime === 'claude-code'|runtime === 'opencode'|protocol === 'opencode'|protocol === 'claude-code'|isClaude"` 在 `packages/backend/src`（排除 `runtime/` 子目录内部 driver 实现与 tests）**零命中**（driver 实现内部允许 kind 分支，那是能力的本体）。源码文本锁守卫此不变量。
2. **golden 锁全绿**：`runtime-opencode-golden.test.ts` 逐字不变通过——opencode 业务 spawn 的 argv/env byte-for-byte 一致。
3. **live poller 空转消除**：新增回归测试——claude runtime 的 runNode 不启动 live poller（`driver.startLiveCapture` 未实现 → `NOOP_HANDLE`），断言 opencode SQLite 零 open。
4. **「注册即扩展」证明**：新增一个 mock `RuntimeDriver`（第三 kind），实现全部能力接口，跑通一条 mock 业务 spawn + probe + listModels + capture 的集成测试，**不改任何调用点**（runner/routes/cli/registry 源码零 diff）——证明接口完备。
5. **派生单源**：`BUILTIN_NAMES`/`RUNTIME_PROTOCOLS`/`ProtocolSchema` 从 `DRIVERS` 派生的源码断言；`nodeRunMint`/`runtimeRegistry` 不再出现硬编码 `'opencode' || 'claude-code'` 字面量集合。
6. **门禁全绿**：typecheck×3 / lint / format / 后端 bun test 全量 / 前端 vitest / binary smoke（本 RFC 触 shared 导出与 runtime 模块，binary 模块环风险，必跑）。
7. **Codex 实现门 + 设计门**：设计门（本文档写完、请求批准前）+ 实现门（每个 PR 代码后）各跑一轮，修 findings。

## 5. 相关 RFC / 挂钩

- **RFC-111**（runtime 抽象引入）：本 RFC 是它「PR-B 承诺但未落地」的补完。
- **RFC-112/113/117/118**（custom fork / runtime profile / system-agent buildSpawn / runtime enabled）：这些是 driver 已收口的先例，本 RFC 沿用同款模式扩到全部能力。
- **flag-audit §4.1 + §8**：§4.1 定性、§8 决策（claudeCodeEnabled 配置门已删、claude 可用性由 runtimes 注册表派生——本 RFC 建立在该派生之上）。
- **dedup-audit**：`resolveOpencodeCmd` 5 拷贝、default-binary 2 拷贝、probe 的 extractVersion/compareSemver 各一份重复——本 RFC 一并收口。

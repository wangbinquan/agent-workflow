# RFC-112 — 运行时注册表（自定义二进制按 opencode / claude 协议纳管）

状态：**Done**（4 PR + 落档 + 双 gate 全部上库、PR-A/B/C/D CI 绿；Codex 设计 gate 8 findings + 实现 gate 4 findings 全 fold〔见 design §10〕；门禁 typecheck×3 + backend 4151 pass/0 fail + 前端 vitest 2761 + binary smoke + lint + format）

触发：2026-06-27 用户「有些环境基于 opencode / claude code 源码定制了功能、启动二进制已不叫 opencode / claude，希望按这两个运行时的模式探测、纳管、使用；既探测默认的，也支持探测给定二进制是否符合协议要求并纳入；可配置默认运行时、agent 可自定义覆盖」。

> **后续修订（RFC-224 / RFC-226，2026-07-24）**：生产 OpenCode 已收口到受验证的官方
> v1.18.3 exact-hash 构建，且 OpenCode 不再是 daemon 启动硬门；本文关于自定义 OpenCode fork
> 与启动拒绝的旧合同仅作历史背景。注册表抽象与显式 runtime probe 仍有效。

---

## 1. 背景

RFC-111 引入了**两个固定运行时** `opencode` / `claude-code`，各对应一个 `RuntimeDriver`（如何启动进程、解析事件流）。但现实里：

- 有团队**基于 opencode / claude-code 源码 fork** 定制了功能，编译出的二进制**改了名字**（不叫 `opencode` / `claude`），甚至**改了版本号方案**。
- 这些 fork **仍遵循同一套协议**（opencode 味：`run --agent --format json` + `OPENCODE_CONFIG_CONTENT`；claude 味：`-p --output-format stream-json` + system-prompt / stdin），所以**框架完全有能力驱动它们**——缺的只是「把这个二进制登记进来、告诉框架它说哪种协议」。
- RFC-111 把运行时硬编码成 2 个枚举值，无法纳入这些自定义二进制。

**核心洞察**：把 RFC-111 的「运行时」拆成两层——
- **协议（protocol / flavor）= 驱动**：`opencode` 味 / `claude-code` 味（即 RFC-111 的 `RuntimeDriver`，**不变，仍是 2 个**）。
- **运行时实例（runtime）= 命名 + 二进制 + 协议**：一个注册的、有名字的、指向某个二进制、声明遵循某协议的条目。RFC-111 的两个固定运行时就是两条**内置实例**：`opencode`=(opencode 协议, 默认二进制) / `claude-code`=(claude 协议, 默认二进制)。自定义 fork = 新增实例。

## 2. 目标 / 非目标

### 目标

1. **运行时注册表**（D1，用户答）：新增 `runtimes` 表存命名实例 `{name, protocol('opencode'|'claude-code'), binaryPath}`；内置 `opencode` / `claude-code` 为**只读种子**（RFC-104 式 `builtin` 锁）。
2. **自定义运行时纳管**：管理员可注册新运行时——给定名字 + 协议 + 二进制路径，框架按该协议**驱动**它。
3. **深度冒烟符合性探测**（D2，用户答——fork 版本号可能被改、不可探版本）：注册 / 按需「测试」时，框架用该协议的驱动对给定二进制跑一次**最小真实调用**，验证它按协议吐出可解析的 stream-json 事件流（捕获到 session id、干净退出、可选信封），符合才纳管；**不依赖 `--version`**。
4. **默认 + 覆盖**（用户答）：`config.defaultRuntime` 配全局默认运行时（任一已注册实例，默认 `opencode`）；`agents.runtime` 每 agent 覆盖（任一已注册实例）。二者从枚举推广为**引用运行时名**——存量 `'opencode'`/`'claude-code'` 正好等于内置名 → **零数据迁移**。
5. **仅管理员管理、全员可选用**（D3，用户答）：运行时是机器级配置（含本机二进制路径），仅 admin 增删改；所有用户在 agent / 设置里可选用。不引入 per-user owner/visibility。
6. **运行时管理 UI**（取代 RFC-111 两张堆叠状态卡的「丑」）：设置页运行时改为**列表式**——每行一个运行时（名称 + 协议 + 冒烟状态 + 二进制 + 操作），内置只读、自定义可增删改 + 一键冒烟；agent 表单运行时选择器列出全部已注册运行时。
7. 全程随改动带测试（用 mock-opencode / mock-claude 做确定性冒烟，CI 不依赖真二进制 / 真额度）。

### 非目标

- **不改 opencode daemon 启动硬门**：RFC-111 的「启动时探测 canonical opencode 版本、过低则拒启」对**内置 opencode 的默认二进制**保留不变（那是「平台底座是否就绪」，与注册表的 fork 符合性是两回事）。
- **不做自动协议探测**：注册时**由管理员声明协议**（他清楚自己的 fork 基于谁）；不猜（一个二进制可能同时响应两种 --version，猜测不可靠）。
- **不做 per-runtime ACL**（owner/visibility）——管理员模型（D3）。
- **不改两个 `RuntimeDriver` 的协议实现**（opencode/claude 怎么驱动）——RFC-111 已定，本 RFC 只是让它们能指向任意二进制。
- **不引入第三种协议**——只有 opencode 味 / claude 味两种；自定义运行时必属其一。
- **不做运行时级的 model 命名空间定制**——claude 协议的 fork 沿用 claude 模型命名空间，opencode 协议的沿用 opencode。

## 3. 用户故事

- **US-1（纳管定制 fork）**：作为管理员，我把基于 opencode 定制、编译出的 `/usr/local/bin/my-oc` 二进制注册为运行时 `my-oc`（协议=opencode）；框架冒烟验证它按 opencode 协议吐事件 → 纳管成功。此后 agent 可选 `my-oc` 运行时跑，框架用 opencode 驱动 + 该二进制。
- **US-2（配默认 + 覆盖）**：我在设置里把默认运行时设为 `my-oc`，此后未显式指定的 agent 都用它；个别 agent 仍可覆盖回 `opencode` 或选 `claude-code`。
- **US-3（符合性把关）**：我注册一个路径写错 / 不符合协议的二进制，冒烟失败并给出原因（无可解析事件 / 非零退出 / 无 session id），不纳管 / 标记不符合，避免 agent 选到一个跑不通的运行时。
- **US-4（清爽管理界面）**：设置页运行时区是一个列表——内置 opencode/claude 两行（只读）+ 我加的自定义行，每行显示协议、冒烟状态点、二进制路径，可「测试」「编辑」「删除」（仅自定义），不再是两张大卡纵向堆叠。
- **US-5（混用）**：同一工作流里，设计者 agent 用 `claude-code`、审计者用 `my-oc`、修复者用 `opencode`，各按对应协议 + 二进制跑。

## 4. 验收标准

1. **注册表**：`runtimes` 表（migration）+ 内置 opencode/claude 种子（`builtin=1`，只读：禁删 / 禁改名 / 禁改协议；RFC-104 式守卫）；`name` 唯一。
2. **resolveRuntime 推广**：`agent.runtime ?? config.defaultRuntime ?? 'opencode'` 解析为**运行时名**→ 查注册表 → `(protocol, binaryPath)`；未知名 fail-safe 回内置 opencode（+ warn）。纯函数 + 单测。
3. **驱动接线**：runner 按解析出的 `protocol` 选 `getRuntimeDriver(protocol)`，按 `binaryPath`（空→协议默认：opencode=config.opencodePath/PATH，claude=config.claudeCodePath/PATH）作 spawn head。opencode/claude 内置路径行为**与 RFC-111 逐字不变**。
4. **冻结（D15 推广，Codex P1）**：`node_runs.runtime` 冻结 **protocol**（RFC-111 不变）+ 新 `node_runs.runtime_binary` 冻结 **binary 快照**；resume 自洽（驱动=冻结 protocol、head=冻结 binary ?? 协议默认，**不查注册表**）→ runtime 删/改名/改 binary 都不影响已冻结 run、session 零错配。删除守卫只扫当前引用（agents.runtime + config.defaultRuntime）。
5. **深度冒烟**：`POST /api/runtimes/probe { protocol, binaryPath }` 用该协议驱动跑最小真实调用，返回 `{ conforms, detail, capturedSessionId?, sawEnvelope? }`；mock 二进制确定性通过；坏路径 / 非协议输出 → conforms=false + 原因。**不解析版本**。
6. **CRUD + ACL**：`GET/POST/PUT/DELETE /api/runtimes` 仅 admin 写（`requireAdmin`）、全员可读；内置只读守卫；删除被任何 agent / config.defaultRuntime 引用的运行时 → 阻断（或改引用前置）。
7. **前端列表**：设置页运行时列表（内置 + 自定义，冒烟状态点，增删改 + 测试，仅自定义可改）；agent 表单运行时选择器列全部已注册运行时；i18n 中英对称；公共组件优先（复用 Select / 列表行 / StatusChip）。
8. **门禁**：typecheck×3 + 全量 backend bun test + 前端 vitest + format + binary smoke 全绿；Codex 设计 gate + 实现 gate fold。

## 5. 决策登记

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| **D1** | 运行时模型 | **命名注册表 `runtimes` 表**（用户答） | agent.runtime 从枚举推广为引用运行时名；内置只读种子；自定义注册一次复用、探测可缓存。存量值=内置名→零数据迁移。 |
| **D2** | 符合性探测 | **深度冒烟、不探版本**（用户答：fork 版本号可能被改、不可靠） | 注册/测试时用协议驱动跑最小真实调用，验证按协议吐可解析事件流（session id + 干净退出 + 可选信封）。比 `--version` 对 fork 可靠。 |
| **D3** | 管理权限 | **仅管理员、全员可选用**（用户答） | 运行时含本机二进制路径=机器级配置，admin 管理；不引入 per-user ACL（路径跨用户可见性无意义）。 |
| **D4** | 默认 + 覆盖 | `config.defaultRuntime`（全局默认运行时名）+ `agents.runtime`（每 agent 覆盖名）（用户答「可配置默认、agent 可自定义」） | RFC-111 D1 模型推广到注册表：两者皆引用运行时名、从注册表选。 |
| **D5** | 协议来源 | **注册时管理员声明协议**（opencode|claude-code），不自动探测 | 一个二进制可能同时响应两种 --version；声明可靠、零歧义。 |
| **D6** | 内置运行时身份 | opencode/claude 为 `builtin=1` 只读种子；其 `binaryPath` 为空时回退 `config.opencodePath`/`claudeCodePath`/PATH（RFC-111 行为不变） | 不破坏 RFC-111 的默认二进制解析；内置不可删/改名/改协议（RFC-104 式）。 |
| **D7** | 冒烟成本 | 按需（注册 + 显式「测试」按钮）触发，非每次列表刷新；用最便宜模型 + 极短超时 + trivial prompt | 冒烟是真模型调用（admin 动作可接受）；不在每次 UI 刷新打模型。 |
| **D8** | 版本展示 | 注册表 UI **不展示版本**（D2）；冒烟状态点（符合/不符合/未测）替代 RFC-111 的版本状态卡 | 版本对 fork 无意义；符合性才是「能不能用」的信号。 |
| **D9** | RFC-111 兼容 | `/api/runtime/{opencode,claude}` + 版本状态卡由本 RFC **超集替代**（迁移到 `/api/runtimes` + 列表）；daemon 启动 opencode 版本硬门保留 | 统一到注册表；RFC-111 的 UI/probe 路由收编。 |

## 6. 影响面概览

- **DB**：新 `runtimes` 表（migration）+ 内置种子；`agents.runtime` / `config.defaultRuntime` 语义从枚举→运行时名（列不变、值兼容）。
- **后端**：`services/runtimeRegistry.ts`（CRUD + 内置守卫 + 解析名→(protocol,binary)）+ 冒烟探测器（复用 driver + 轻量 runNode 冒烟）；`resolveRuntime`/`resolveFrozenRuntime` 推广；runner 按 binaryPath 作 head；路由 `/api/runtimes*`；启动 seed。
- **前端**：设置页运行时**列表**（取代两张堆叠卡）+ 注册/编辑对话框 + 冒烟状态；agent 表单运行时选择器列全部注册项；i18n。
- **测试**：注册表 CRUD + 内置守卫 + 解析 + 冒烟（mock 二进制确定性）+ 前端列表 + e2e。

详见 `design.md` 与 `plan.md`。

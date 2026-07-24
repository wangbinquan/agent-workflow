# RFC-135 · 首页多运行时状态行（替换硬编码 opencode 探针）

状态：Draft（待用户批准）
触发：2026-07-02 用户「现在系统已经切换了多运行时，但是首页上还硬编码了 opencode 的就绪状态」。

> **后续修订（RFC-226，2026-07-24）**：OpenCode 的显式 status 仍会执行 probe，但
> `ok` 必须同时满足 binary 可运行且版本/构建兼容；旧版或不可解析版本不得显示为 ready。
> Claude Code 保留本文既有 status 可用性语义。

## 背景

RFC-112/113/118 已把系统切换为**运行时注册表**模型：`runtimes` 表承载 opencode /
claude-code 两个内置行 + 任意自定义 fork（每行含 `binaryPath` / `enabled` / 执行
profile），`config.defaultRuntime` 指定全局默认，Settings → Runtime 页整体由
`RuntimeList`（`GET /api/runtimes`）接管。

但首页 hero 的状态行（`HomepageGreeting.tsx`）仍停留在 RFC-032 时代：

- 它是全仓**唯一**还在消费单运行时探针 `GET /api/runtime/opencode` 的活代码
  （60s 轮询），文案硬编码「opencode v{{version}} · 已就绪 / 未找到 opencode」。
- `RuntimeStatusCard.tsx`（旧 Settings 卡片、`/api/runtime/claude` 的唯一消费方）
  已被 `RuntimeList` 替换，现为**零引用死代码**。

由此产生三个真实问题：

1. **信息盲区**：claude-code 或自定义 fork 坏了（缺失 / 版本过低），首页看不出来；
   反之只装 claude 栈的用户会被「未找到 opencode」误导。
2. **默认运行时错位**：`defaultRuntime` 切到 claude-code 后，首页仍只报 opencode
   的状态，与实际调度所用运行时脱节。
3. **binaryPath 不感知**：旧探针只读全局 `config.opencodePath`，注册表行上配置的
   自定义二进制路径（真实调度会用它）不参与首页状态。

## 目标

- 首页状态行如实反映**注册表中 enabled 运行时**的当前就绪状态（实时轻量探测，
  感知每行 `binaryPath`）。
- 视觉语义沿袭 RFC-111 D10 的软硬区分并泛化到注册表世界（见 design D3）。
- 顺带清理单运行时探针遗留面：死组件、两个旧端点、shared 旧 schema。

## 非目标

- 不动深度 smoke 体系（`lastProbe` / `POST /api/runtimes/*/probe`）及 Settings 页。
- 不做状态推送（保持轮询节奏不变）。
- 不改调度 / 运行时解析逻辑（`resolveRuntimeByName` 等零改动）。
- 不给 Onboarding 首跑页新增运行时状态（其当前无此元素）。

## 用户故事

1. 我同时启用 opencode 与 claude-code：打开首页，一眼看到两个运行时各自的状态点
   与版本号；其中一个坏了能直接看出是哪个。
2. 我把默认运行时切到 claude-code 且机器上没装它：首页红点点名 claude-code——
   而不是继续报「opencode 已就绪」。
3. 我只用 opencode（开箱状态，内置 claude-code 行 enabled 但机器未装 claude）：
   首页不因 claude 缺失而常驻红点（非默认缺失 = 灰点弱提示，符合 RFC-111 D10 的
   「可选运行时缺失不是故障」）。
4. 我给 opencode 行配了自定义 fork 的 binaryPath：首页状态反映的是**那个二进制**
   能否运行及其版本串，而非 PATH 上的官方 opencode；fork 自带的非标准版本号
   **不会**被拿去和官方最低门槛比较而误报故障。
5. 我把用不到的运行时 disable 掉：它从首页状态行消失（与 picker 行为一致）。

## 验收标准

- AC-1 首页 hero 逐个显示 enabled 运行时（状态点 + 名称 + 版本 / 错误短语），
  数据来自新的轻量聚合端点，探测按行解析 binary（与 `POST /api/runtimes/:name/probe`
  同一解析规则）。
- AC-2 颜色语义：就绪（`--version` 有输出）= 绿；**默认运行时缺失** = 红；
  非默认运行时缺失 = 灰（muted 文案）。探测中 = 现有 checking 灰点。
  **可用性不比较版本号**（用户拍板 2026-07-02：已有自定义二进制版本体系与
  官方门槛不可比导致的误报案例）——不存在「版本不兼容」状态。
- AC-3 enabled 运行时 > 3 时收敛为「{ok}/{total} 个运行时就绪」聚合文案并点名
  **最坏 severity** 的异常项（fault 优先于 soft，同级取列表序第一；design D1）；
  enabled 为空（全被 disable）显示「无已启用的运行时」空态。三种形态均整行
  链接到 `/settings#runtime`（现状保持）。
- AC-4 `RuntimeStatusCard.tsx`、`GET /api/runtime/opencode`、`GET /api/runtime/claude`
  及 shared 的 `RuntimeOpencodeStatusSchema` / `RuntimeClaudeStatusSchema` 删除；
  `GET /api/runtime/models` 与 `probeOpencode` / `probeClaudeCode` util（daemon 启动
  探测仍用）不受影响；相关测试与 contracts 注册表同步更新。
- AC-5 前端源码不再出现 `/api/runtime/opencode` 字面量（源码层文本断言兜底）。
- AC-6 门禁全绿：`bun run typecheck && bun run test && bun run format:check` +
  前端 vitest + 单二进制 build smoke。

## 决策记录

- 展示形态三选一（逐个显示 / 仅默认运行时 / 聚合计数）曾以 AskUserQuestion 询问，
  用户暂未答复；本 RFC 按推荐方案「逐个显示 + >3 收敛」落档，**批准时可改**——
  改动只影响前端 `describeRuntimes` 纯函数与 i18n 文案，后端契约不变。
- **2026-07-02 用户批准实现**，并追加拍板：**可用性判定不比较版本号**——已发现
  一例自定义二进制因自带版本体系与官方最低门槛不可比而探测误报；判定收敛为
  「`--version` 能跑出输出即可用」。契约随之去掉 `compatible` / `minVersion`，
  「版本不兼容」状态删除；daemon 启动的最低版本门槛是另一码事，不在本 RFC 动。

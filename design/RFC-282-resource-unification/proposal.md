# RFC-282 · 资源归一：装配单点化、runtime 围栏化、抽象去重化

- 状态：Draft（待用户批准）
- 日期：2026-08-11
- 发起：用户指令「开始做资源归一处理，并且加好充分的防护防止以后再多份实现分支」。
  起于一次全仓调研（四路并行核实，结论见 §1），问题是「资源注入、资源执行、资源抽象
  是不是已经全系统抽象成一套，并且没有特殊处理」。答案是：**执行层是**（RFC-280 已收
  敛到唯一执行器），**注入层是半套**（转换纯函数收敛了，装配没有），**抽象层是大半套**
  （ACL 统一了，引用收敛只完成一半），**「没有特殊处理」不成立**。
- 决策记录（用户已逐条拍板，2026-08-11，共 18 条）：见 §9。
- 相关设计：RFC-280（统一 agent 进程执行与资源注入收拢 —— 本 RFC 是它的直接接续，
  完成它没走完的装配层收敛）、RFC-281（任务工作区边界 —— 其 `workspaceBoundary.ts`
  在本 RFC 中按 runtime 归属拆分）、RFC-271（统一资源表达 —— 其 ref codec 的三个域
  在本 RFC 中真正接上生产）、RFC-099/231（资源 ACL 模型 —— 其
  `canViewResourceInTx` 的四份手写副本在本 RFC 中收敛）、RFC-243（任务调用层，正交）。

## 0. 首要原则（高于本文档其余一切细节）

**功能不受影响 > 归一的彻底程度。**（用户 2026-08-11 明确追加为完工判据之一）

这是一次**纯结构性重构**：它不应该改变任何一个业务节点的实际运行结果。凡在「更干净的
结构」与「可能动到运行行为」之间需要取舍时，一律选前者让步。具体兑现为三条硬规矩：

1. **每批都走对拍**（用户拍板）：任何换掉装配路径的批次，必须先写新旧双实现对拍测试
   证明产出等价，再在同一 PR 内删除旧实现。不允许「改完跑跑既有测试没红就算过」。
2. **有意变更必须逐条登记**：唯一允许的行为差异是 design §7 的「有意变更清单」，每条
   指定 owning 任务、改哪条断言、在 commit message 里声明。清单外的任何 argv/env/
   落库形状变化都是 bug。
3. **不借重构之名改产品语义**：本 RFC 只有一处产品行为变更（disabled 语义统一，§7），
   它是用户单独拍板的，不搭在结构改动里夹带。

## 1. 背景：调研结论（四路并行核实，全部 file:line 可复核）

### 1.1 资源执行 —— 已经是一套 ✅

全仓能起子进程的 18 个调用点中，**agent 进程只有一个 spawn 点**
（`services/execution/managedProcess.ts:245`）。五条链路（业务 runner / 系统 agent /
MCP 测试台 / 冒烟探针 / 记忆蒸馏器）加 intent turn 引擎、change-narrative 共 7 个消费方
全部经 `runAgentProcess`（`services/execution/agentProcess.ts`），后者是纯 adapter，零
自建计时器与 kill 链。这一层 RFC-280 已经做完，**本 RFC 不动它**。

（残留两小处并入本 RFC 顺带清理：`runner.ts` 的 `pumpLines`/`LinePump` 死代码第二实现
仅被 `tests/runner-stream-bounds.test.ts` 钉住、且与 managedProcess 的 `pump()` 已在截断
标记文案上分叉；`FINAL_REAP_MARGIN_MS` 常量双写。）

### 1.2 资源注入 —— 转换收敛了，装配没有 ⚠️

RFC-280 把「DB 形状 → 注入意图」的核心纯函数收敛到了
`services/execution/agentInjection.ts` 单点（MCP wire、agent 条目、claude subagent 条目
各一个实现；skill 拷贝唯一实现在 `runtime/stageSkills.ts`）。**这一半是真的**。

但**装配层仍是多路各拼**：

1. **`renderInjection` 名不副实**。它的生产调用者只有 `runner.ts:946`（取 `.declared`）
   与测试台（`mcpRuntimeTest.ts:2531/:2646`）。两条业务 spawn 路径**绕开它**——opencode
   走 `buildInlineConfig`（`opencode/driver.ts:226`）、claude 在 `claudeCode/driver.ts:282`
   直调，各自**再调一次**同样的纯函数。即「声明清单」与「实际注入」是**两次独立计算**，
   靠「同输入 + 同纯函数」保证一致，而非构造上同源。今天安全，结构上随时可分叉。
2. **driver 上有三个装配入口**：`buildSpawn`（系统 persona）、`buildBusinessSpawn`
   （业务全量）、`renderInjection`（声明面）。前两个各自内部组合，第三个旁挂。
3. **解析层不在统一层**：`prepareNodeRunInjection`（`scheduler.ts:9137-9330`，约 200 行，
   含资源解析 + exact-identity 围栏 + skill quarantine 门）留在 scheduler，且 skill /
   mcp / plugin 三段近似重复而语义各异（skill 有 quarantine 与 canonical-path 门且是
   throw 风格，其余是 typed result）。
4. **disabled 语义分裂**：引用 disabled plugin → 节点硬失败（`scheduler.ts:9262`
   `plugin-disabled`）；引用 disabled MCP → 静默跳过 + 声明告警
   （`agentInjection.ts:84-86`，RFC-280 拍板的落差③）。两条规则活在两层，没有单点能
   读出「disabled 资源怎么办」。
5. **6 个调度入口有 2 个绕开统一注入**：commit-push（`scheduler.ts:1960-1965`）与
   merge agent（`:2850-2853`）手写 `skills:[] dependents:[] mcps:[] plugins:[]`。今天等价
   （两个合成 agent 定义处本就零资源），但**给内置 agent 加一条 MCP 引用就会被静默丢弃**。
6. **driver 内约 10 处重复实现**：memory 块织入两份（`opencode/driver.ts:261-266` vs
   `claudeCode/driver.ts:208-211`）；claude mcp-config 落盘两份（`:56-64` vs `:167-175`，
   后者带 `mode:0o700` 前者不带）；plugin enabled 过滤三到四份；`declareSkills` 的
   managed 谓词内联重复 4 处；**plugin 去重键分裂**（`declarePlugins` 按 name、
   `selectShippedPlugins` 按 id ⇒ 同名异 id 时注入 2 个声明 1 个，启动验证漏判）；
   **subagent root 排除不对称**（`declareSubagents` 排除 root、
   `renderClaudeSubagentEntries` 不排除 ⇒ 注入却不声明）；`toClaudeMcpConfig`
   （`inject.ts:28`）已是 src 内死代码。

### 1.3 runtime 抽象 —— 分支清零了，泄漏没清 ⚠️

值得肯定的事实：**scheduler / runner / execution 三处的 runtime 字面量分支为零**，全部
改成了 driver 能力探测；这三个目录加 `services/runtime/` 的 TODO/FIXME/HACK 也是**真零**。

但：

1. **`opencodeCmd` 贯穿 12 个入口文件**：`resolveOpencodeCmd` 被 12 个路由/服务直接
   import → `RunTaskOptions.opencodeCmd`（`scheduler.ts:304-305`）→ 6 个 runNode 入口 →
   `runner.ts:296,904` → `runtime/types.ts:456`。该字段注释自认
   「opencode-ONLY … Other drivers MUST ignore it」。平行的通用 `runtimeCmd` 存在但
   scheduler 一处都不传 ⇒ claude 无法经 scheduler 路径注入 mock 二进制。
2. **能力探测当 runtime 判据**：`runner.ts:1828` 的变量名就叫 `opencodeHasNoObservation`，
   判据是 `driver.readInventory !== undefined`；`:1836-1838` 是事实上的
   if-opencode-else-claude，**第三个 runtime 会掉进 claude 分支**。同一判据在
   `mcpRuntimeTest.ts:2570` 有第二份拷贝。
3. **未知 runtime 静默兜底成 opencode**：`runtime/index.ts:26` 的
   `DRIVERS[kind] ?? opencodeDriver` —— 损坏或未来的 runtime 值会被静默当 opencode 跑，
   与 `nodeRunMint.ts:486` 那条路径的 loud-log 策略不一致。
4. **约 1300 行 opencode 专属实现在 driver 目录外**：`services/sessionCapture.ts`（431 行，
   含硬编码的 opencode 全局 SQLite 路径）、`subagentLiveCapture.ts`（297）、
   `inventory.ts`（255）、`distillSessionCapture.ts`（146）、`util/opencode.ts`（167）、
   `util/opencode-version-registry.ts`（45）、`src/opencode-plugin/` 整目录。claude 的
   同类物全部在 `runtime/claudeCode/` 内 ⇒ 物理围栏不对称，`runtime/types.ts:28` 与
   `runner.ts:90` 还反向依赖 opencode-only 模块。
5. **RFC-281 的 `services/execution/workspaceBoundary.ts`** 同时装着 opencode 的
   `external_directory` 键序合成与 claude 的 sandbox settings 合成，位置在统一层 ——
   是「per-runtime 逻辑住在统一层」的活例。

### 1.4 资源抽象 —— ACL 是真统一，引用收敛半途而废 ⚠️

真统一的：六类资源（agent/skill/mcp/plugin/workflow/workgroup）共用
`owner_user_id + visibility + resource_grants`，`resource_grants` 全仓唯一写入点
（`resourceAcl.ts:579`）；list / detail / create / ACL 端点四个面全部复用同一批助手；
create 统一 owner + private + 零 grants；加第七类资源会在穷尽映射处编译报错。

漂移：

1. **`canViewResourceInTx` 四份手写副本**：`agent.ts:838`、`workflow.ts:1006`、
   `workgroups.ts:856`、`scheduledTasks.ts:389`。其中 workflow / workgroups 两份**与同
   文件已 import 的共享版并存**；scheduledTasks 那份**直接遮蔽同名导出**且只支持 3/6
   类型。四份都写严格的 `row.visibility === 'public'`，共享版写宽松的
   `(row.visibility ?? 'public')` —— 今天结果相同（列 NOT NULL），契约不同。
2. **`services/importRefs.ts` 是引用校验的第二个入口**：自带 grant 查询（`:445-447`，
   与 `resourceAcl.ts:151-161` 同一条 SQL 两份代码）、自带可见性与歧义围栏。
3. **RFC-271 的 ref codec 三域纸面化**：`call` / `importSelector` / `intent` 三个 codec
   **零生产采用** —— `freezeCallClosure` 全程裸字符串（`execution/closure.ts:240/247/
   284-290/357/380/401-402`），`RefResolver` 接口零实现；`agentRefs.ts:22-24` 还残留被
   RFC-271 点名批判过的 `m:`/`p:` 前缀键第二份。尤其 `call` 域正是 RFC-271 自述的动机例。
4. **`resolveRefsUsableByName` 缺 `grandfatheredIds` 参数**：name 域（call-workflow /
   call-workgroup）的「只校验新增引用」全靠调用方自觉先 diff，少写一次就静默丢失
   grandfathering，类型层面零信号。且 `RefCheckGroup.domain` 默认 `'id'`
   （`resourceRefs.ts:113`）⇒ 调用方给了 name token 却忘标 domain 会**静默通过**。

## 2. 目标

1. **装配单点化**：driver 上只剩**一个**装配方法；`DeclaredManifest` 作为其返回值的
   一部分产出，使「声明 = 注入的副产品」成为结构事实而非约定。资源解析与围栏从
   scheduler 搬进统一层，6 个调度入口全部经它。
2. **runtime 围栏化**：per-runtime 代码只在 `services/runtime/{opencode,claudeCode}/` 内，
   外部只能经 `runtime/index.ts` 与 `runtime/types.ts` 访问；二进制解析下沉给 driver，
   调用链上不再有任何 runtime 专属参数。
3. **抽象去重化**：每类资源的转换、每个 ACL 判据、每个域的 ref 编解码各只有一个实现。
4. **防护制度化**：四道机器可校验的守卫（源码 grep 锁 / ESLint import 边界 / 启动期
   自检 / 类型层收口），使「再长出第二份实现」在提交前就被挡住，而不是靠 code review
   的人眼与记性。

## 3. 非目标

- 不动 RFC-280 已收敛的进程执行层（`managedProcess` / `agentProcess` 契约不变）。
- 不动 RFC-243 的任务调用层。
- 不回退 RFC-276 立场（不新增二进制身份门 / 私有 HOME / 网络围栏 / OS sandbox）。
- 不改 RFC-281 的边界**语义**（只改它的代码归属：runtime 专属合成下沉到各 driver）。
- 不新增跨 runtime 的能力，不填补能力缺口（缺口只做显式化，沿用 RFC-280 立场）。
- 不改变六类资源的 ACL 模型本身（只消除其判据的重复实现）。
- **不统一 RFC-280 射程外的工具类子进程**（`--version` 探针 ×3 / git ×2 / npm 安装 /
  SCIP indexer / MCP 探针的 SDK stdio 子进程）—— 它们不是 agent 链路，各自的手抄
  kill 骨架另行处理（登记进 `docs/audit-backlog.md`）。

## 4. 用户故事

1. **平台开发者新增第三个 runtime**：只需在 `services/runtime/<name>/` 下实现一个
   driver（单一装配方法 + 声明面表态），注册进 DRIVERS。不需要改任何路由、scheduler、
   runner；启动自检会告诉他哪个声明面还没表态；ESLint 会在他不小心把 runtime 专属
   代码写到 driver 目录外时当场报错。
2. **平台开发者新增一类资源注入**：只改统一注入层的一个转换纯函数 + 每个 driver 的
   渲染表态，五条 spawn 链路同时生效，声明清单与启动验证自动覆盖。grep 锁会挡住
   「顺手在 driver 里再写一份」。
3. **工作流作者临时禁用一个 plugin**：引用它的节点**照常运行**并在节点详情看到持久
   告警「plugin X 已禁用，本次运行缺少它提供的能力」，而不是像今天这样整个节点直接
   失败。（行为变更，§7）
4. **运维者排查「agent 找不到工具」**：节点详情的声明清单与实际加载对照表来自**同一次
   装配**，不存在「声明说注入了、实际没注入」这种两次计算的不一致可能。
5. **接手者读代码**：想知道「disabled 资源怎么处理」「哪些目录算本任务工作区」「某类
   资源怎么从 DB 行变成 wire 形状」，各只有一处可读，不需要在 scheduler / driver /
   统一层之间来回对照。

## 5. 能力影响清单（CLAUDE.md §7 要求：呈用户逐项确认）

本 RFC **不以安全/隔离为由关闭任何既有能力**，故不属「能力收缩型 RFC」。但为完整起见
逐项列出所有可观察的能力变化：

| # | 变化 | 方向 | 影响面 |
|---|------|------|--------|
| 1 | 引用 disabled plugin 从「节点硬失败」变为「照常运行 + 持久告警」 | **能力扩张** | 引用了被禁用 plugin 的工作流节点：原本跑不了，现在能跑 |
| 2 | `plugin-disabled` 错误码删除 | 内部 | 该码不再产生；对外 wire 无契约（节点失败原因是自由文本） |
| 3 | 系统 agent（intent / narrative / smoke / distiller）的 inline 条目多出 description/permission/options 字段 | 等价 | runtime 语义不变（RFC-280 §7.2 已对 opencode 系统面做过同类变更） |
| 4 | 调用方不再传 `opencodeCmd` | 内部 | 纯内部字段（shared / frontend 零命中）；二进制解析结果不变 |

**无能力收缩项。** 若实现期发现任何一处会关闭既有能力，按 CLAUDE.md §7 停下来单独呈报。

## 6. 与相邻 RFC 的边界

- **RFC-280**：本 RFC 是它的直接接续。它交付了「转换纯函数唯一 + 进程执行器唯一 +
  启动验证层」，没走完的是「装配路径唯一」。本 RFC 不推翻它的任何结论，只完成收敛。
- **RFC-281**：其边界**语义**（deny 基线 + W(run) 白名单 + 作者白名单跨 runtime 兑现）
  一字不改；只把 `workspaceBoundary.ts` 里两个 runtime 的**专属合成**下沉到各自 driver，
  runtime 无关部分（`BoundaryCtx` / `resolveBoundaryMounts` / 「哪些目录算本任务工作区」）
  留在统一层。RFC-281 的全部行为锁测试必须不改断言通过。
- **RFC-271**：本 RFC 兑现它「每域一个 codec」的承诺 —— 把 call / importSelector /
  intent 三域接上生产代码。
- **RFC-099/231**：ACL 模型不变，只消除 `canViewResourceInTx` 的四份副本。

## 7. 行为变更声明（呈用户确认）

**一处产品行为变更**（用户已单独拍板）：

1. **disabled 资源语义统一为「告警不失败」**。引用 disabled plugin 的节点从「spawn 前
   硬失败（`plugin-disabled`）」变为「照常运行 + `startup_verification_json` 持久告警 +
   节点详情 banner」，与 disabled MCP 今天的语义一致（RFC-280 落差③）。
   **不提供逃生舱**（用户拍板）：不新增 `requireResources` 之类的「缺了就别跑」声明；
   如果作者需要硬依赖语义，那是未来单独 RFC 的题目。
   规则本身收进统一层的**单一 disabled 规则表**，新增资源类型必须在表里表态。

**三处等价变更**（结构收敛的副产品，逐条进 design §7 有意变更清单并给 golden 归属表）：

2. 系统 agent inline 条目统一产出（多出 description/permission/options 字段）。
3. `opencodeCmd` 从调用链剔除（二进制解析下沉给 driver，保留 test-only override 通道）。
4. `workspaceBoundary` 的 runtime 专属合成下沉到各 driver（产出字节不变，位置变）。

## 8. 验收标准

**归一（机器可校验）**：

1. **ESLint 例外清单归零** —— 第一批建立的存量违规清单逐条清空。
2. **每类资源转换唯一实现** —— 源码层 grep 锁断言：MCP / agent 条目 / subagent /
   skill / plugin / permission / memory / boundary 八类，每类的转换函数只有一个定义点，
   且调用点在白名单内。
3. **driver 接口只剩单一装配方法** —— `RuntimeDriver` 上不再存在
   `buildSpawn` / `buildBusinessSpawn` / `renderInjection` 三份（类型层即可核验）。
4. **启动自检：每个 driver 声明面完整** —— daemon boot 校验每个注册 driver 对
   `DeclaredManifest` 的全部面给出显式表态（支持 / 不支持 / 不可观测），缺面即拒绝启动。

**功能不受影响（用户追加，同等硬指标）**：

5. **每批对拍** —— 每个换装配路径的 PR 都包含新旧双实现对拍测试，证明产出等价后
   在同一 PR 内删旧实现。
6. **既有测试零改动通过**，唯一例外是 design §7 有意变更清单里逐条登记的断言，
   每条指定 owning 任务并在 commit message 声明。
7. **`bun run gate:local` 全绿 × 每个 PR**；推完按 exact SHA 查 CI。
8. RFC-280 / RFC-281 的全部行为锁测试不改断言通过。

**收敛项逐条兑现**：

9. `prepareNodeRunInjection` 在 `services/execution/` 下，6 个调度入口全部经它
   （含 commit-push 与 merge agent，资源从 agent 定义推导而非调用点写死）。
10. `canViewResourceInTx` 全仓一个实现；`importRefs` 的 grant 查询与可见性判据复用
    `resourceAcl` 单点。
11. RFC-271 的 call / importSelector / intent 三域 codec 有生产调用点（grep 锁兜底）。
12. 约 1300 行 opencode 专属实现全部在 `services/runtime/opencode/` 内。
13. `DRIVERS[kind]` 未知值显式报错；`readInventory !== undefined` 不再被用作 runtime
    判据；plugin 去重键统一；subagent root 排除语义对称。

## 9. 用户决策记录（2026-08-11，三轮共 18 条）

| # | 决策 | 取值 |
|---|------|------|
| 1 | 归一范围 | 三类全做，一个 RFC 分批 PR |
| 2 | 注入单点形态 | 彻底单点：声明与注入同源 |
| 3 | 防护形态 | 四件套全上：grep 锁 / ESLint 边界 / 启动自检 / 类型收口 |
| 4 | disabled 语义 | 统一为告警不失败 |
| 5 | 单点覆盖面 | 五条链路全走同一钩子（persona-only 是空集特例，不是例外） |
| 6 | 缺资源逃生舱 | 不给，纯告警 |
| 7 | opencode 专属代码 | 全搬进 `runtime/opencode/` |
| 8 | 解析层归位 | 搬进 execution 层 + 6 入口全走它 |
| 9 | driver 契约 | 三合一，`declared` 进 `SpawnPlan` |
| 10 | boundary 归属 | 拆：runtime 无关部分留统一层，合成下沉各 driver |
| 11 | 批次顺序 | 防护先行，再逐批收敛（例外清单归零 = 完工） |
| 12 | ref codec 三域 | 接上生产 |
| 13 | DRIVERS 兜底 | 改显式报错 |
| 14 | readInventory 判据 | 改显式能力声明 |
| 15 | plugin 去重键 / subagent root | 统一 |
| 16 | golden 锁 | 接受等价变化，逐条改断言 + 归属表 |
| 17 | 二进制解析 | 从调用链剔除，下沉给 driver |
| 18 | importRefs | 保留独立但共享底层 |
| 19 | 对拍验证 | **每批都对拍** |
| 20 | `plugin-disabled` 错误码 | 删除 + 写进行为变更声明 |
| 21 | 完工判据 | ESLint 清单归零 + 转换唯一（grep 锁）+ driver 单一装配方法 + 启动自检声明面完整 + **功能不受影响** |

# RFC-487 实施计划

**前置**：RFC-486（Done，`b69dfabe8`，修复 `6452036ac`，Done 文档 `f74014135`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。
全部实现与用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                      | 依据      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-487-T1 | memory：删除蒸馏运行时解析器；装配改收 `runtimeProfiles` 端口，bootstrap 用 runtime-management 的 `resolveInternalAgentRuntime` 绑定；用例与 helper 改用同一绑定；表归属债销这一条                        | design §2 |
| RFC-487-T2 | system-operations：端口增 `DoctorRuntimeBinaryProbe`，本机 doctor 改调注入的探测；runtime-management 增默认二进制探测（infrastructure + composition）；bootstrap 的 doctor 工厂与 standalone 软探测改用它 | design §2 |
| RFC-487-T3 | source-control：`resolveBoundaryMounts` 迁入 domain、经 `public/queries` 交出；本机工作区内容与 task-execution 的本机运行入口改取；一族删去原函数                                                         | design §2 |
| RFC-487-T4 | resource-catalog：`SkillSource`、`RuntimePlugin` 与 `NativeSkillContent` 迁入 domain、经 `public/types` 交出；一族的 `ResolvedSkill` 扩展它；材料引用改取自己的类型                                       | design §2 |
| RFC-487-T5 | 新增 RFC-487 用例并登记 guard-manifest；既有用例与账本按新位置改指；`counts.json` 收紧                                                                                                                    | design §4 |
| RFC-487-T6 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、架构报告对账、全仓旧路径扫描）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                       | design §5 |

## 验收清单

- [x] AC-1 memory、resource-catalog、source-control、system-operations 的生产文件不 import 运行时驱动一族（本机 MCP 诊断执行体的三条边
      钉住、另立）；memory 不读 `runtimes`，
      解析器删除，表归属债销这一条
- [x] AC-2 memory 蒸馏的运行时解析、doctor 探测、挂载列表与原生内容记录在同样输入下与此前一致
- [x] AC-3 越 DAG 的值边与 offered 文件对不升；public surface 只增本 RFC 声明的 4 个符号；减速带不升、触及的收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证（2026-11-12，候选基于 `829bc54f5`）

本机全程高负载（10 核；采样到的 1 分钟负载 46～126，主要是本机其他进程：Docker 虚拟机约 4.6 核、三个挂起的 bun 进程各约 0.9 核）。
验证在候选导出仓库里跑：HEAD 的树加候选路径，每次修复后重新同步，核对与工作树逐字相同。对照导出仓库与 HEAD 相同（`829bc54f5` 只改
文档）。验证期间 `origin/main` 未前进（一直是 `829bc54f5`）。

开发期按 RFC-482 的做法，用字面量扫描对 HEAD 与候选核过 `tsc` 看不到的源码文本断言。「HEAD 命中、候选不命中」的 103 条逐条核对，
都无害：

- doctor 与 standalone 不再 import `services/`，通用禁用清单里的 `services` 片段因此不再命中；
- 用例自己的 import 说明符；
- 另一个文件的反向断言；
- `managedProcess.ts` 路径里的 `execution` 段；
- `rfc281` 的 `resolveBoundaryMounts(` 仍在任务代理源码里命中；
- 本 RFC 用例自己的反向断言。

集中验证与实现门查出本 RFC 的五处问题，已修复并复验（1～4 见 design §6 细化 1～4）：

1. **用例 ① 漏算非目标**：本 RFC 用例断言 resource-catalog 全部生产文件零依赖，漏了 proposal 写明的非目标（本机 MCP 诊断执行体的
   三条边），首批即红。改为逐条钉住，AC-1 同步写明。
2. **public 交出带函数成员的类型**：含函数成员的 `ResolvedSkill` 整个交出 resource-catalog 的 `public/types`，首批即红：
   - `rfc294-architecture-preflight` 报未登记的函数类型偏差；
   - `rfc376-structural-guards` 的 `public-surface-deviations` 58 > 57。

   改为只交数据字段（`NativeSkillContent`），一族的 `ResolvedSkill` 扩展它。

3. **超集档案直接接给按字段转发的绑定**（实现门自审）：memory 的 `bindRuntime` 按固定字段表转发，runtime-management 的解析给的是
   全量档案。直接接上，蒸馏运行会带上已登记运行时的 `variant`、`temperature`、`steps` 等参数；这是行为变化，既有用例都不碰这些字段。
   改为 memory 在自己的边界投影回端口字段，用例 ② 钉住。
4. **Windows 路径过滤漏登记**（全仓旧路径扫描）：`windows-platform.yml` 的路径过滤逐个文件登记 doctor 一族。探测链换到新文件后，
   改动它们不会触发 Windows 运行。两份过滤都登记三个文件，用例 ③ 钉住。
5. **本 RFC 用例自身超过默认 5 秒**（按 CI 跑法跑文档批时查出）：④ 对每个名字都把全部生产文件（约 3,200 个）解析一遍，负载下一条
   8.7 秒。前几轮本地都给了 60 秒单条时限，所以没现形。改为先按文本筛出含该名字的文件再解析、文件文本只读一次，断言不变。

后三条教训记入 `docs/dev-gotchas.md`（第 5 条补进 RFC-403 那一条）。

- **静态**：
  - backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`，四个候选各跑一次）；
  - eslint `--max-warnings 0`：改动的 30 个 TS 文件无告警；promises 规则集：改动的 19 个源码文件无告警；
  - prettier 检查通过：改动的 TS、本 RFC 三件套与 `windows-platform.yml`。按仓库约定，`architecture/*.json` 不进 prettier，`STATE.md`
    等不跑 prettier。
- **RFC-487 用例**：
  - 候选上 11 / 11，⑤ 的两种 provider 另见 PostgreSQL 一节；
  - 对 HEAD 的代码，整个文件在加载处报错，因为它 import 了候选才有的 helper；
  - 候选 1 的结构段（①～④，7 条）另存副本对 HEAD 跑：红 6 条，负对照两边都绿。
- **首批**（候选 1，448 个文件：`tests/architecture/` 全部、本 RFC 改动的用例、读改动文件文本的用例）：440 个通过，其余 8 个：
  - 本 RFC 的问题 3 个：`rfc487`、`rfc294-architecture-preflight`、`rfc376-structural-guards`，即上面 1、2；
  - 导出仓库的原因 1 个：`rfc321-repository-publication-ratchet`，导出仓库没有真实历史（与 RFC-483～486 相同）；
  - 撞用例自带时限或内部等待的 4 个：`rfc376-report`、`rfc400`、`clarify-review-combination-scenarios`、`rfc370-execution-effect`。
- **修复批**（候选 2）：
  - `rfc487` 9 / 9；
  - `rfc376-structural-guards` 221 / 221；
  - `rfc294-architecture-preflight` 13 / 14：偏差那条通过，`module capability ownership…` 撞 180 秒；
  - rfc317 三个守卫账本用例 24 + 17 + 15 条全过。
- **全量 SQLite**（候选 2）：导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例
  自带时限的照旧，5 个 worker。2,929 个文件、2,914 个通过。其余 15 个都不归本 RFC：
  - 发布账本一条（`rfc321`），同首批。
  - 撞用例自带时限或内部等待的 14 个：
    - `rfc376-report` 的子进程在 300 秒处被杀；
    - `rfc400` 一条 30 秒；
    - `clarify-review-combination-scenarios` 一条 20 秒流程；
    - `rfc370-execution-effect` 的标记文件等待 10 秒；
    - `rfc167-dynamic-workflow-engine` 的 `settleTask` 5 秒；
    - `rfc363-task-workspace-process-recovery` 的检查点 30 秒，两条；
    - 其余 8 个是文件或单条的时限：`rfc300-webhook-workspace-cleanup-e2e`、`rfc354-nested-frames-closure`、`rfc363-workspace-content`、
      `rfc370-committed-architecture-source`、`epoch1-permission-text-backup` 与 `rfc395-*` 三个。
- **候选 3 复验**（修 3 之后）：投影只在 memory 蒸馏的解析路径上。复验以下文件的并集，共 556 个：
  - memory 蒸馏的全部用例；
  - 读 memory 装配或这两个 helper 的用例；
  - 经守护进程装配的用例；
  - 首批的 448 个文件。

  550 个通过；其余 6 个同上：`rfc321`，以及撞时限的 5 个（`rfc376-report`、`rfc400`、`clarify-review-combination-scenarios`、
  `rfc370-execution-effect` 的两条标记文件等待、`rfc294-architecture-preflight` 的 60 秒与 180 秒各一条）。

- **候选 4 复验**（修 4 之后）：
  - 读 guard-manifest 或 `windows-platform.yml` 的用例与 RFC-487 用例，33 个文件 342 条全过；
  - 其余读 `.github/workflows/` 的用例 20 个文件：237 条通过，6 条按环境跳过（opencode 真机集成与 soak）。
- **放宽时限的副本**（候选 4，4 个 worker）：只改时限常量；`rfc370-execution-effect` 照 RFC-482 另加标记文件的轮询兜底。范围是全量里
  撞时限的 14 个文件，加上两个全语料扫描（`rfc376-structural-guards`、`rfc294-architecture-preflight`），16 个副本 385 条全过。
- **PostgreSQL**（候选 4）：52 个文件接 PostgreSQL 跑：双引擎用例里 import 本 RFC 改过的 memory 蒸馏 helper 或 memory 装配的、
  runtime-management 内部代理解析的，加上 RFC-487 用例。两种 provider 同进程、`--randomize`、单条 60 秒，3 个 worker。
  - 1,002 条里 991 条通过（PostgreSQL 一侧 463 / 474）；RFC-487 用例 13 / 13，memory 蒸馏三个用例两边全过。
  - 11 条红都在 PostgreSQL 一侧，在三个调度用例文件里：`scheduler-clarify-inline` 5 条、`scheduler-rfc040-wrapper-await` 5 条、
    `scheduler-cross-clarify-dispatch` 1 条。都撞文件的 `setDefaultTimeout`（15 秒或 60 秒）；随后的 generation 围栏与
    `Connection closed` 是超时后 afterEach 拆库、后台写仍在跑的连带。
  - 三个文件经 helper 只取 `createSqliteMemoryDistillEnqueuer`（本 RFC 没改它），SQLite 一侧全过；只放宽文件时限的副本 37 条全过
    （PostgreSQL 一侧 18 条）。
- **架构报告**（`scripts/architecture-report.ts --gates`，候选 4 vs HEAD 的代码出的报告）：
  - 门通过；60 项实测与 `counts.json` 的 `max` 逐项相等，与对照逐项相同，无需收紧。其中越 DAG 的 offered 文件对 46、跨 context
    内部文件对 43、类型偏差 57、`module-layer` 1、application 直接副作用 2、legacy 横向文件 167、legacy 服务实现 48，各 context 的
    未消费 public 符号不变（合计 91）。
  - public surface 1,204 → 1,208：resource-catalog `public/types` 的 3 个数据类型、source-control `public/queries` 的
    `resolveBoundaryMounts`，各有生产消费方。
  - 后端生产文件 3,214 → 3,218：新增 5 个，删除 1 个。
  - 跨 context import 7,662 → 7,664，删 9 条、增 11 条，另有 5 条类型边改键（一族的 `RuntimePlugin` 改为转出 resource-catalog 的
    public）：
    - 删去的 9 条：memory 解析器的 4 条（`runtimes` 表、drizzle、持久化类型、`RUNTIME_KINDS`）；resource-catalog 材料引用指向一族
      类型的 2 条；source-control 与 task-execution 指向 `workspaceBoundary` 的 2 条；doctor 指向 `getRuntimeDriver` 的 1 条。
    - 增加的 11 条：一族指向 resource-catalog public 类型的 4 条（legacy → 模块 public，允许的形状）；runtime-management 的探测指向
      一族的 3 条；bootstrap 指向 runtime-management composition 的 2 条；doctor 指向自有端口的 1 条；task-execution 指向
      source-control public 的 1 条（DAG 内）。
  - 表归属债 fixture 121 → 120。
- **最终候选（候选 5）**：修 5 只改了 RFC-487 用例与它在 guard-manifest 里的行数，其余是文档（本 plan、`STATE.md` 与
  `docs/dev-gotchas.md`）。生产代码自候选 4 未变，架构报告与候选 4 之前的结果沿用。
  - 按 CI 的跑法（两种 provider 同进程、默认 5 秒、`--randomize`）跑 RFC-487 用例、读 guard-manifest 的用例与文档对账用例，
    37 个文件 358 条里 357 条通过。红的一条是 `rfc294-architecture-preflight` 的 `module capability ownership…` 撞 180 秒（同上；
    它只读生产源码，自候选 4 未变，候选 4 的放宽副本已通过）。RFC-487 用例最慢一条 3.1 秒（① 的四个 context 全量扫描）。
  - 导出仓库与 HEAD 加 39 个候选路径逐字相同（同步后逐个路径核对，0 处不符），临时副本已删。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能，结论 PASS。自审查出的一处行为偏移已修，见集中验证第 3 条。逐项比对：

- **memory 蒸馏的运行时解析**：
  - 旧解析器是 runtime-management `resolveInternalAgentRuntime` 的复制，两者规则相同：
    - 同一张 `runtimes` 表、同一个按名字的查询，都不按 `enabled` 过滤；
    - 同样的回落：内建协议名直接用；未知名字回落 opencode；已弃用的模型回到 opencode 加该模型。
  - `runtimeProfileOf` 原样映射 model、protocol 与 binaryPath，`isSandbox` 取 `=== true`。该列是非空布尔列，所以与旧值相同。
  - 经 bootstrap 的绑定之后，结果由 `distillRuntimeProfile` 投影回端口声明的字段：`protocol`、`binaryPath`、`model`、`isSandbox`，
    有观测身份时带上它。这与旧解析器交给 `bindRuntime` 的字段集相同。
  - 唯一可观察的差别是未知名字多一条警告日志（proposal §4）。
- **doctor 与 standalone 的探测**：
  - `probeRuntime` 改调注入的 `runtimeBinary.probe('opencode', { opencodePath })`。默认实现是
    `getRuntimeDriver(protocol).probe(driver.defaultBinary(config)[0]!)`，与此前 doctor 自己的调用逐字相同。
  - standalone 的软探测（`probe('claude-code', config)` 与 `minVersion('claude-code')`）同样只换了出处，日志字段不变。
- **挂载列表与原生内容类型**：
  - `resolveBoundaryMounts`、`SkillSource`、`RuntimePlugin` 逐字迁移。
  - `NativeSkillContent` 是旧 `ResolvedSkill` 去掉 `readContentVersion` 后的字段集；一族的 `ResolvedSkill` 扩展它，只加这一个成员。
  - 生产方（材料引用）与消费方（驱动的本机编译器）看到的形状不变。
- **装配**：
  - memory 的 `runtimeProfiles`、doctor 工厂的第三个参数都是必填，`tsc` 保证每个装配点都传了：bootstrap 两处，以及用例与 helper 各处。
  - 改动的装配点里没有经 `as never` / `as unknown as` 交入的依赖。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同时补 RFC-486 Done 文档提交的 CI）；实现与验证后再提交
`refactor(backend): RFC-487 运行时驱动一族的 DAG 外使用方改经各自的端口（RFC-294 §4.7 运行时驱动一族第一步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。删除或搬迁文件后按 `git ls-files` 扫全仓的旧路径（RFC-486 教训）。

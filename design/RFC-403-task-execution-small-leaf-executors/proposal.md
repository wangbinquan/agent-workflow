# RFC-403 task-execution 小型叶子节点迁入 engine/node（RFC-294 S6，design §5.5 第 3 步之一）

- **状态**：In Progress（2026-10-31 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，你可以使用codex进行调研和实现，过程中按你的判断来推进，
  不用询问我」：由本会话设计、交 Codex 实施并审核，取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，无用户可见变化。
  设计门免：Codex 只读研究（线程 `01a193fb-7314-7963-8143-ed00042795e2`），本会话抽查关键论断后定稿；实现门做一轮只审功能的检视。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6；design §5.2、§5.5 第 3 步
- **前序**：[RFC-402](../RFC-402-task-execution-kernel-script-pilot/proposal.md)（执行机制库与 script 试点，本 RFC 沿用其形状）
- **落位**：task-execution `engine/node/<kind>/`（节点执行器）、`application/`（跨 kind 共享的分支判定 / 跳过与端口读取）、
  `application/ports`（窄合同）、`composition/`（端口绑定）

## 1. 背景

RFC-294 design §5.5 第 3 步：「依次迁 code-host、input / output、call-workflow / call-workgroup、agent、workgroup host」；design §5.2 同时把
review / clarify 的 task 侧请求与 park 结果列为节点执行器的职责。RFC-402 完成了第 1、2 步（`engine/kernel/` 与 script 试点）。

研究核对的现状（行号以提交 `da5ad65b8` 为准，`N` = `TE/composition/nodeMechanics.ts`，4621 行）：

- 9 种活动叶子 kind 加 workgroup host 一条 lane 仍经「engine 里的委托壳 → `legacyArgs` → `N` 的 run*Node」执行；`legacyArgs` 只有
  `node`、`containerRunId`、`iteration`、`log` 四项，`log` 没有执行用途。
- 本 RFC 的六种 kind 主体共 661 行：code-host-call 323（`N:2019-2341`）、input 38（`:2676-2713`）、output 95（`:2580-2674`）、
  review 20（`:2715-2734`）、clarify 40（`:2539-2578`）、clarify-cross-agent 145（`:2736-2880`）；所有 kind 共用的分支判定与跳过行写入
  152 行（`judgeBranchActivation` / `recordSkippedRun`，`:2371-2530`）；output 与 wrapper 共用的 `readPortRowAtFrame`（`:4253-4307`）；
  多处共用的 `pickString`（`:4309`）。
- code-host 与 calls 不走 `runAssembly`（RFC-287 T9 锁定的刻意例外），迁目录时不能改成 assembly 重试线。
- 其余三组（calls 两种 kind 共享 669 行主体、agent-single 1347 行、workgroup host 500 行）生命周期差异大，分别由后续 RFC 迁移。

## 2. 目标

- **G1 六种 kind 迁入 engine**：code-host-call、input、output、review、clarify、clarify-cross-agent 的执行主体分别在
  `engine/node/<registry key>/`，经显式端口执行，不再经过 `legacyArgs` 或 `TaskMechanicsState`；`N` 中六个主体删除，旧委托壳删除。
- **G2 共享实现各一份**：分支判定 / 跳过行写入归 `application/`，经 gateway 端口供所有 kind 使用；`readPortRowAtFrame` 归 `application/`
  （output 与 wrapper 共用）；`pickString` 归 domain；状态事件与隔离诊断的合同从 script 专属端口文件提到中立的节点支撑端口。
- **G3 跨 context 只走 exact 合同**：review / clarify 只构造 task 侧请求并原样返回 collaboration 的执行 / park 结果；人工门策略、
  round / decision / directive 的持久处理仍在 collaboration，经现有 exact public participant 注入，不复制。
- **G4 守卫不缩**：按路径或被调名取语料的守卫随迁移精确改指并保留负例（RFC-328 code-host effect 站点、RFC-317 CAS 站点、RFC-334、
  RFC-287、RFC-292、RFC-395、RFC-370 等）；Windows 两套 `paths:` 与适用 suite 同步；账本按实测更新，只降不升。
- **G5 纯结构**：执行顺序、run-row 前奏差异、record-before-act、per-send effect、超时、取消与中断语义、输出与结算顺序都不变。

## 3. 非目标

- call-workflow / call-workgroup（RFC-404）、agent-single（RFC-405）、workgroup host（RFC-406）的主体迁移。
- wrapper fanout 分片与聚合装配线、`taskEngineApplication.ts` 的引擎编排（design §5.5 第 4 步）；删除 `nodeMechanics.ts` 与 `legacyArgs`、
  `TaskMechanicsState` 只留装配、协调器只在 bootstrap 构造（第 5 步）。本 RFC 不宣称 S6 退出。
- `services/codeHost/*` 的 transport / project / recovery probe 实现迁移（本次经端口注入现有实现）。
- collaboration 的人工门策略与存储主体；把工作区会话改为按 taskId 共享（RFC-402 已接受的按 mechanics state 选择保持不变）。
- 安全相关改动。

## 4. 用户可见变化

无。HTTP / MCP / WS 合同、数据库结构、发布二进制的行为均不变。

## 5. 验收标准

- **AC-1 迁移**：六种 kind 的执行器与主体在 `engine/node/<registry key>/`，不 import `composition/`、`services/`，不引用
  `TaskMechanicsState`、`legacyArgs`；`nodeExecution.ts` 直接以显式端口构造它们；`N` 中六个主体与旧委托壳不存在（结构锁锁定，含负例）。
- **AC-2 共享**：分支判定 / 跳过、`readPortRowAtFrame`、`pickString`、状态事件 / 诊断合同各只有一份实现，所有消费者（含 wrapper、
  merge recovery 与剩余 legacy kind）改指真实 owner，不留 re-export。
- **AC-3 行为不变**：run-row 前奏四线五项矩阵（RFC-287 T8）、code-host 执行与恢复（RFC-269 / RFC-328 code-host attempt ledger）、
  input / output frame 与 done-only 读取（RFC-096 / RFC-354 / RFC-395）、review 显式执行上下文（RFC-370）、idle / cross clarify
  （RFC-354 / RFC-120~123 / scheduler cross-clarify）、分支跳过（RFC-306）、广播顺序（RFC-287 T1）、P0 变异 lane 全部通过，断言意图不变。
- **AC-4 守卫**：RFC-328 effect 账本把 code-host 新位置计为原站点并只接受原样转发（负例：改写策略、删观察者、删 act）；RFC-317 静态
  CAS 站点逐点在新 owner 下被识别；RFC-334 递归边界与新增 leaf 边界有嵌套负例；其余按 design §4 改指，不靠放宽匹配。
- **AC-5 账本**：`architecture/counts.json`、`commons-debt.json`、`rfc294-architecture-preflight`、`rfc376-structural-guards`、
  `architectureReport.ts` 映射、`guard-manifest.json`、Windows `paths:` 按完整候选实测更新，只降不升。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿（含 PostgreSQL 分片、三平台 e2e 与 windows-platform）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **六种 kind 一个 RFC**：它们都会碰 registry、源码语料、广播 / 前奏锁与 Windows 过滤；拆成更小的 RFC 会重复同一批守卫改动。
   calls、agent、host 生命周期差异大，各自单独成 RFC。
2. **目录用 registry key**：`code-host-call/`、`input/`、`output/`、`review/`、`clarify/`、`clarify-cross-agent/`，与封闭注册表一一对应。
3. **review / clarify 纳入本 RFC**：design §5.2 明确把 task 侧请求与 park 结果归节点执行器；主体小，并与本 RFC 共用分支 / 跳过与 ledger。
4. **分支判定 / 跳过归 application**：它适用于所有 kind，不属于某一种叶子，也不属于 kernel 的执行窗口；gateway 经端口调用。
5. **端口按 kind 列出、能力复用**：复用 RFC-402 的具名 ledger、工作区会话、状态事件等能力；每种 kind 只拿自己需要的集合，
   不把 `TaskMechanicsState` 换名成另一个总包；input 与 output 各自独立的端口，不合成一个大 bag。
6. **`services/` 现有机制经绑定注入**：code-host 的 transport / project / probe 与 effect observer 由 composition 绑定原实现，
   与 RFC-402 对 script 输出解析的处理一致；engine 仍不 import `@/services`。
7. **守卫按「owner 文件 + 函数 / AST 语义站点」取语料**：新端口调用不被漏扫、绑定转发不被重复计数；文本锁保留原语义与计数
   （RFC-402 集中验证查出 9 处语料遗漏，是本条的来由）。
8. **偏离项**：落档时无；实施中接受的偏差记在下一条。

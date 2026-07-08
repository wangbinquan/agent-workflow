# RFC-146 · 节点 kind 知识收口（proposal）

- **状态**：Draft（G3-G10 批量授权第 2 弹，设计门后直接实现）
- **来源**：`design/flag-audit-2026-07-07.md` §4.2（RFC-G4）；W0-4 已完成 `isWrapperKind` 单源化第一刀
- **前期调研**：两路并行（后端 kind 散射全景 / 前端端口推导 5-fork 差异矩阵 + NodeInspector/palette），行号以调研实测为准

## 1. 背景

「节点 kind 是什么、能干什么」这份知识散射在两包 ~30 个位置：

1. **行为表是假 SSOT**：`shared/node-kind-behavior.ts` 五维矩阵有 `satisfies Record<NodeKind,…>`
   编译强制，但文件头自认只有 `retryCascade` 一维被运行时消费——limits/orphanReap/gc/shutdown
   四维是「愿望文档」，真实语义由 kind-blind 的 status 驱动代码隐式兑现。
2. **端口推导 5 份 fork**（比审计多盘出一份后端）：权威 `computePorts`（WorkflowCanvas）、
   loop 候选 `deriveOutputPorts`（W0-6 刚修过假端口 bug）、控制流 `sourcePortKind`、拖放
   `existingInputPorts`、后端 `workflow.validator.ts` 第五份。互相欠维护（fanout 只有两份认识、
   clarify 端口在 canvas「靠边补」而 validator「硬编码」——同一 kind 两个真相）。
3. **散装谓词/集合**：`agent-single` 判定三份逐字重复（前端 ×2 + 后端 inventory）+
   `PROMPT_CAPABLE_KINDS` 双份；`SETTLES_WITHOUT_ROW_KINDS` 私有 Set；`isProcessNodeKind`
   or-chain 与 `nodeKindParticipatesInRetryCascade` 查表双实现靠测试对齐（巧合等价）；
   runTask 白名单是 6 个 `!==` 负枚举；stuckTaskDetector 内联 kind 集。
4. **前端注册面残缺**：NodeInspector 1249 行 8-case 巨型 switch（与 `NODE_TYPES` 渲染器
   注册表的好形态不对称）；nodePalette 同文件 5 个散装点 + 图标 glyph 第 6 点跨文件硬编码；
   nodeTitle 两份派生已分叉（review 特判只在一份里）。

新增一种叶子 kind 今天要改 **~13 处 / 7+ 文件**。

## 2. 目标

1. **行为表重铸为全真表**：删除 limits/orphanReap/gc/shutdown 四个零消费维（语义降为注释，
   由 status 驱动代码继续隐式保证）；保留 `retryCascade`；新增三个**有真实消费者**的维度——
   `isProcess`（收敛 `isProcessNodeKind` 双实现）、`isAgent`（收敛 3 份谓词 + 2 份
   PROMPT_CAPABLE Set = 5 处）、`settlesWithoutRow`（收敛 scheduler 私有 Set）。
   表的每一维都必须有运行时消费者——不再收留愿望。
2. **端口声明层单源**：新建 shared `declaredPorts(node, agentByName, nodeById)`
   （`Record<NodeKind, deriver>` + satisfies 穷举；返回 `{ name, kind? }`，**分组
   `{ dataInputs, dataOutputs, systemInputs, systemOutputs }`**）。五个消费面各取投影：
   validator 取 data+system 且不吃边（保持故意拒边语义）；canvas `computePorts` 降为
   「声明层 + 入/出边容错 + 有序化」薄封装（系统口维持靠边补的渲染现状）；loop 候选/
   控制流（吃 per-port kind）/拖放全部改查声明层。
3. **runTask 白名单正向化**：负枚举改为表成员判定；runOneNode 分派**不表化**（handler
   闭包持 SchedulerState，表化会造反向依赖），在 agent-single fall-through 前加一行
   运行时穷举守卫。
4. **前端注册面补齐**：NodeInspector 拆 8 个 per-kind 组件 + `Record<NodeKind, FC>`
   satisfies 注册表（`NODE_TYPES` 同形，顺手给 NODE_TYPES 补 satisfies）；nodePalette
   5 点 + glyph 收敛为单一 `Record<NodeKind, PaletteDescriptor>`；nodeTitle 两份合并单源
   （统一采用含 `review:<port>` 的完整规则）。

## 3. 非目标

- **不动 wrapper 运行时语义**（scheduler-audit WP-6 领地：fanout 部分容忍、clarify-in-wrapper
  等）；本 RFC 只管「kind 判定与注册面」。
- **不表化 runOneNode 分派**（调研结论：闭包 + 循环依赖，收益低成本高）。
- **不动尺寸表**（`DEFAULT_NODE_SIZE_BY_KIND` 已是全量 Record 单源样板）。
- **不新增 kind**；收口后新增叶子 kind 的改动面收敛到：shared 行为表 1 行（编译强制）+
  端口声明表 1 行（编译强制）+ Inspector 组件 1 个（编译强制）+ palette 描述符 1 行
  （编译强制）+ runOneNode 分支 1 处（运行时守卫兜底）。
- **输出端口 kind 体系**（path/list/signal，`KindSelect`/`output-port.ts`）是另一命名空间，
  不属本 RFC。

## 4. 验收标准

1. 行为表每一维都有运行时消费点（grep 可证）；四个愿望维删除；
   `isProcessNodeKind`/`isAgentNodeKind`/`settlesWithoutRow` 全仓单源（旧 5+2+1 处清零）。
2. 端口推导：validator 与 canvas 共用声明层（第五 fork 消亡）；loop 候选/控制流/拖放
   三镜像改查声明层；canvas 既有契约测试全绿（含「clarify 系统口靠边补」「boundary 跳过」
   「stale 端口 backfill」语义逐字保留）。
3. runTask 白名单表驱动正向判定；runOneNode fall-through 守卫（非 agent-single 落入即
   fail-loud）。
4. NodeInspector 每 kind 一个组件文件 + satisfies 注册表；既有 node-inspector 渲染测试
   全绿（props 面不变）；palette 描述符表替换 5 散装点，palette 测试（含 glyph 字面量锁）
   全绿；nodeTitle 单源（canvas 标题对 review 节点变为 `review:<port>`——唯一有意的
   展示变化，测试同步）。
5. 门禁全绿 + CI conclusion=success + Codex 双门收敛。

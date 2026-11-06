# RFC-453 workspace-insight 一族归新模块 workspace-insight（RFC-294 W4 B / D 第十八步、E5）

- **状态**：Done（2026-11-05，`6fb219f5b`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D、E5（workspace-insight）
- **前序**：[RFC-452](../RFC-452-task-recovery-and-diagnostics-into-task-execution/proposal.md)（`tasks` 路由只余 workspace-insight 一族 7 处 `services/` import）。
- **落位**：新模块 `modules/workspace-insight`（`domain`、`engine`、`application`、`application/ports`、`infrastructure`、`composition`、`public/types`）；
  source-control 的 `infrastructure/local`；task-execution 的 `application` 与 `public/queries`；shared 的 `repoGroupLayout` 与 `schemas/codeIntel`；
  路由、装配根与 HTTP 装配。

## 1. 背景

RFC-452 之后，`routes/tasks.ts` 是唯一还 import `services/` 的路由，余下 7 处全属 RFC-294 的 workspace-insight context：结构 diff
（`structuralDiff/service`、`structuralDiff/deep/service` 的类型）、调用链展开（`structuralDiff/callGraph/expandService`）、文件符号与代码智能
（`codeIntel/fileSymbols`、`codeIntel/codeIntel`）、变更叙述（`changeNarrative`）与 diff 里的文件正文（`worktreeFileContent`）。

这一族共 32 个文件（`services/structuralDiff/**` 27 个、`services/codeIntel/**` 3 个、`changeNarrative.ts`、`worktreeFileContent.ts`，约 5,900 行），
RFC-294 一直把它记为「唯一没有模块的目标 context、自成一体的干净抽取候选」。直接整体挪进一个新模块会撞上四条边：

- **source-control → 这一族**：source-control 的本机修订内容适配器（`RepositoryRevisionContent` 的 `classIndex()` / `snapshotDigest()`，托管时在
  任务镜像里跑同一个适配器）取了这一族的三个 helper——工作树快照摘要、类声明索引、文件语言判定。workspace-insight → source-control 是
  RFC-294 给出的边，反过来不是；挪进模块后这就成了 off-DAG 的值依赖（`context-value-pairs-off-dag` 上限 0）。
- **这一族 → code-capability**：结构 diff 与变更叙述的持久化走 code-capability 里的 code-review 产物存储（端口、本机文件实现、托管对象实现与
  清扫）。code-capability 归 development-automation，workspace-insight → development-automation 不是给出的边。这套存储除了这一族与装配根
  再无消费者，本就是 RFC-294 说的「insight artifact」。
- **这一族 → 其他 legacy**：`services/repoLabels`（规范 repo key，只依赖 shared）、`services/reviewRoundStart`（时间线排序，只依赖
  task-execution 的 `requireRunSequence`，消费方只有 task-execution 与这一族）、`services/lifecycle`（task-execution 的兼容转出）。
- **层**：深度模式（SCIP 外部索引器）要起子进程、建临时目录；而结构 diff 与代码智能的用例直接 import 它，并在缺省时现场创建本机文件
  产物存储与索引缓存单例。

## 2. 目标

- **G1 新模块 workspace-insight**：32 个文件按职责落位——纯分析与值类型进 `domain`；tree-sitter 分析引擎（语法资源、解析、抽取、遮罩、
  基线分析、装配、调用展开）进 `engine`；面向任务的用例（结构 diff、修订分析、节点范围、调用目标、代码智能、文件符号、变更叙述、文件正文）
  进 `application`；起子进程的深度索引（探测、运行、索引缓存、深度结构 diff）进 `infrastructure`。函数体原样，只改 import；为满足分层而
  拆开的文件逐函数原样搬（§6 列出）。32 个 `services/` 文件删除，不留 facade。
- **G2 产物存储归 workspace-insight**：code-capability 的 code-review 产物存储（端口、本机文件、托管对象、托管清扫、两个装配）原样迁入
  workspace-insight；code-capability 的 `public/participants`（只导出这套存储）删除。
- **G3 source-control 不再依赖这一族**：工作树快照摘要与类声明索引原样迁入 source-control `infrastructure/local`（它们只服务 source-control
  自己的端口）；类声明索引一并带走的只有 `scanClassDecls` / `buildClassIndex`，调用展开用的 `inferLocalTypes` 留在 workspace-insight；
  类索引遍历的语言判定改用 shared 已有的扩展名表（`langIdForPath`），并新增用例锁定 shared 的表与分析引擎的语法表逐项一致。
- **G4 legacy helper 归位**：`repoLabels` 的两个函数并入 shared `repoGroupLayout`（与 `repoKeyWire` 同处）；`reviewRoundStart` 迁入
  task-execution `application`，时间线比较器经 `public/queries` 给 workspace-insight；终态集合直取 shared。两个 `services/` 文件删除。
- **G5 路由只经 public 合同**：`tasks` 路由的 7 个端点只调 workspace-insight 的 `TaskWorkspaceInsight`（`public/types`）；权限门、参数读取、
  配置读取（深度索引器覆盖与叙述 runtime 选择）与变更叙述的成员门留在路由；HTTP 装配用原来同一批对象组合合同。
- **G6 行为不变**：7 个端点的 HTTP 形状、错误码、权限门与成员门的顺序、深度模式的回落、产物的读写时机、叙述的单飞与失败缓存、
  索引缓存的单例与清空、调用图索引失效、托管清扫全部不变。

## 3. 非目标

- 分析算法与 UI；RFC-294 E5 设想的「持久化叙述作业 / 洞察失效事件」（本 RFC 只换位置与依赖方向，模块级状态原样保留）；
- `services/runtime`（W5）与其他 legacy；code-capability 兼容岛的其余部分；
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：32 个旧文件与 `repoLabels`、`reviewRoundStart` 不存在，`src/` 与用例零引用；code-capability 的产物存储文件与
  `public/participants` 不存在；`routes/` 下零个文件 import `services/`（RFC-294 W4 B / D 退出条件）；source-control 不 import
  workspace-insight；平台 → 模块仍为 0。
- **AC-2**：架构计数不升：`context-value-pairs-off-dag` 0、`context-value-sccs` 0、`backend-value-scc` 0、`application-direct-effect-files`
  不增、`cross-context-internal-file-pairs` 不增；`R1` / `R2` 按实测记录且不增；public surface 不新增债；`services/` 文件数按实测记录。
- **AC-3**：结构 diff（基线 / 深度 / 存储回读）、调用链展开、文件符号、代码智能、变更叙述、文件正文、产物存储（本机 / 托管 / 清扫）、
  修订内容（类索引 / 快照摘要）、时间线排序与 repo key 的既有用例全部通过；新增 RFC-453 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **一次迁整族并带上产物存储**：只挪路由用到的 7 个文件会让其余 25 个 legacy 文件反过来深引模块内部；只挪这一族不带产物存储会留下
   workspace-insight → development-automation 的值边（上限 0）。三处 source-control helper 同理必须一起处理。
2. **深度索引经端口**：用例经 `application/ports` 的深度索引端口调深度结构 diff 与索引缓存，`composition` 绑定 `infrastructure` 的实现；
   用例不再现场创建本机文件产物存储或索引缓存单例（装配点一直显式给，缺省只服务直调的用例，改由用例自己的 helper 组本机实现）。
3. **成员门留在路由**：变更叙述的成员门原是触发函数的第一句，迁到路由里紧挨着触发调用之前，顺序与语义不变；合同因此不必接 `Actor`。
4. **语言判定用 shared 的表**：source-control 的类索引只需要「这是不是受支持语言的源文件」，shared 早有前端用的同一张扩展名表；
   用 `langIdForPath(extname(name))` 精确等价于原来的 `resolveLang(name) !== null`（以表相等为前提，由新用例锁定）。
5. **`reviewRoundStart` 归 task-execution**：它的两个函数只被 task-execution 的路由投影与这一族用，比较器依赖 task-execution 的
   `requireRunSequence`；归属表原登记 collaboration，但 workspace-insight 与 task-execution 都不能取 collaboration 的 legacy。

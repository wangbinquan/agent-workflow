# RFC-622 技术设计

记号：`S/` = `packages/backend/src/modules/source-control/`，`T/` = `packages/backend/tests/`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **裁定一：绑定器是用例编排，归 application**。design §2：用例编排与规则判定进 application；composition 只允许构造与注入。三个绑定器按选中的效果决定
  由托管操作宿主还是本地步骤、由工作区卷还是本进程执行用例——与 `S/application/repositoryCandidateEffects.ts` 已有的同类判断同层。它们只取
  `changeCandidate`、`deliverCandidate`、`repositoryCommit`、`workspacePorts` 与 ports 和 public 类型，迁入不需要任何新依赖。
- **裁定二：模块根照旧转出**。`S/composition.ts` 的三条转出改指 application 文件，bootstrap 两个调用方（`daemonModules/digitalEmployee.ts`、
  `daemonModules/developmentAutomation.ts`）不用改。
- **偏离项**：无。

## 1. 改动

- 新增 `S/application/repositoryCandidateParticipants.ts`（两个候选绑定器，逐字）与 `S/application/repositoryCommitParticipant.ts`（提交绑定器，逐字，
  `requireRepositoryGitWorkspaceScope` 改为取它的定义处 `./workspacePorts`）；删除 `S/composition/repositoryCommit.ts`；`S/composition/repositoryCandidate.ts`
  只留 `createLocalRepositoryCandidateEffects`。
- 读者按语法树改写（15 个文件）：取旧提交文件的改指新位置；从旧候选文件取两个绑定器的拆出来改取 application，夹具工厂照旧。
- 锁与账本：`rfc527` 的候选绑定读点改指 application；`rfc521` 组合层回落清单删去旧提交文件那一条（它的三个进程内 `option` 默认值随函数进了 application）；
  `rfc612` 的“候选与提交两个绑定之外没有控制流”改为“组合层没有控制流”；`rfc511` 的组合文件清单里 `composition/repositoryCandidate` 只剩夹具工厂（无分支、不再取完整性核对），两个核对的调用处改指 application 文件；`rfc475` 的文件清单与文件头改指新位置；
  `architecture/counts.json`：`composition-control-flow-source-control` 4 → 0。

## 2. 用例

- 新增 `T/rfc622-source-control-binders-into-application-boundary.test.ts`，登记 guard-manifest：
  1. 旧提交绑定文件不在；三个绑定器只在两个 application 文件里声明、组合层不声明；模块根 `composition.ts` 从 application 转出它们。
  2. 两个 application 文件只取本模块的 application、domain 与 public 类型。
  3. backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts`、`tests` 里没有文件取旧提交绑定文件，也没有文件从组合层取候选绑定器（按语法树，语料下限 3,000）。
  4. 负对照：三条判据都认得出违例，夹具工厂、别名导入与字符串里的路径不算。
- 原用例照旧覆盖行为（`rfc308-repository-commit`、`rfc310-pr4/pr5`、`rfc370-*-candidate-*`、`rfc396-*` 等经模块根或新位置调用这三个函数）。

## 3. 失败模式

- **有人把绑定器放回组合层**：`composition-control-flow-source-control` 超过 0、`rfc612` 与 RFC-622 用例 ① 红。
- **application 绑定文件取了组合层或基础设施**：RFC-622 用例 ② 红。

## 4. 对 RFC-294 刷新后规则的对账

- **S10**：source-control 的组合层只剩装配。**C12**：RFC-622 用例扫全部源码与用例，带语料下限与负对照。**C13**：计数降、不升。

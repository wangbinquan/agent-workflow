# RFC-511 设计：源码控制组合层的端口完整性核对迁出 composition

## 1. 现状（HEAD `036df2e8c`，源码实读）

source-control 组合层控制流（F13 口径）148 行：RFC-370 的 `crewstation*` / `taskImage*` 101 行，其余 11 个文件 47 行。本 RFC 的 28 行都是端口的
装配期完整性核对（行号是 HEAD 的组合文件）：

| 文件（`composition/` 下）           | 核对（HEAD 行）                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `isolationWorkspaces.ts`            | `requireIsolationWorkspaceScope`（7～33）；`selectIsolationWorkspaceFactory` 里工厂的核对（40～42）                   |
| `repositoryGitWorkspaces.ts`        | `requireRepositoryGitWorkspaceScope`（9～27）；`selectRepositoryGitWorkspaceFactory` 里工厂的核对（36～38）           |
| `workspaceUploads.ts`               | `requireWorkspaceUploadContent`（7～25）；`selectWorkspaceUploadContentFactory` 里工厂的核对（32～34）                |
| `workspaceExcludeProfiles.ts`       | `selectWorkspaceExcludeProfileFactory` 里工厂的核对（23～25）；`bindWorkspaceExcludeProfile` 里参与者的核对（41～47） |
| `repositoryWorkspaceReadQueries.ts` | `selectRepositoryWorkspaceReadQueries` 里方法表与核对（9～22）                                                        |
| `conflictMerge.ts`                  | `bindConflictMergeParticipant` 里选定效果的核对（25～39）                                                             |
| `repositoryCandidate.ts`            | 文件内函数 `validateFactory`（26～47：操作宿主的四个操作或分步工厂的 `acquire`）                                      |

使用方：source-control 的 public participants 从组合文件转出 `requireWorkspaceUploadContent`、`requireIsolationWorkspaceScope` 与几个选择函数，public
queries 转出 `selectRepositoryWorkspaceReadQueries`；`requireRepositoryGitWorkspaceScope` 另被 `composition/repositoryCommit.ts` 取用。
`rfc294-architecture-preflight` 的符号根允许清单按“首先到达的声明位置”记着两个 `require*` 的开放类型（`UnknownKeyword`）。

## 2. 机制与落位

### D1 核对落 application

核对只看交入的值是否满足端口的形状，不做 IO（与 RFC-508、RFC-510 同类）：

- **`application/workspacePorts.ts`**（新）：`requireIsolationWorkspaceScope`、`requireRepositoryGitWorkspaceScope`、`requireWorkspaceUploadContent`
  （HEAD 原函数逐字）；`requireIsolationWorkspaceFactory`、`requireRepositoryGitWorkspaceFactory`、`requireWorkspaceUploadContentFactory`、
  `requireWorkspaceExcludeProfileFactory`、`requireWorkspaceExcludeParticipant`、`requireRepositoryWorkspaceReadQueries`（函数体是 HEAD 对应的核对
  逐字）。排除配置的两个类型声明在本模块的 `public/participants.ts`，application 取本模块 public 类型已有先例。
- **`application/repositoryCandidateEffects.ts`**（新）：`requireRepositoryCandidateEffectsFactory`（函数体是 HEAD `validateFactory` 逐字）。
- **`application/conflictMerge.ts`**（增）：`requireConflictMergeWorkspaceEffects(selected)`（函数体是 HEAD 第 25～39 行逐字）。

### D2 composition 只装配

- 组合文件改为调用新位置的核对，选择与装配入口不变；原来从组合文件导出的 `requireIsolationWorkspaceScope`、`requireRepositoryGitWorkspaceScope`、
  `requireWorkspaceUploadContent` 照旧从组合文件转出（public participants 与 `repositoryCommit.ts` 的 import 不改）；`validateFactory` 的调用改为
  `requireRepositoryCandidateEffectsFactory`。
- 时机不变：工厂与选定效果的核对仍在选择或装配时，参与者与作用域的核对仍在每次绑定时。

### D3 锁与账本

- `architecture/counts.json`：`composition-control-flow-source-control` 148 → 实测（预计 120）。`guard-manifest.json` 登记 RFC-511 用例
  （`assertsAbsence: true`，断言写成 `toEqual([])` 的字面形态，RFC-510 的教训）。
- `rfc294-architecture-preflight` 的符号根允许清单：两个经 public participants 转出的 `require*` 的条目随声明位置改到新文件（条目文本取自候选的
  架构报告，开放类型的种类不变）。
- 迁移前按组合文件路径扫用例里的 `readFileSync`，并核对按语料计数的账本（RFC-509、RFC-510 的教训）：source-control 没有类似 `rfc423` 的 throw
  账本；读这些组合文件原文的锁只有上面的允许清单。

## 3. 清单（退出门）

| 位置（`packages/backend/src/modules/source-control/` 下） | 声明并交出                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `application/workspacePorts.ts`（新）                     | `requireIsolationWorkspaceScope`、`requireIsolationWorkspaceFactory`、`requireRepositoryGitWorkspaceScope`、`requireRepositoryGitWorkspaceFactory`、`requireWorkspaceUploadContent`、`requireWorkspaceUploadContentFactory`、`requireWorkspaceExcludeProfileFactory`、`requireWorkspaceExcludeParticipant`、`requireRepositoryWorkspaceReadQueries` |
| `application/repositoryCandidateEffects.ts`（新）         | `requireRepositoryCandidateEffectsFactory`                                                                                                                                                                                                                                                                                                          |
| `application/conflictMerge.ts`（增）                      | `requireConflictMergeWorkspaceEffects`                                                                                                                                                                                                                                                                                                              |

允许的形状：7 个组合文件不再声明清单里的名字，也不再有这 28 行核对；它们只从新位置取核对，转出原有的名字。

## 4. 用例

新增 `packages/backend/tests/rfc511-source-control-port-completeness-checks-out-of-composition-boundary.test.ts`，登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的位置声明；新文件恰好声明、交出清单列的名字；7 个组合文件
  不再声明它们，转出的名字不变。
- ② 7 个组合文件里不再有这 28 行核对（余下的控制流逐个钉住）；每个核对在生产代码里的调用方与实参钉住；带负对照。
- ③ 新代码的依赖面是闭集：两个新文件只取本模块的 `application/ports` 与 public 的类型；不用进程全局；带负对照。
- ④ 行为（直接调用新位置）：每个核对接受齐全的值、拒绝缺方法或缺字段的值并抛原文错误；候选效果工厂区分操作宿主与分步工厂。

行为另由现有用例经装配入口对拍（RFC-370 的工作区、上传、隔离与候选用例，`rfc396`、`rfc471` 等）。

## 5. 失败模式

- **核对走样**：函数体逐字迁移；短路次序与错误串原样保留。
- **允许清单漂移**：两个 `require*` 的声明位置变了，允许清单的条目同步改；开放类型本身不变（架构报告的 public surface 偏差数不变）。
- **读原文的锁与按语料计数的账本**：已预查（D3）。
- **账本漏标**：`assertsAbsence: true`，断言用字面形态。

## 6. 取舍（可推翻）

1. **五组工作区端口核对放一个新文件**：它们同属工作区端口（隔离、Git、上传、排除、只读查询），放一处比各开一个文件好找。
2. **候选效果工厂的核对单独成文件**：它区分操作宿主与分步工厂，与工作区端口无关。
3. **组合文件保留转出**：public participants 与组合层内的使用方 import 不改。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是端口的装配期完整性核对，落 application；组合文件只装配与选择。
- **C11**：public 不变（转出的名字不变，开放类型的种类不变）；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-511 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读 7 个组合文件与新位置。
- **C13**：`composition-control-flow-source-control` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 source-control 的第二步（第一步是 RFC-499）：端口的装配期完整性核对离开 `composition/`（28 行）。
- **留下**：source-control 组合层的其余 19 行（装配期选择与 `repositoryMirrors.ts` 的缓存仓库用例 11 行）由后继承接；`crewstation*` /
  `taskImage*` 待 RFC-370 余项；resource-catalog 等模块的余项与 S10 收口另立。

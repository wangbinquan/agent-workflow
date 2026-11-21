# RFC-527 设计：源代码管理的适配器回落改为必填注入

## 1. 现状（HEAD，源码实读）

RFC-521 门登记的 19 处（路径在 `packages/backend/src/modules/source-control/` 下）：

| #         | 位置                                                                                   | 回落                                                                                                               | 生产调用方                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | `composition.ts` `bindEmployeeCaseWorkspaceParticipant`（缺省参数 `{}`）               | 不给 `effects` → 本机员工案例工作区 effect 工厂                                                                    | daemon 的数字员工装配总给部署选择的（必填项）                                                                                                                       |
| 2         | `composition/cachedRepositoryOperations.ts` 的 `refresh`                               | 镜像没有远端登记 → 本机镜像缓存的刷新（`refreshCachedRepo`，守卫返回之后）                                         | 单机部署的镜像就是本机镜像：生产路径在用                                                                                                                            |
| 3、4      | `composition/conflictMerge.ts` `bindConflictMergeParticipant`（缺省参数 `{}`）         | 不给 `effects` → 本机冲突合并 effect；请求带测试用的 `runGit` 时按它另造                                           | daemon 的数字员工与开发自动化装配把部署选择的 `null` 转回 `undefined` 再交入：单机部署一直走回落                                                                    |
| 5         | `composition/isolationWorkspaces.ts` `selectIsolationWorkspaceFactory`                 | 不给 → 本机隔离工作区工厂                                                                                          | 唯一调用方是 task-execution 的驱动参与者（输入可选，daemon 总给部署选择的）                                                                                         |
| 6、7      | `composition/repositoryCandidate.ts` 两个候选绑定（缺省参数 `{}`）                     | 不给 `candidateEffects` → 每次请求按请求里的 `runGit` 造本机候选 effect；推送另带本机夹具会话                      | 同 #3：单机部署一直走回落                                                                                                                                           |
| 8、10、11 | `composition/repositoryCommit.ts` `bindRepositoryCommitParticipant` 的三个用例         | 作用域没有托管的提交操作 → 进程内的提交用例（`prepareRepositoryCommit` 等，application）                           | 单机部署与没有作用域的子仓策略绑定都走它                                                                                                                            |
| 9         | 同上的预览索引                                                                         | 没有作用域、不给 `previewIndex` → 绑定时就按路径造本机预览索引                                                     | 生产没有读提交预览的调用方（没有作用域的绑定只用于子仓的准备、提交、路径归类与发布）                                                                                |
| 12        | `composition/repositoryGitWorkspaces.ts` `selectRepositoryGitWorkspaceFactory`         | 不给 → 本机 git 工作区工厂（可带只为用例存在的 `legacyRunGit`）                                                    | 驱动参与者、提交推送绑定（取运行参数）与提交推送执行（取依赖）；daemon 经驱动参与者每次驱动都给                                                                     |
| 13        | `composition/repositoryMirrors.ts` `composeRepositoryMirrors`                          | 不给 `remote` → 本机镜像（守卫返回）                                                                               | daemon HTTP 装配在部署选择的 `repositoryRemote` 为 `null` 时不给：单机部署生产路径在用                                                                              |
| 14、15    | `composition/repositoryPreparation.ts` `composeRepositoryPreparation`                  | 不给两组 effect → 本机准备与草稿区 effect                                                                          | daemon 总给；维护 worker 交 worker 效果里的，单机为 `null`——一直由回落造                                                                                            |
| 16        | `composition/repositoryWorkspaceReadQueries.ts` `selectRepositoryWorkspaceReadQueries` | 不给 → 本机工作区读取                                                                                              | task-execution 的任务路由操作与修复操作（输入可选，daemon 都给）                                                                                                    |
| 17        | `composition/workspaceExcludeProfiles.ts` `selectWorkspaceExcludeProfileFactory`       | 不给 → 本机排除档案（每次绑定按 `readLocalAppHome()` 读配置）                                                      | 单机部署的选择 `composeLocalWorkspaceExcludeProfiles` 就是 `select…(undefined, () => appHome)`；task-execution 的 `composeTaskWorkspaceExcludeProfilesFor` 只有用例 |
| 18        | `composition/workspaceMaintenance.ts` `composeWorkspaceMaintenanceCommand`             | 不给 `filesystem` → 本机工作区维护文件系统（`appHome` / `isMaterializingTask` / `invalidateWorkspacePath` 只为它） | daemon 总给部署选择的；维护 worker 交 worker 效果里的，单机为 `null`——一直由回落造                                                                                  |
| 19        | `composition/workspaceUploads.ts` `selectWorkspaceUploadContentFactory`                | 不给 → 本机上传内容工厂                                                                                            | task-execution 的上传策略；daemon 的路由启动总给；task-execution `infrastructure/local/nativeWorkspaceUploads.ts` 的入口只有用例                                    |

补充事实：

- 五个 `select*` 都在 source-control 的 public 合同里（实施时查明排除档案的那个只有只服务用例的调用方，见 D1）（`public/participants.ts`、`public/queries.ts`），消费方全在 task-execution。
- 驱动参与者每次驱动都把选好的隔离工作区与 git 工作区并进运行参数（`infrastructure/taskExecutionRuntimeParticipants.ts`），提交推送绑定与执行工作区
  绑定从运行参数取。
- 单机推送走回落一支时带 `localFixtureSession: createFileRepositoryPublicationFixtureSession(url, runGit)`：没有托管传输与持久主体时，本机路径与
  `file://` 远端由它推送；给了步骤工厂的一支（用例的替身）不带它。托管选择是操作宿主，整段在卷里跑，不经这两支。
- 提交绑定的托管作用域（`infrastructure/crewstation/workspaceEffects.ts`）在卷里跑的是同一组 application 提交用例（`taskImageWorkspace.ts`）；本机作用域
  不带 `commitOperations`。
- 部署选择的 `repositoryCandidateEffects` 与 `conflictMergeWorkspaceEffects` 在“必填、可空”一组（单机 `null`），托管给操作宿主与托管 effect。
- 工作区改动发布的 `bindPoliciesToWorkspace` 只在提交推送执行没给工作区工厂时为假（只有用例），生产总为真：子仓的提交策略总在选定的
  子工作区上跑。
- daemon 应用装配另有两处把托管能力的 `null` 转回 `undefined`：输入文件留存（`taskInputFiles`）与任务恢复（`taskRecovery`）。消费方（路由启动
  的上传、provider 运行期的恢复消费者）把没给当作没有这项能力，不造本机实现。HTTP 装配还有一处：部署选择的 CrewStation 事件入口
  （`crewStationEvents`）转回 `undefined` 交给 integration 的 `composeWebhookIngressTransport`，它把没给当作单机、开放直连的 webhook 入口。

## 2. 机制与落位

### D1 选择助手（public，保留名字）

- `selectIsolationWorkspaceFactory(selected)`、`selectRepositoryGitWorkspaceFactory(selected)`、`selectRepositoryWorkspaceReadQueries(selected)`、
  `selectWorkspaceUploadContentFactory(selected)`：选择必填、只做核对；删去 `legacyRunGit`。
- 排除档案的选择 `selectWorkspaceExcludeProfileFactory` 的生产调用方只有 task-execution 里只服务用例的 `composeTaskWorkspaceExcludeProfilesFor`；它
  移进测试助手后选择没有调用方（架构报告的 source-control 未消费 public 符号会多一个），连同只为它存在的 `readLocalAppHome` 与核对
  `requireWorkspaceExcludeProfileFactory` 一并删去。
- task-execution 的消费方随之必填：驱动参与者输入的隔离工作区与 git 工作区（绑定后的运行参数本来就必填，驱动参与者每次都给）、提交推送执行依赖
  里的 git 工作区（删去只为回落存在的 `runGit`；工作区改动发布只为“没给工厂”存在的 `bindPoliciesToWorkspace` 随之删去）、任务路由操作与修复操作的工作区读取、上传策略与路由启动的上传内容工厂。工作区上传（`applyTaskWorkspaceUploads`）的写入方改为二选一、必给：部署的上传内容工厂，或进程中断预言用的整体写入替身；都不给是类型错误，都给照旧被拒（类型与运行期）。只服务用例的
  `composeTaskWorkspaceExcludeProfilesFor` 与 `applyUploadsToWorktree` 移进测试助手。

### D2 排除档案

- `composeLocalWorkspaceExcludeProfiles({ appHome })` 自己构造本机档案工厂（回落一支的代码原样移入：每次绑定按应用根目录读配置），不再经选择助手的
  回落；单机部署照旧调它。

### D3 员工案例、冲突合并与候选交付

- `bindEmployeeCaseWorkspaceParticipant`、`bindConflictMergeParticipant`、两个候选绑定的 effect 必填（删去缺省参数）；删去按请求造本机 effect 的分支、
  私有的 `selectFactory` 与请求上只为回落存在的 `runGit`。
- 本机候选 effect 工厂带上本机夹具会话（工厂对象的可选成员 `localFixtureSession`）；交付绑定的推送把步骤工厂自带的夹具会话交给 `pushCandidate`——单
  机推送与此前回落一支相同，用例的步骤替身照旧不带。
- 部署选择：两项移进“必填”一组，单机给本机实现（组合层转出的 `createFileRepositoryCandidateEffectsFactory()` 与
  `createFileConflictMergeWorkspaceEffects()`，与此前回落同一组参数），托管不变；daemon 的数字员工与开发自动化装配删去四处 `null` → `undefined`。

### D4 仓库镜像与手动刷新

- `composeRepositoryMirrors` 拆成 `composeLocalRepositoryMirrors({ store })` 与 `composeRemoteRepositoryMirrors({ store, remote, … })`；daemon HTTP 装配按
  部署选择的 `repositoryRemote === null` 显式选一支（删去把 `null` 转成不给的写法）。
- 镜像端口的登记方式显式化：`remoteRegistration?` 改为必填的 `registration`——`{ kind: 'mirror-cache' }` 或 `{ kind: 'remote', register, refresh }`；
  手动刷新与仓库组按 `kind` 分支（本机镜像缓存的刷新是 `mirror-cache` 一支的实现，与此前“没有远端登记”时相同）。

### D5 仓库准备与工作区维护

- `composeRepositoryPreparation` 的两组 effect 必填，文件只剩装配与转出。
- `composeWorkspaceMaintenanceCommand` 的 `filesystem` 必填，删去只为回落存在的 `appHome`、`isMaterializingTask`、`invalidateWorkspacePath`（daemon 的
  应用装配随之不再交它们）。
- 维护 worker 在 worker 效果为 `null`（单机）时显式给本机的准备 effect、草稿区 effect 与维护文件系统（组合层已转出，同一组参数）；托管照旧取效果里的。

### D6 提交绑定

- 没有作用域时的预览索引：删去绑定时按路径造本机预览索引的回落；`preview` 取调用方给的 `previewIndex`，没给就报错（生产没有读提交预览的调用方；用例
  给本机预览索引）。
- 进程内的提交用例是模块的主路径、不是替身，在 RFC-521 门里按 `option` 登记（§6 取舍 1）。

### D7 用例与测试助手

- tsc 列出的调用逐处改为显式给出（量大的按 AST 脚本改，在原来回落的位置给同一个工厂与参数）；测试助手只在用例没给时造，不盖掉用例经展开传入的同名
  值；只服务用例的两个入口移进测试助手。钉旧形状与回落原文的锁随改：按删去的名字、选项与回落原文扫描，再按被改文件的路径筛出读取其源码的全部
  用例（RFC-525），并逐个核对按 AST 钉住装配实参的锁（RFC-526）。

### D8 门与锁

- RFC-521 门删去 19 条适配器登记，`repositoryCommit.ts` 的三处按 `option` 登记；适配器回落 19 → 0、`SUCCESSORS` 清空（门的“后继与模块逐个相
  等”随之为空集）。计数降的收紧到实测；新增 RFC-527 用例并登记 guard-manifest。

### D9 托管能力与 CrewStation 事件入口

- 输入文件留存与任务恢复只有托管部署才有（单机 `null`）：消费方改取 `X | null`、显式判 `null`——路由启动、启动上传与工作区上传的 `inputFiles`，
  provider 运行期的 `recoverySelection`；daemon 应用装配原样交入（任务恢复照旧按身份访问构造），删去两处 `null` → `undefined`。
- integration 的 `composeWebhookIngressTransport` 的 `crewStationEvents` 改为可空、必给（单机 `null`，托管给入口；可用性判断改判 `null`），
  HTTP 装配原样交入部署选择、删去这处转换；转出的 `crewStationEvents` 随之可空，`server.ts` 照旧以可选链挂载。至此 S12 第 1 项点名的写法在
  bootstrap 里清零（用例按全部 bootstrap 文件扫）。

## 3. 清单（退出门）

| 名字                                                                                                                                                                                                                                                                                                                 | 之后                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 四个 `select*`                                                                                                                                                                                                                                                                                                       | 保留名字，选择必填          |
| `selectWorkspaceExcludeProfileFactory` 与 `requireWorkspaceExcludeProfileFactory`、`legacyRunGit`、`readLocalAppHome`、`NativeGitFixture` 与请求上的 `runGit`、私有 `selectFactory`、`composeRepositoryMirrors`、维护命令只为回落存在的三项、提交推送执行依赖的 `runGit`、工作区改动发布的 `bindPoliciesToWorkspace` | 删去                        |
| `composeTaskWorkspaceExcludeProfilesFor`、`applyUploadsToWorktree`                                                                                                                                                                                                                                                   | 移进测试助手                |
| `composeLocalRepositoryMirrors`、`composeRemoteRepositoryMirrors`、`RepositoryMirrors.registration`、本机候选 effect 工厂的 `localFixtureSession`                                                                                                                                                                    | 新增                        |
| 工作区上传的写入方（`TaskWorkspaceUploadWriter`）                                                                                                                                                                                                                                                                    | 二选一、必给                |
| 路由启动与上传的 `inputFiles`、provider 运行期的 `recoverySelection`、webhook 入口的 `crewStationEvents`                                                                                                                                                                                                             | 可空、必给（显式判 `null`） |

## 4. 用例

新增 `packages/backend/tests/rfc527-source-control-required-selections-boundary.test.ts`，登记 guard-manifest：

- ① 选项必填：逐个钉住各入口的入参成员（可选标记一并钉）；工作区上传的写入方是二选一的联合类型（两支逐个钉）；webhook 入口的
  `crewStationEvents` 可空、必给。
- ② bootstrap 不取 source-control 的 infrastructure、不再把部署选择的 `null` 转回 `undefined`（扫全部 bootstrap 文件）；删去的名字与选项在生产代码里不再出现（语料下限 3,000，先
  按名字文本筛、给语料用例时限）。
- ③ 装配处的显式构造逐处钉住：单机部署的候选与冲突合并选择、镜像按 `repositoryRemote` 选一支、维护 worker 的三项本机效果。
- ④ 行为：镜像两支的登记方式、手动刷新按 `kind` 分支；本机候选推送带夹具会话、步骤替身不带；没有作用域时预览要求给出索引；选择助手只核对、原样交
  出。
- ⑤ 负对照。

## 5. 失败模式

- **改变构造时机或参数**：本机实现在原来回落发生的位置、用同一组参数构造；按请求构造的本机候选与冲突合并 effect 改为部署选择构造一次——它们不持有
  请求状态（每个用例自己开会话），等价。
- **单机推送丢了夹具会话**：夹具会话挂在本机 effect 工厂上，推送从工厂取；用例覆盖本机路径远端的推送。
- **按原文或按 AST 钉住旧形状的锁、共享测试助手盖掉用例的值**：RFC-524 / RFC-525 / RFC-526 的教训（`docs/dev-gotchas.md`）。
- **移走或删去后成为不可达文件、未消费符号**：架构报告对照。
- **整体写入替身与必填的内容工厂并存**：两者都给会被拒，进程中断预言的替身就无从使用——写入方改为二选一的联合类型，预言只给替身；用例钉住类型
  拒绝两者（`@ts-expect-error`）、运行期照旧拒绝未经检查的调用方。

## 6. 取舍（可推翻）

1. **进程内提交用例按 `option` 登记，不改作用域合同**：它们是模块自己的 application 用例，托管作用域在卷里跑的也是这一组用例；给每个作用域加一个“执行方
   式”成员只是把同一个判断换个写法。门的 `option` 类别正是“缺省一支是主路径、不是替身”。
2. **镜像的登记方式改为显式的 `kind`，而不是让本机镜像也实现远端登记**：本机的登记由批量导入自己克隆、刷新要读配置里的克隆时限，硬套成同一组方法会把
   配置读取搬进镜像；显式的 `kind` 与 RFC-526 启动配置的处理一致。
3. **本机候选 effect 工厂自带夹具会话**：夹具会话只对本机步骤有意义；挂在工厂上，单机选择与回落一支等价，绑定不再需要“没给工厂”这一支。
4. **工作区上传的写入方二选一，而不是让整体写入优先于内容工厂**：同时给两者自 RFC-370 起就被显式拒绝，静默的优先级会掩盖调用错误。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层只装配；单机选择经组合层交出，bootstrap 选择（镜像一支由 bootstrap 按部署选择显式选）。
- **C11**：public 不新增符号；四个 `select*` 的签名收紧，没有调用方的排除档案选择删去（未消费符号不升）。
- **C12**：RFC-527 用例覆盖全部生产文件里的同名选项与 bootstrap 的取用；RFC-521 门覆盖全部组合层。
- **C13**：计数不升，降的收紧到实测；适配器回落 19 → 0。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 1 项第七步（最后一步）：全部模块的组合层不再替调用方造适配器；S12 第 1 项点名的“把可空选择转回 `undefined`”在 bootstrap 里清零。
- **留下**：bootstrap 里的单机选择与维护 worker 的单机效果一并收进 `bootstrap/standalone.ts`（另立后继）；S12 第 3～6 项。

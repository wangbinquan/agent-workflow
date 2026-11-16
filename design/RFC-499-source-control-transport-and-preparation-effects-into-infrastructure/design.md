# RFC-499 设计：源代码管理的发布传输与仓库准备的 effect 实现归 infrastructure

## 1. 现状（HEAD `a0e2c551c`，源码实读）

source-control 组合层控制流（F13 口径，按语法树计数）实测 198 行，`composition/repositoryPublicationTransport.ts` 占 32 行、
`composition/repositoryPreparation.ts` 占 18 行；`composition-forbidden-import-files` 实测 14 个文件，含这两处的 `composition.ts` 与
`composition/repositoryPublicationTransport.ts`（都因 `node:fs` 的值 import）。

`composition/repositoryPublicationTransport.ts`，379 行：

- 第 1～4 行文件头注释；第 6～33 行 import：shared 的远端描述与端点解析，`@/auth/secretBox` 的类型与 `createSecretBoxFromKey`，
  `node:fs` 的 `readFileSync`，`node:path` 的 `isAbsolute` / `join`，`@/util/git` 的 `runGit`，本模块 application 的 `RepositoryGit` 类型与
  `RepositoryTransportCredentials`，`@/util/gitCredentialLease` 的三个函数与一个类型，本模块 ports 的凭据仓库类型，public 的会话 / 传输
  类型与端点发现参与方类型。
- 第 35～147 行私有辅助函数：`baseMatchesHost`、`isLocalRepositoryRemote`、`connectionMayOwnRemote`、`legacySession`、`sessionOf`、
  `usernameFor`、`discoverEndpointCandidate`。
- 第 149～353 行 `createRepositoryPublicationTransport(input)`：输入是凭据仓库、可选的 `secretBox`、appHome、可选的 `runGit` 与端点发现
  参与方；返回的 `open(request)` 选连接、发现端点、取凭据、复核连接代际、租凭据助手并交出会话。
- 第 355～379 行 `resolveRepositoryPublicationTransportFromKeyFile`：读 `appHome/secret.key` 建 `secretBox` 再建传输。全仓零调用方
  （全部包、`e2e`、`scripts` 与 `.github` 扫过），只经 `composition.ts` 第 34～37 行转出。`readFileSync`、`join` 与 `createSecretBoxFromKey`
  只在这里用。

`composition.ts`（345 行）：第 7 行的 `readFileSync`（`node:fs`）与第 8 行的 `createSecretBoxFromKey` 只为第 159～173 行的
`resolveRepositoryTransportCredentialsFromKeyFile`（读密钥文件建凭据供给），它全仓零调用方（RFC-321 锁只断言两处文件不含它）；第 8 行
同时取的 `SecretBox` 类型另有两处使用。第 34～37 行转出传输的两个函数。

`composition/repositoryPreparation.ts`，374 行：

- 第 1～42 行 import；第 44～55 行输入接口 `RepositoryPreparationInput`（taskPorts、db、appHome、可选的 secretBox、清理钩子、克隆时限与
  准备配置读取）。
- 第 57～83 行 `composeLocalRepositoryPreparationEffects`、第 85～90 行 `composeLocalScratchWorkspaceEffects`：本机准备与 scratch 的 effect
  工厂（包装 `infrastructure/local/` 的两个实现），与 `infrastructure/crewstation/repositoryPreparation.ts` 的
  `createHostedRepositoryPreparation` / `createHostedScratchWorkspaces` 并列，由部署选择交给 bootstrap（`standalone.ts` 选它们，
  `deploymentProfile.ts` 第 217～218 行的槽位以它们的 `typeof` 定型）。
- 第 92～374 行 `composeRepositoryPreparation(input)`：第 99～100 行建准备日志与准备参与方，第 101～104 行在没有交来 effect 时回落到上面两个
  本机工厂，第 105～373 行返回准备绑定（组名与成员、legacy 的回收 / 准备 / 提交 / 清理、scratch 的准备 / 恢复 / 清理 / 释放、来源封存、
  封存身份、启动快照、下一次尝试与 effect 绑定）。18 行控制流都在这些方法里。

使用方：

- 传输：`composition.ts` 的转出；bootstrap 的 `standalone.ts`（第 157 行把它放进部署选择）与 `deploymentProfile.ts`（第 215 行的槽位以它的
  `typeof` 定型）都经 `@/modules/source-control/composition` 取；用例 `rfc321-repository-publication-transport`、
  `rfc321-repository-publication-system-mock-e2e`、`rfc310-digital-employee-conflict-system-mock-e2e` 与 `rfc432-session-selection-factories`
  同样经 `composition.ts` 取。没有文件直接取 composition 的这个文件。
- 准备：26 个文件取 `composition/repositoryPreparation`——bootstrap 4 个（`daemonModules/taskExecution.ts` 取装配函数与输入接口，第
  266～270 行交部署选择建好的两组 effect；`maintenanceWorkerGraph.ts` 第 231～237 行交 `workerEffects?.workspaceMaintenance?.…`，可能为
  `undefined`，回落到本机；`standalone.ts` 与 `deploymentProfile.ts` 取两个本机工厂）、用例 22 个（21 个取装配函数，`rfc432` 取两个本机
  工厂）。

按路径或内容读这些文件的锁：

- `rfc321-repository-publication-ratchet` 第 375、464、526 行读传输文件的源码（断言凭据只在 git 发布里用、旧解析与带令牌 URL 不复活）；
  `rfc349-source-control-promise-contract` 第 23、85 行（中立文件不取 DB 句柄；传输取注入的凭据仓库）；`rfc376-structural-guards` 第
  174～175 行的 `composition-forbidden-import-files` 清单列着 `composition.ts` 与传输文件。这些断言的内容都在 `createRepositoryPublicationTransport`
  里，不涉及被删的函数。
- `rfc305-architecture-lock` 第 404 行：identity-access 的模块外引用清单列着准备文件取 `identity-access/public/participants`（类型
  `RequestAuthority`，启动快照用）。
- `rfc478-task-service-retirement` 第 405 行读准备文件，断言组名与成员两个方法用同一份组布局解析；`rfc447-repository-groups-into-source-control`
  第 161 行列 `application/repositoryGroups` 的 4 个引用方，含准备文件。
- `public/queries.ts` 第 8 行的注释以现在时写着“source-control 在 `composition/repositoryPreparation.ts` 实现 `groupCachedRepoIds`”。
- 账本：`counts.json` 的 `composition-control-flow-source-control`（max 198）与 `composition-forbidden-import-files`（max 14）。
  `architecture/commons-debt.json`、RFC-310 的 OS 依赖清单都没有这三个文件的条目。`design/` 里提到它们的是 RFC-294、RFC-321、RFC-370、
  RFC-432、RFC-447、RFC-478 等的记述（当时的锚点）。

## 2. 机制与落位

### D1 发布传输归 infrastructure

传输按远端选连接、租 git 凭据助手、跑 git，是 source-control 的出站适配器，按 RFC-294 design 的依赖表属 infrastructure（本模块 ports 与
平台、vendor 库）。新文件 `infrastructure/repositoryPublicationTransport.ts`：

- 第 1～353 行原样迁入（文件头注释、私有辅助函数与 `createRepositoryPublicationTransport`），名字与函数体逐字不变；import 按新目录改写
  （`../application/…`、`../ports/…`、`../public/…` 不变，因为同在模块根下一层），去掉只为被删函数服务的 `readFileSync`、`join` 与
  `createSecretBoxFromKey`。
- 删除 `composition/repositoryPublicationTransport.ts`；`composition.ts` 第 34～37 行改为
  `export { createRepositoryPublicationTransport } from './infrastructure/repositoryPublicationTransport'`。bootstrap 与用例照旧经
  `composition.ts` 取（bootstrap 不深引用模块 infrastructure）。

传输里按 `secretBox` 建 application 的 `RepositoryTransportCredentials`（`new RepositoryTransportCredentials(repository, secretBox)`）照旧：
它的输入形状就是部署选择合同的槽位（`deploymentProfile.ts` 第 215 行以 `typeof createRepositoryPublicationTransport` 定型，
`daemonModules/repositoryCredentials.ts` 第 56 行调用），改成注入凭据供给属于 S12 第 6 项把槽位改为语义端口的范围；source-control 的
infrastructure 取本模块 application 的值另有先例（`infrastructure/repositoryPreparationParticipant.ts` 取 `prepareRepositoryWorkspace`）。

### D2 仓库准备的 effect 实现归 infrastructure

- **本机 effect 工厂**：第 44～90 行（输入接口与两个本机工厂）原样迁入 `infrastructure/local/repositoryPreparation.ts`，与
  `infrastructure/crewstation/repositoryPreparation.ts` 的托管实现成对；名字不变，import 按新目录改写。
- **准备绑定**：第 92～374 行原样迁入 `infrastructure/repositoryPreparationBridge.ts`，函数名改为 `createRepositoryPreparationBridge`
  （`composeRepositoryPreparation` 留给装配），文档注释与函数体逐字，只改输入与第 101～104 行：两组 effect 改为必填（输入是本机文件的
  `RepositoryPreparationInput` 加必填的 `preparationEffects` / `scratchEffects`），两个常量 `scratch` / `preparationEffects` 直接取输入、
  不再回落。
- **装配**：`composition/repositoryPreparation.ts` 只留装配函数（输入类型不变，两组 effect 可选）与对本机文件三个名字
  （`composeLocalRepositoryPreparationEffects`、`composeLocalScratchWorkspaceEffects`、类型 `RepositoryPreparationInput`）的转出：

  ```ts
  export function composeRepositoryPreparation(input: RepositoryPreparationInput & { … }) {
    return createRepositoryPreparationBridge({
      ...input,
      scratchEffects: input.scratchEffects ?? composeLocalScratchWorkspaceEffects(input),
      preparationEffects: input.preparationEffects ?? composeLocalRepositoryPreparationEffects(input),
    })
  }
  ```

  26 个使用方都不改。

回落留在 composition：它正是 S12 第 1 项要改为必填注入的写法（“模块 composition 的 `select*` 助手与适配器回退”，退出门是 composition 里
没有回落到适配器工厂的 `??`）；搬进 infrastructure 会让 S12 的锁看不见它。

次序：此前回落发生在建日志与参与方之后，现在在之前。两者的构造都是纯的（`createRepositoryPreparationJournal` 只返回一组方法，
`composeRepositoryPreparationParticipant` 只建 WeakSet / WeakMap / Map），没有可观察的差别；交来 effect 的调用方（daemon）次序不变。

### D3 删除零调用方的密钥文件解析

`resolveRepositoryPublicationTransportFromKeyFile`（传输文件第 355～379 行）与 `resolveRepositoryTransportCredentialsFromKeyFile`
（`composition.ts` 第 159～173 行）全仓零调用方，删除，不迁。`composition.ts` 去掉第 7 行的 `node:fs` 与 `createSecretBoxFromKey`（第 8 行
改为只取 `SecretBox` 类型），由此不再在 `composition-forbidden-import-files` 里。

### D4 锁、账本与清单

- `rfc321-repository-publication-ratchet`、`rfc349-source-control-promise-contract`：传输文件的路径改指新文件，断言不变。
- `rfc376-structural-guards`：`composition-forbidden-import-files` 清单删去 `composition.ts` 与传输文件两条。
- `rfc305-architecture-lock`：identity-access 模块外引用清单里准备文件那条改为准备绑定的新文件（按排序挪位）。
- `rfc478-task-service-retirement` 读准备绑定的新文件（断言的两段源码随函数体逐字迁入，缩进不变）；`rfc447-repository-groups-into-source-control`
  的引用方清单把准备文件换成准备绑定的新文件。
- `public/queries.ts` 第 8 行注释的路径改为准备绑定的新文件。
- `architecture/counts.json`：`composition-control-flow-source-control` 198 → 实测（预计 148），`composition-forbidden-import-files`
  14 → 实测（预计 12）。
- `guard-manifest.json` 登记 RFC-499 用例。
- 不改：没有其他锁或账本按路径读这三个文件；`design/` 里的历史记述不改。

## 3. 清单（退出门）

- **`infrastructure/repositoryPublicationTransport.ts`**：交出 `createRepositoryPublicationTransport`；模块内私有：`baseMatchesHost`、
  `isLocalRepositoryRemote`、`connectionMayOwnRemote`、`legacySession`、`sessionOf`、`usernameFor`、`discoverEndpointCandidate`。
- **`infrastructure/local/repositoryPreparation.ts`**：交出 `RepositoryPreparationInput`、`composeLocalRepositoryPreparationEffects`、
  `composeLocalScratchWorkspaceEffects`。
- **`infrastructure/repositoryPreparationBridge.ts`**：交出 `createRepositoryPreparationBridge`。
- **`composition/repositoryPreparation.ts`**：交出 `composeRepositoryPreparation`，转出上面本机文件的三个名字。

这些名字在全部生产文件里没有别的顶层同名声明，只有 `sessionOf` 另在 intent 的 `infrastructure/intentSqlPersistence.ts` 有一个无关的私有
同名函数（逐个钉住）。`resolveRepositoryPublicationTransportFromKeyFile`、
`resolveRepositoryTransportCredentialsFromKeyFile` 在全部生产文件、用例与 e2e 里不再声明、import 或调用。

允许的形状：`composition/repositoryPublicationTransport.ts` 不存在；`composition.ts` 从新文件只转出 `createRepositoryPublicationTransport`，
不取 `node:fs`；`composition/repositoryPreparation.ts` 没有控制流语句，装配函数恰好一次调用 `createRepositoryPreparationBridge`，交出的
对象是 `...input` 加两组 effect，各恰好一处回落到对应的本机工厂。

## 4. 用例

新增 `packages/backend/tests/rfc499-source-control-transport-and-preparation-into-infrastructure-boundary.test.ts`（文件名带 `boundary`），
登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）里只在清单列的文件声明；两个被删的函数在全部生产文件、用例（下限 2,500）与 e2e 里没有
  声明、import 与调用，带负对照。
- ② 传输：`composition/repositoryPublicationTransport.ts` 不存在；`composition.ts` 从新文件只转出 `createRepositoryPublicationTransport`、
  不取 `node:fs`；全部生产文件、用例与 e2e 不从旧位置取名字（命名 import、type-only、re-export、命名空间成员与动态 import 的解构都认），
  带负对照。
- ③ 准备：`composition/repositoryPreparation.ts` 只声明装配函数、只转出本机文件的三个名字，没有控制流语句；装配函数恰好一次调用
  `createRepositoryPreparationBridge`，交出的对象恰好是 `...input` 与两组 effect、各一处回落到对应的本机工厂；准备绑定的输入要求两组
  effect（不可选）、文件里不出现本机工厂；带负对照。
- ④ 三个新文件不取 composition（`composition/required-ports` 的类型除外）；传输不取 `node:fs`；带负对照。

行为由现有用例对拍：传输——`rfc321-repository-publication-transport`、`rfc321-repository-publication-system-mock-e2e`、
`rfc310-digital-employee-conflict-system-mock-e2e`、`rfc432-session-selection-factories`；准备——经装配函数建绑定的 21 个用例与夹具
（`rfc363-task-preparation-admission`、`rfc370-repository-preparation-effects`、`rfc370-scratch-workspace-effects`、
`rfc349-repository-preparation-postgresql-adapter`、`rfc287-t13-deferred-prep`、`rfc362-launch-contracts`、真进程的
`rfc363-task-workspace-crash-worker` 等）与取本机工厂的 `rfc432`。

## 5. 失败模式

- **回落走样**：装配函数交的是同一个 `input` 加两组 effect；回落的判据与本机工厂的入参逐字不变；用例 ③ 钉住形状。
- **构造次序**：见 D2，日志与参与方的构造是纯的。
- **遗留引用**：删除文件与函数后由 `tsc` 与 RFC-499 用例 ①② 覆盖；迁移后按文件名（含路径片段）与代码里的字符串字面量全仓再扫。
- **锁静默变空**：按路径读这些文件的锁都改指新文件，读不到文件时它们会报错而不是变空；全仓再扫同样覆盖。

## 6. 取舍（可推翻）

1. **传输整份迁走、不留转手文件**：唯一的转出方 `composition.ts` 直接指向新文件；留一个只转手的 composition 文件既不装配什么，又让 S10
   点名的文件继续留在 `composition/`。
2. **零调用方的函数删除，不迁**：删除优于迁移后再弃用；`composition.ts` 由此离开 `composition-forbidden-import-files`。
3. **准备的回落留在 composition**：把回落搬进 infrastructure 会把 S12 第 1 项的清理对象藏到它的锁之外；装配文件随 S10 收口与 S12 一并
   处理（并入模块装配或改名，回落改为必填注入）。
4. **准备绑定拆成本机 effect 与绑定两个文件**：本机文件与 `infrastructure/crewstation/repositoryPreparation.ts` 成对；绑定不分本机与托管，
   落 infrastructure 根下（同目录已有准备日志与准备参与方）。
5. **绑定的函数改名**：`composeRepositoryPreparation` 留给装配、使用方不改；infrastructure 一侧按 `create<Name>` 命名。
6. **传输的输入形状与内部建凭据供给不改**：它是部署选择合同的槽位，随 S12 第 6 项处理。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是 effect 实现（发布传输、本机准备与 scratch 的 effect 工厂）与把日志、参与方和 effect 接成准备绑定的适配器，落
  infrastructure；composition 只留回落选择与建绑定；不新增用例入口。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-499 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明、被删函数与旧位置的 import，另读 `composition.ts`、装配文件与三个
  新文件；只对这些范围宣告退出门。
- **C13**：`composition-control-flow-source-control` 与 `composition-forbidden-import-files` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 source-control 的第一步——点名的两个文件的 effect 实现归 infrastructure，`repositoryPublicationTransport.ts` 离开
  `composition/`；组合层控制流 198 → 实测；`composition-forbidden-import-files` 14 → 实测。
- **留下**：
  - `composition/repositoryPreparation.ts` 只剩装配（含两处本机回落）：S10 收口时并入模块装配或改名，回落随 S12 第 1 项改为必填注入；
    `deploymentProfile.ts` 以 `typeof` 本机工厂定型的两个槽位与传输的槽位随 S12 第 6 项改为语义端口，传输内部建凭据供给随之改为注入。
  - source-control 其余组合文件的控制流（`repositoryCandidate.ts`、`repositoryMirrors.ts` 各 11 行等）；`taskImage*` / `crewstation*` 待
    RFC-370 余项；`composition-forbidden-import-files` 余下的 12 个都是 `taskImage*` / `crewstation*` 一族。
  - `composition.ts` 的模块级缓存与连接投影的收敛，随 S10 收口与 S12 处理。

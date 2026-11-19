# RFC-512 源码控制的已登记仓库读取与远端登记用例迁出 composition（RFC-294 S10 第十九步）

- **状态**：In Progress（2026-11-19）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推进RFC294」：本会话按
  2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。
  设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）。
- **前序**：[RFC-511](../RFC-511-source-control-port-completeness-checks-out-of-composition/proposal.md)（S10 第十八步）：source-control 组合层
  的端口完整性核对已迁出。本 RFC 把同一组合层里余下的一个用例——`composition/repositoryMirrors.ts` 的已登记仓库读取与远端登记（RFC-370 §10
  V17）——迁入 application；装配入口 `composeRepositoryMirrors` 的名字、入参、返回形状与位置不变；不碰 `crewstation*` / `taskImage*`（RFC-370
  余项）。

## 1. 背景

source-control 组合层控制流（F13 口径）在 RFC-511 之后是 120 行：RFC-370 的 `crewstation*` / `taskImage*` 101 行，其余 19 行里 8 行是装配期选择，
11 行在 `composition/repositoryMirrors.ts`。这个文件的装配入口里内联了一整个用例：

- 按 id 读已登记仓库，找不到抛 `cached-repo-not-found`；
- 单机：在镜像目录上读分支、标签与文件，把读失败的领域错误改写成按仓库 id 命名的错误（线上不带镜像的本机路径）；
- 托管：拆出已登记仓库的远端地址（拆不开抛 `repo-url-unavailable`），远端核验通过后记下默认分支与抓取时间并作废仓库切面缓存；登记新地址
  （地址不合法抛 `repo-url-invalid`，先核验远端、再记同一身份行）与刷新已登记仓库（再核验一次，返回刷新后的投影）。

这些是用例，不是装配；它们的 effect（仓库存储、URL 拆封、镜像缓存的身份行与切面缓存、镜像目录上的 git 读取、远端核验）各有实现。

## 2. 目标

- **G1 用例归 application**：上面的用例迁入新的 `application/repositoryMirrors.ts`（单机与托管各一个工厂），判据、错误类型、错误串、错误详情与
  调用次序逐项不变；它需要的镜像缓存操作以端口接口声明在 `application/ports/repositoryMirrors.ts`。
- **G2 composition 只装配**：`composeRepositoryMirrors` 只做“有没有托管远端”的选择，并把基础设施实现（镜像目录读取、已登记目录的读取、URL
  拆封、身份行、切面缓存作废、投影）交给两个工厂；这 11 行里 10 行离开组合层，余下的 1 行是这次选择。
- **G3 账本与锁**：`composition-control-flow-source-control` 120 → 实测（预计 110）；钉着这个文件的用例仍通过；新增 RFC-512 用例。

## 3. 非目标

- source-control 组合层其余的装配期选择（8 行）；`crewstation*` / `taskImage*`（RFC-370 余项）；其余模块。
- 改写任何判据、错误类型、错误串与详情；任何行为变化、接口与界面；镜像缓存与远端核验本身的实现。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的位置声明；`composition/repositoryMirrors.ts` 不再有用例代码（只剩一处选择），装配入口的名字、入参与
  返回形状不变。
- **AC-2**：同样输入下，单机与托管两种装配的每个操作返回相同的结果、抛出相同的错误（类型、错误码、文案、状态与详情），effect 的调用次序不变。
- **AC-3**：新位置的依赖面是闭集：只取本模块的端口、`@agent-workflow/shared` 的地址解析与 `@/util` 的错误与散列，不取 infrastructure、
  composition、bootstrap、`@/services` 与其他模块，不用进程全局（时钟由装配注入）；public surface 不升；`composition-control-flow-source-control`
  收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

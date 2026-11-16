# RFC-499 源代码管理的发布传输与仓库准备的 effect 实现归 infrastructure（RFC-294 S10 第六步）

- **状态**：In Progress（2026-11-16）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  S10 的范围点名 source-control“`repositoryPublicationTransport.ts`、`repositoryPreparation.ts` 的 effect 实现归 infrastructure”与
  “`composition-forbidden-import-files` 14 → 0”，退出门要求“上面点名的文件不再位于 `composition/`”；proposal D16、review-2026-11-09
  R11 / F13。
- **前序**：[RFC-498](../RFC-498-development-graph-delivery-bridge-out-of-composition/proposal.md)（S10 第五步，Done，`1aafddf1c`）。
  S10 与 S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只动 source-control 的 `composition/repositoryPublicationTransport.ts`
  （删除）、`composition/repositoryPreparation.ts`（只留装配）与 `composition.ts`（一条转出改指新文件，删去一个零调用方的函数），不碰
  `taskImage*` / `crewstation*`（RFC-370 余项）。

## 1. 背景

development-automation 一侧 S10 点名的文件已由 RFC-494～498 处理。source-control 的组合层控制流（F13 口径，按语法树计数）实测 198 行：
`taskImage*` 一族 99 行（RFC-370 余项，逐个避让），`repositoryPublicationTransport.ts` 32 行，`repositoryPreparation.ts` 18 行，其余 12 个
文件共 49 行。`composition-forbidden-import-files` 的 14 个文件里有 source-control 的 6 个，其中两个与本 RFC 有关：

- `composition/repositoryPublicationTransport.ts`（379 行）是 RFC-321 的仓库发布传输：按远端选代码托管连接、必要时经 provider 元数据发现
  端点、取执行凭据、租 git 凭据助手，交出只带网络执行闭包的发布会话——整份是 effect 实现。它取 `node:fs`，只为文件末尾按密钥文件建
  传输的 `resolveRepositoryPublicationTransportFromKeyFile`，而这个函数全仓零调用方（只经 `composition.ts` 转出）。
- `composition.ts` 取 `node:fs`，只为 `resolveRepositoryTransportCredentialsFromKeyFile`，同样全仓零调用方。
- `composition/repositoryPreparation.ts`（374 行）有两部分：本机准备与 scratch 的 effect 工厂（`composeLocalRepositoryPreparationEffects` /
  `composeLocalScratchWorkspaceEffects`，与 `infrastructure/crewstation/repositoryPreparation.ts` 的托管实现并列，由部署选择交给 bootstrap）
  和 `composeRepositoryPreparation`——把准备日志、准备参与方与两组 effect 组装成 task-execution 用的准备绑定。18 行控制流都在后者返回的
  方法里（读写准备日志、编解码准备回执、在 effect 前后复核当前性）。

## 2. 目标

- **G1 发布传输归 infrastructure**：`createRepositoryPublicationTransport` 连同它的私有辅助函数原样迁入
  `infrastructure/repositoryPublicationTransport.ts`；`composition.ts` 的转出改指新文件；composition 的这个文件删除。
- **G2 仓库准备的 effect 实现归 infrastructure**：本机准备与 scratch 的 effect 工厂连同输入接口原样迁入
  `infrastructure/local/repositoryPreparation.ts`；准备绑定的实现原样迁入 `infrastructure/repositoryPreparationBridge.ts`
  （`createRepositoryPreparationBridge`，两组 effect 改为必填）。`composition/repositoryPreparation.ts` 只留装配：没有交来 effect 时选本机
  实现（S12 要清理的回退，留在 composition 由 S12 的锁看见）并建绑定，另外转出本机选择与输入接口，使用方不改。
- **G3 删除零调用方的密钥文件解析**：`resolveRepositoryPublicationTransportFromKeyFile` 与 `resolveRepositoryTransportCredentialsFromKeyFile`
  删除，`composition.ts` 不再取 `node:fs`。
- **G4 账本与锁**：`composition-control-flow-source-control` 与 `composition-forbidden-import-files` 按实测收紧；按路径读这些文件的锁改指
  新位置；新增 RFC-499 用例。

## 3. 非目标

- `taskImage*` / `crewstation*` 一族（RFC-370 余项）；source-control composition 的其余文件；`composition.ts` 的其余内容（模块级缓存、
  连接投影的收敛等，随 S10 收口与 S12 处理）。
- 准备绑定的本机回退（`?? composeLocal…`）与部署选择合同里以 `typeof` 本机工厂定型的槽位（S12 第 1、6 项）；发布传输的输入形状（部署
  选择合同的槽位）。
- 拆分或改写发布传输与准备绑定；任何行为变化、接口、错误码与界面。

## 4. 用户可见变化

无。删除的两个函数全仓零调用方，不收缩任何能力。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在清单列的文件声明；`composition/repositoryPublicationTransport.ts` 不存在，没有文件从旧位置取名字；
  `composition.ts` 从新文件转出 `createRepositoryPublicationTransport`、不取 `node:fs`；两个被删的函数在全部生产文件、用例与 e2e 里
  没有声明、import 与调用；`composition/repositoryPreparation.ts` 只有装配函数（恰好一次建绑定、恰好两处本机回退）与对本机选择的转出，
  没有控制流语句。
- **AC-2**：同样输入下，发布会话的打开结果、错误码与 git 调用，准备绑定各方法的返回、错误码、持久化与 effect 调用的次序和参数和此前
  一致（迁移逐字，现有用例对拍）。
- **AC-3**：新文件不取 composition（`composition/required-ports` 的类型除外，与同目录既有 infrastructure 文件一致）；跨 context 边、
  public surface 不升；`composition-control-flow-source-control` 与 `composition-forbidden-import-files` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

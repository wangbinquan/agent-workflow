# RFC-520 资源包装配共用一个模块工厂（RFC-294 S12 第一步）

- **状态**：In Progress（2026-11-19）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 2 项。
- **前序**：S10 已关闭（[RFC-519](../RFC-519-hosted-implementations-out-of-composition-2/proposal.md)：全部模块的组合层只装配）。S12 第 2 项
  要求 CLI 命令根与 daemon HTTP 装配不再并行手写同一张工厂图，plan 已核实的一处是资源包 provider / catalog。

## 1. 背景

资源包的装配图在两处逐件手写、结构相同：

- `bootstrap/commandBootstraps.ts` 的 `composePackageCommandBootstrap`（`agent-workflow package` 命令）；
- `bootstrap/daemonHttpComposition.ts` 的 `composeResourcePackageBinding`（daemon 的资源包路由）。

两处都建一张“授权 → 行为人”的弱引用表与按它解析的授权解析器（不认识的授权抛 `foreign-resource-package-authority`），再依次装 provider、原子
apply 与带执行适配器的 catalog；差别只在输入：MCP 事务生命周期从哪来、插件走本机安装器还是托管工件属主。按 bootstrap 全文比对 CLI 命令根与
daemon 调用的模块工厂，其余共用的都已经是同一个模块工厂（身份访问运行时、用户操作、MCP 事务生命周期、诊断），没有第二处并行手写的装配图。

## 2. 目标

- **G1 一个模块工厂**：resource-catalog 新增 `composeResourcePackageRuntime`，装出 provider、原子 apply、catalog 与授权登记；授权登记（弱引
  用表与解析器）归 application。
- **G2 两处共用**：CLI 包命令与 daemon 的资源包绑定都调这一个工厂，各自在交出上下文时登记行为人；行为不变。
- **G3 锁**：两处 bootstrap 不再自己调四个资源包工厂；新增 RFC-520 用例；钉着旧装配原文的锁改钉新位置。

## 3. 非目标

- S12 的其余各项（适配器工厂回落、导入期单例、模块级可变单例、直接定时器、按本地工厂签名定型的槽位）；改动 provider / catalog 工厂本身；任何
  行为变化、接口与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`bootstrap/commandBootstraps.ts` 与 `bootstrap/daemonHttpComposition.ts` 不再调用
  `composePostgresqlResourcePackageProvider`、`composePostgresqlResourcePackageCatalog`、`createPostgresqlResourcePackageExecutionAdapter`
  与 `createResourcePackageAtomicApplyOperations`，改调 `composeResourcePackageRuntime`；生产代码里这四个工厂只在 resource-catalog 内被调
  用。
- **AC-2**：同样输入下，两处得到的 catalog 与原子 apply 行为不变；未登记的授权仍以原错误拒绝，登记过的授权解析出同一个行为人。
- **AC-3**：授权登记落 application，组合层没有循环、`try` 与 `throw`（RFC-515 门照旧全绿）；public surface 不升；计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

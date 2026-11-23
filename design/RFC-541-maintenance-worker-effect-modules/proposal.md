# RFC-541 维护 Worker 的效果模块由各自的 Worker 入口交给运行时（RFC-294 S12 第二十二步）

- **状态**：Done（2026-11-22，落地 `896fc990a`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 4 项（模块级可变单例）的第九步；
  design §3 常驻规则 5、§14“模块级可变单例（生产态，bootstrap 外）0”。
- **前序**：[RFC-540](../RFC-540-sqlite-logical-source-worker-state/proposal.md)（S12 第二十一步：SQLite 逻辑源 Worker 的状态归每个 Worker 的处理器）。

## 1. 背景

维护 Worker 在初始化时按描述符里的模块名加载部署的效果模块（RFC-370 §9.2 V9）：平台 Worker 不 import 部署或业务模块，托管部署另有一个
Worker 入口（`bootstrap/maintenanceWorkerEntry.ts`），在第一条 init 消息到达前把 `aw:crewstation-maintenance` 登记进一张模块级表
（`platform/background/maintenanceWorkerEffects.ts` 的 `effectModules` 与 `registerMaintenanceWorkerEffectModule`），再 import 共用的 Worker 根；
加载时先查表、查不到按模块名 import。登记是写进程（Worker 线程）级状态的副作用，入口与根之间靠 import 顺序配合。架构报告的模块级可变单例
清单里这一文件 1 条（全仓 51 条）。

## 2. 目标

- **G1 加载器由入口交给运行时**：删去模块级表与登记函数；每个 Worker 入口都是一个薄根，把自己的效果加载器经 `openEffectsScope` 交给运行时——
  单机根按模块名 import，托管根把 `aw:crewstation-maintenance` 映射到 CrewStation 的效果模块、其余按模块名 import。
- **G2 结局不变**：两种部署的维护 Worker 加载的模块、导出名校验、能力校验与生命周期不变；监工按描述符选入口的规则与单二进制的入口清单不变。
- **G3 门与用例**：新增 RFC-541 用例（平台效果文件没有模块级状态与登记函数；两个入口各是一个薄根、只调一次运行时；托管根的加载器映射
  符号名、其余照常 import；带负对照）；读旧形状的用例与锁随改；模块级可变单例清单 51 → 50。

## 3. 非目标

- 其余 50 条模块级可变单例。
- 维护 Worker 的协议、监工、效果描述符与两种部署的效果实现不变。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`maintenanceWorkerEffects.ts` 没有模块级表与登记函数；两个 Worker 入口各自把效果加载器交给运行时。
- **AC-2**：两种部署的维护 Worker 加载的效果模块与结局不变。
- **AC-3**：模块级可变单例清单 51 → 50，计数不升；钉住旧形状的锁随改，新增 RFC-541 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

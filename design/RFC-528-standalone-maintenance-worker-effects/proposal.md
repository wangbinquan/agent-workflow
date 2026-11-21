# RFC-528 维护 worker 的单机效果收进单机 profile（RFC-294 S12 第九步）

- **状态**：In Progress（2026-11-21）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 1 项的余项：单机默认值只在单机
  profile（design §14“模块 composition 的适配器回退”一行）。
- **前序**：[RFC-527](../RFC-527-source-control-required-selections/proposal.md)（S12 第八步）清零了组合层的适配器回落。RFC-523、RFC-525、
  RFC-526 与 RFC-527 把单机维护 worker 一直由回落造的效果逐项改为在 `bootstrap/maintenanceWorkerGraph.ts` 里显式给出，并约定整体收成一份
  另立后继——本 RFC。

## 1. 背景

维护 worker 是单独的线程，它的效果由 RFC-399 的描述符协议选择：托管 profile 给一个描述符（`composeCrewStationMaintenanceDescriptor`，
worker 线程按它加载托管效果模块、取描述符列出的效果族），单机 profile 给 `null`，worker 拿到的效果是“没有”。于是
`maintenanceWorkerGraph.ts` 逐项回落：内容存储、任务归档内容、资源包工件恢复、工作区准备 / 草稿区 / 维护文件系统、插件代际回收、
intent 的草稿区与工件内容，共 7 族、9 处本机构造，分散在图与两个数据库适配器里；内容维护还按内容存储的外部类型缺省为本机文件。

单机 worker 的这些默认值因此不在单机 profile 里，而在 worker 的装配图里逐项决定；托管描述符少列一族时，worker 会不声不响地用本机实现。

## 2. 目标

- **G1 单机 profile 的 worker 部分**：新增 `bootstrap/standaloneMaintenanceWorker.ts`，按族给出单机 worker 的全部本机效果（同一组工厂、同一组
  参数，建在 worker 自己的数据库客户端上）。它与 `bootstrap/standalone.ts` 一起构成单机 profile；worker 线程不加载 daemon 的 profile 模块。
- **G2 一次选择**：worker 在打开数据库后选一次——每族取描述符给的，没给的取单机 profile 的（只在要用时构造）——装配图只读选好的完整效果，
  不再出现本机构造与逐项回落；托管独有的四族照旧“没给就是没有”。
- **G3 门与用例**：生产的托管描述符列全每个有单机对应的族（用例钉住），托管不会混入本机实现；钉旧位置的锁随改；新增 RFC-528 用例。

## 3. 非目标

- daemon 一侧按托管能力是否为 `null` 选本机实现的几处（仓库镜像、数据库安装、子仓刷新）：它们随部署选择合同改为“每模块一份类型化的
  适配器集合”（S12 第 6 项）一并处理。
- S12 的第 3～5 项；描述符协议本身；任何行为、接口与界面变化。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`maintenanceWorkerGraph.ts` 不再构造本机效果、不再逐项回落；单机 worker 的本机效果只在 `bootstrap/standaloneMaintenanceWorker.ts`
  给出，选择只在一处发生。
- **AC-2**：单机 worker、托管 worker 与用例里部分描述符得到的对象与此前相同（同一组工厂、同一组参数、同样的构造时机；托管不构造本机实现）；
  资源包恢复两项同时选照旧被拒。
- **AC-3**：生产的托管描述符列全有单机对应的族；worker 线程不加载 `bootstrap/standalone.ts`；计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

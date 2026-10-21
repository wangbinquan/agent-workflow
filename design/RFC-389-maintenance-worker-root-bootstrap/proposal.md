# RFC-389 维护 Worker 根迁入 bootstrap：线程内一张中立图（RFC-294 S2b）

- **状态**：Done（2026-10-21：`2b2919cee`，主 CI `39595529570` success，windows-platform `39595529681` success。实施时两处偏离：图工厂
  端口增加 `registerConnectionClose`（图构造中途失败仍能关库，保持原行为）；部署分支计数只按精确语法形状识别纯入口路径常量模块，
  未抬上限。用户 2026-10-20「按你推荐继续推进」：由本会话设计、交 Codex 实施并审核，免设计门与实现门；规则取舍见 §6）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2b「Worker 根迁出 `platform/`」）、
  review-2026-10-16 F4
- **基线**：HEAD `3450e6872`（研究基线；行号仅作定位提示，以实施时源码为准）
- **落位**：bootstrap（维护 Worker 线程的薄入口根与线程内模块图）；platform/background（Worker 机制）

## 1. 背景

S2b 原定的最后一项（SQLite HTTP 装配、删除测试回退、Worker 根迁出 platform）经 2026-10-21 只读研究拆开：Worker 根与另外两项改的
文件几乎不重叠，单独立为本 RFC；中立 HTTP 绑定、中立应用图、删除测试回退依赖 RFC-388 之后的代码，顺延为 RFC-390～392。

维护 Worker 是 RFC-294 所说的「Worker 线程」入口根，却住在 `platform/background/maintenanceWorker.ts`（953 行）。这个文件里有两类东西：

- **Worker 机制**：消息路由，初始化 / 排空 / 关停，租约心跳，队列循环与退避，语句计时与切片诊断。
- **组合**：按 provider 分两支，各装一套维护模块图（PostgreSQL :598-719，SQLite :720-844）。它值导入 8 个 context 的 composition 子文件、
  `intent/application/turnEngine` 的一个常量，以及两个 task-execution `application/ports` 类型。

RFC-294 对它的规定：

- platform 不得依赖任何 `modules/`（design.md:108）；
- 入口根归 bootstrap，只做参数解析、profile 选择、调用工厂图（design.md:83、:497-500）；
- SQLite / PostgreSQL 是图内的适配器选择，不是两份装配（design.md:504-505）；
- review F4 的处置即「Worker 根迁入 bootstrap」（review-2026-10-16.md:265-273）。

两支实测只有五处差异：

1. 开库与关库：PostgreSQL 用专用小连接池并接托管写围栏；SQLite 用 `openDb`，并挂语句 / 事务计时观察器。
2. 事件归档存储。
3. 存储维护：PostgreSQL 走运维适配器，SQLite 做 WAL checkpoint。
4. 资源包维护：两个 provider 命名的组合函数。
5. 退避计数键。

其余十一个所有者命令是同一工厂、只差 db 句柄；保留期切片两支已是同一实现（RFC-359 W57）。

监督器（platform）写死了默认入口 `./platform/background/maintenanceWorker.ts`（`maintenanceWorkerSupervisor.ts:106-112`）；托管入口由
`bootstrap/crewstationMaintenance.ts:63-76` 经效果描述符另给。

## 2. 目标

- **G1 Worker 根在 bootstrap**：`bootstrap/` 下的 Worker 入口只做初始化请求解析与 provider 选择，并调用 bootstrap 的线程内工厂图；
  托管入口（`bootstrap/maintenanceWorkerEntry.ts`）注册效果后加载同一个根。
- **G2 线程内一张中立图**：十一个所有者命令各构造一次、不分 provider；provider 差异只经一张适配表进入（开库与关库、事件归档存储、
  存储维护、资源包维护、计数键）。
- **G3 机制留在 platform**：消息路由、初始化 / 排空 / 关停、心跳、队列循环、退避、计时与切片诊断成为 platform 的 Worker 运行时。它经
  端口接收「图工厂」，不导入任何 `modules/`。保留期 / 存储 / 事件归档的系统维护胶水成为 platform 的中立工厂。
- **G4 入口路径由组合方给出**：platform 监督器不再写死任何入口；独立部署的入口路径由 bootstrap 的无副作用模块给出（编译态 / 源码态
  两种写法同现状），两个会话显式传入；托管入口不变。
- **G5 账本**：`platform-to-modules-file-pairs` 49 → 30，上限随之压到 30；Worker 的三条 R1 随之消失或改指；新结构锁登记。

## 3. 非目标

- `maintenanceJobRunner.ts`、`maintenanceWorkerEffects.ts` 的模块类型导入（S5）。
- 资源包维护两个 provider 命名组合函数的合一（resource-catalog 内部）。
- 主线程维护服务 / 监督器的行为、协议版本、目录摘要、作业集合与调度。
- 合并独立 / 托管两个 Worker 入口（S2c 部署 profile）。
- 任何 HTTP / 应用图改动（RFC-390～392）。
- 安全相关改动。

## 4. 用户可见变化

无。发布二进制里 Worker 的入口路径变了，构建清单同步，并由真编译探针锁定。

## 5. 验收标准

- **AC-1 落位**：platform/background 下没有 Worker 组合根；Worker 根与线程内图在 bootstrap，并登记到 `BOOTSTRAP_FILES`、构建的
  `WORKER_ENTRIES` 与架构的 `BINARY_ENTRIES`；platform 源码不出现 bootstrap 路径；主线程不导入 Worker 根。
- **AC-2 一张图**：线程内每个所有者命令工厂恰好调用一次，provider 差异只在适配表（结构锁）。
- **AC-3 行为不变**：现有维护 Worker 双引擎用例（启动 / 排空、效果、真实效果、编译态入口探针）全部通过，不改断言意图；新增中立图的
  双引擎用例。
- **AC-4 账本**：`platform-to-modules-file-pairs` 实测 30、上限 30；commons-debt 双向精确；`architecture/counts.json` 其余不升。
- **AC-5 CI 全绿**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **拆而不是整搬**：整文件搬进 bootstrap 会把计时器、退避与状态机带进 bootstrap，违背「bootstrap 只装配」。所以拆成 platform
   运行时 + bootstrap 薄根与图。
2. **线程内两支同批合成一张图**：差异只有五处，适配表即可承载；不合并的话，S2 退出门「不存在 provider 专属装配函数」在 Worker
   里仍不满足。
3. **保留两个 Worker 入口（独立 / 托管）**：合并属 S2c 部署 profile。
4. **`maintenanceJobRunner.ts` / `maintenanceWorkerEffects.ts` 留在 platform**：它们被 platform 的监督器与协议导入，移入 bootstrap
   会形成 platform → bootstrap 依赖；其模块类型导入留给 S5。
5. **上限随实测下调**：锁住进展（只降不升）。
6. **托管的 `objectPublications` 在中立图里对两个 provider 都透传**：SQLite 根拒绝托管选择，实际只有 PostgreSQL 有值（实施时核实
   并报告）。
7. **偏离项**：无。

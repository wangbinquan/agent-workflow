# RFC-370 独立功能评审记录

2026-10-01。按 `CLAUDE.md` 的双门及 `docs/dev-gotchas.md` 的独立子代理备选执行；openai-codex 插件工具本会话未提供。评审均在既有 primary checkout/main 按精确路径只读完成，未创建隔离 checkout，未运行本机 AW 测试、类型检查、构建或服务。仅审功能；正式行为、完整 A-G 和实际 CS 联合验收单独记录。

## 设计门

首轮 `/root/rfc370_design_gate` 只读审查 proposal、design、plan、seam-assessment、rfc035-storage 及所引用的实际 AW/CS 合同。结论 FAIL，一项 P2：同 producer 绑定一个 endpoint 无法保留既有同 provider 多 endpoint 的规则和观测范围。具体输入为 GitLab endpoint A/B 分别处理 repo A/B，迁到共享 producer 后单绑定会漏掉一个 source；AW 原 schema 只对 urlToken 唯一，观测键包含 endpoint。

已补正 H8 来源配置与一对多路由绑定；逻辑事件回执冻结完整目标集合（包括空集合），每目标独立受理和恢复，跨订阅新 delivery 复用同一集合，路由修改不扩充旧事件。第二轮指出 MR 受理已提交但 observation 尚未持久化时不能完成目标；已明确 admitted／pending-publication 与持久待发布输入、稳定 key、两类 observe 回执补齐，再标 completed。改稿已由同一独立评审者复读并给设计门 PASS，无剩余可构造失败输入；审查 design blob `1e8674e12d442fe677f637cbed22b5cbc766d3f7`、proposal blob `13a3d0745ccbc13b9ab7d0d07e41137a1508f923`。此结论仅覆盖设计，不代表 A-G 或部署。以下八项纳入 B-T5 正式回归和实际链路验收：

1. 同 producer 的两个不同 repo 分别进入两个 endpoint。
2. 同 repo 显式绑定两个 endpoint，各保留一次观测和各自规则。
3. 一个目标成功、另一个失败，仅恢复未完成目标。
4. 接收提交后丢 ACK、ACK 后重启，完整目标集合不变。
5. 两个订阅为同 eventId 产生不同 deliveryId，每个 endpoint 只受理一次。
6. 接收后新增、删除或编辑 route，旧 event 重投沿用原集合和 binding revisions；已删除 source 保留终态原因。
7. 空集合事件接收后新增 route，旧 event 不触发；历史补发属于显式业务 replay。
8. MR 受理后未 observe、第一类 observe 已提交而第二类未提交、observe 已提交但目标回执未记录时崩溃；重启补足相同 observation key，保留既有 MR 受理及各 endpoint 去重。

CS 当前合同核对点为 `85ee9254a175848d65105d16327e00afbc47cc08`；RFC035 关键合同相对已记录 `35cf5a47` 未变。平台已有验收不作为 AW 联合验收。

## Intent 内容与 scratch 候选实现门

`/root/intent_functional_gate`：PASS，限定未发布的 21 个源代码/测试路径，基准 `ce8a6310adb9576559f4d5100d4916635a104720`；评审候选指纹 `9872857c3af575cad239efb57f590aea66aa42872be66194aef7ca6005c410aa`。无可构造失败输入的功能 finding。

已读全部候选及必要生产 composition、journal codec、SQL persistence、shared schema 和原 provider 回归。确认先 journal 后 stage，逐项 await owner/content/completion；提交前两层补偿、提交后 committed 重试、原 metadata/version 判据、旧整批 unmark→顺序发布→事务收尾、boot active journal 和 scratch 等待/计数/标记。新真库夹具符合原 schema，屏障在 finally 释放。两个启动根及维护 worker 的默认文件接线已核对；完整 H6 尚未覆盖，正式行为待本批 exact-SHA CI。

## 任务操作配置候选实现门

`/root/task_config_functional_gate`：PASS，限定未发布的 14 个源代码/测试路径，同一基准；评审候选指纹 `602107a187bf78f4106795cd021ed221647be59b154357dc26bd1775e3454b53`。无可构造失败输入的功能 finding。

确认六处 mint 冻结原位 await，commit patterns 按次热读和复制；默认文件/失败回退保持，所选 query 失败不读本机配置；driver 每次重新绑定能力，child launch/resume 经同一 driver，能力不进入继承 run-config。真双 provider/双 runtime mint 与 persistence 回归及原源码锁已核对。新测试尚未完整驱动 TaskEngine，接线结论来自源码追踪；正式行为待该批 exact-SHA CI。此结果不能关闭全 H1 或 A-G。

## Intent 配套 CI 修复实现门

`/root/intent_functional_gate`：有限 PASS，限定十个修复源码／回归路径，基准 `2d65a16f5152936ec93de1f0fd362a671e89e44d`；指纹 `0d4f07c55550bf65b272e2301105777479819fc1e25d1a8154d54e86155dc536`。工件数据仍从 types 出口，两个 owner capability 从 participants 出口；publication 的参数直接派生于现有中立事务 callback，create/update 都传入原 reserved transaction，没有影子事务或内容效果迁入事务。移动函数及类型依赖登记按新路径更新，两个原工厂改名后语料为66／62，原零孪生／生产消费者规则与自变异 fixture 保持。

原发布 `2d65a16f5` 的 [CI 36882578362](https://github.com/wangbinquan/agent-workflow/actions/runs/36882578362) 已 completed/failure、38 success／12 failure（含汇总 job），不能用此前有限静态 PASS 替代正式结果。六类兼容遗漏分别为 capability 出口、事务参数强转、移动函数路径、两个工厂改名后的两份计数，以及下沉合同的类型依赖登记。修复仅目标格式／lint与官方 scoped census，无本机 AW 测试、类型检查、构建或服务。正式类型、原行为与新回归继续以修复 exact-SHA CI 为准；此门不关闭 H6、A-G 或 RFC。

## Intent 修复正式 CI 回执（2026-10-02）

修复 `a4b706b942adfc9ca16c15e329ba1f7fa97f78f8` 的 run36886742257已因并行文档 push cancelled，48 success／1 cancelled／1 failure；未冒称该 SHA 全绿。包含修复的后继 `8d7e078e31527a3b70c5058af9fb25c4b23ff1f4` 的 [CI36890491336](https://github.com/wangbinquan/agent-workflow/actions/runs/36890491336) 已 completed/success、50/50作业 success，headSha逐字核对。修复是该 SHA 祖先，之间只增加 RFC371 两份文档，修复候选源码不变。原失败与取消记录保留。

## 任务配置33路径修订候选实现门（2026-10-02）

`/root/task_config_functional_gate`：有限范围 PASS，基准 `8d7e078e31527a3b70c5058af9fb25c4b23ff1f4`，候选33个精确源码／测试路径，完整指纹 `5fbce71b8f1e51b518c75c5cd93f99d02e00a965dbd5d2940b89c919713ddcb1`（按路径排序，每项路径+NUL+完整字节+NUL，SHA256）。此前18路径 operation/background 候选也已有限 PASS；本轮完整重读其接线，不借此前 PASS 代替新内容。

本轮首读发现一项 P2：selected source 删除 optional 配置或分段读取失败时，fresh 缺省字段经 spread 重新带回 boot 值。现 selected 配置独立进入运行漏斗，保留宿主 binary override／configPath／memory participant；双 provider 的四组带 boot 配置删值与独立失败回归已补。新增回归的 binaryOverride 初写字符串不符 readonly string[] 合同，已改数组；复读后无剩余可构造功能 finding。

评审范围为33路径及必要 provider、child lifecycle、execution context、配置 schema/file reader、启动 binder 与双 provider harness，未评审并行 RFC371 或 Intent 内容。六处 binary freeze 原位 await、commit 数组热读复制、每次 driver/child 注入，launch 原三次独立读取/catch、zero/filter、同步兼容入口与 HTTP upload await 保持。coordinator 在 attach 后读取配置，拒绝时报告并释放；等待取消后不准备或 dispatch。BG startup/tick/drain 与实际消费方 Promise 合同吻合。新回归使用真实 persistence/context/module，效果 fake 明确，不作为完整 TaskEngine 验收。

仅目标格式/lint、官方 scoped census 和原三个策略投影 AST runtime token 对拍；没有本机 AW test/typecheck/build/service。正式行为继续等待本批 exact-SHA hosted CI，此门不关闭全 H1、A-G 或 RFC。

## 任务配置 CI 配套修复实现门（2026-10-02）

首三路径独立复核有限 PASS，基准 `dd94236a4cdbf08ad41881332db55e94316bcfe6`，指纹 `10f1bdc0c7224010364994a0b603d407de313a003450549a5236dd6318ea2977`：完整 SchedulerDriverPort 夹具、保留并行 RFC371 的 Task positions 配套实现、单独的双 provider 分页合同回归。其后 CI 后端报告四种旧登记/源码锚点遗漏，扩为7源码/测试加 commons-debt 的8路径完整候选；由 `/root/task_config_functional_gate` 复读，有限 PASS，最终指纹 `020420e179a2ff3b19e5e8ea687f24eb5017ecc428381c2ee4422db71f1d04ee`，原三路径内容未变。

确认实际 driver 四方法与原 helper 合同；positions 使用原 [1,scope,startedAt,id] 游标格式与降序 tie-break，原 filter/factory/get/nextCursor 保持，空返回也完整。新增回归使用真实双 provider 表，逐项同时间继续、窗口变化、空 cohort 可断言。所有依赖在基准已存在，无未发布实现依赖。当前 Task owner companion 文件包含此前并行6行输出，完整保留，未纳入其他 RFC371 的未完成功能。

RFC108/287 只改变实际 policy 源位置并保持字段/类型原断言；RFC048 保持唯一解析点/唯一 spread/逐次读取及 selected/legacy 两臂；RFC359 的856、2462对应实际 insert 起始行，四站点、三必需列及 scanner/fixture 不变。commons-debt 原条目未改，新增五条 actual value:static-import，canonical ID 与四份 sourceDigest 逐项对上，inbound255→260，没有扫描豁免。正式类型与行为继续交修复 exact-SHA CI；没有本机 AW test/typecheck/build/service。本门不关闭全 H1、A-G 或 RFC。

终态 CI36924136910 为41 success／9 failure；新增三测试配套后，完整11路径候选再次由 `/root/task_config_functional_gate` 独立有限 PASS。最终指纹 `9ca7a28d5e0f93b101c3856d59ca8f0eed49128a7aeb2b5ca59230d358401c7f`，原八路径内容保持。RFC287锁 owner 导出类型／reader 返回类型与 legacy ReturnType 两字段；RFC332在真实 continuation/effect 开始时触发 barrier，全部未结算／顺序／释放断言保持；RFC363只设完整历史用例20秒上限，迁移实现及完整性／拒绝断言无改动。H3六路径在制不纳入本门与本次发布。正式结果继续等待修复 exact-SHA CI。

## H3 工作区维护有限实现门（2026-10-02）

独立首门 FAIL/P2：recovery 先枚举旧终态行，异步 exists 待回执时前台恢复／取消／finalize 开始新清理认领；物理目录已删但 ACK 未成，旧 heal 仅核对 pruned=null 可提前写完成。该失败输入保留，不把首门改写为通过。

六路径修正后 `/root/intent_functional_gate` 有限 PASS，指纹 `51e83940efeca6a06c7ef9b3fe2b939ef3c18b0df45ba449ff3c3a1100e010c6`。已沿读 Node adapter、Drizzle store、terminal claim／persistence、双 provider harness、既有消费者与四处生产装配。heal 原子检查 pruning/pruned、终态、deleted、worktreePath、lifecycleEventRevision，两个应用调用点传实际快照。真实双 provider、两实例 ACK success/failure 回归会捕获移除 pruning 条件，异步 false／异常回归会捕获遗漏 await；同步默认 Node 装配兼容。只有效果，不移走 AW 业务或恢复决定。未运行本机 AW 测试／类型检查／构建／服务，正式结果待确切 SHA CI。该门不涵盖恢复存在检查另批、完整 H3、A-G 或 CS 联合验收。

任务配置修复确切 SHA `c028b22c4a9a5281aa9013d4fac058c343f3a4f3` 的 [CI36928636248](https://github.com/wangbinquan/agent-workflow/actions/runs/36928636248) 已 completed/success，50/50作业 success，headSha 已核对；原 dd 修复前失败保留。工作区维护候选现在另批发布，其行为等待新的 exact-SHA hosted CI。

## H3 恢复预检存在查询有限实现门（2026-10-02）

`/root/task_config_functional_gate` 有限 PASS，十路径指纹 `ada4b1d9492b69d8aae8bd62ba362ca97d64eadd4fa81664e5b2d3f12c049e15`。沿读现 recovery/query/workgroup composer、SC public 与 file adapter、双 provider harness；await false/reject、多仓顺序及 this 接线正确，原409/410/错误传播保留。PG 原166语句只追加唯一 preflight presence binding 的全体 AST 对拍通过，W29 无放宽、SQLite 两摘要不变；未运行本机功能测试。该门不涵盖普通任务共用 lifecycle resume admission、完整H3、A-G或CS联合验收，下一批继续。

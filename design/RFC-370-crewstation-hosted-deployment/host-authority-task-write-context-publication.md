# RFC-370 Task 宿主写上下文持久参与者发布

本批实现 SO 自有生命周期端口、双数据库持久参与者及 Task 独立 adapter。Task 的原 SQL 体成功后可在同一个原事务消费具名新工作／恢复／已发出回执；失败回滚完整业务体并保留原业务错误优先顺序。prepare 的 receipt 只在实际 COMMIT 后登记，保留原 grant 的方法与 receiver。drain／retire 与已发出回执继续收回失权前的工作结果。

本片尚未接入实际 Task claim、heartbeat、runner、业务事务调用者或 provider roots。缺失旧行退休事实时不覆盖未退休 generation。实际 early recovery、named admission、全部十九 owner、UI、完整 H7／A-T7／A-G 和 CS M0～M4 继续开放；AW 还没有部署到 CS。

## 源码与工作流功能门

原设计 D1 FAIL／D2 PASS 和 root 在创建计划文件之前的实际消费记录保留。SOURCE18-R1 的功能 F01 是原 current 方法及 receiver 丢失，使持久 drain 前的 active 行仍可能提交新工作。root 完整消费原 FAIL 后，SOURCE18-R2 捕获原方法及 receiver，并在实际 SQL await 后继续判断新工作／恢复的原执行权；已发出回执和退场不要求 current。

SOURCE18-R2 有效稳定有限 PASS：18 自有、15 对照、24 证据，共 57 项／4,232,914 bytes，FP `b2b4384c3ae09db3ef5ab87605ab05ad186a7d56792cc94a09424d8c49d36d21`。原十个双数据库测试体、断言及预算完整保留，追加两个真实原事务案例；各案例由既有 helper 对两个数据库运行。没有本机 AW tests／typecheck／build／service／E2E。

Windows 的 WF1-R1 有效稳定有限 PASS，仅在原三个位置登记这一套新回归。完整旧 YAML 的逆向恢复及原 74 个命令 token 内容／顺序保持，旧用例和预算不变。root 已实际消费该 13 项首末正文绑定；新精确 SHA 的 hosted CI 另行验收。

## 原安装迁移

SQLite 沿原生成器实际生成一次；由于既有 journal idx／tag 差异产生同名 0241 snapshot，本批原输出先完整保存，再把新 SQL／snapshot 移至 0242。历史 0241 snapshot、原 222 表完整 payload 和原 journal 前缀保持。PostgreSQL 首轮因缺少 exact roster 登记拒绝，失败日志保留；补充唯一新表及 SO owner 登记后，由原 immutable append helper 生成 0018。全部历史迁移文件保持，启动与 Task 事务不临时建表。

## 原静态清单与有限配套

唯一实际原 scoped census 固定 `98bf31c77f6ff2e324290c2c1a402347684d1737`，叠加已复核的十个 production 文件（四个原文件、六个新文件）和一个新测试。其余 6710 个非本批源路径取该 SHA 的原 Git blob，原四条规则逐字保持。生成一次完整成功，十三项原输出在投影前保存，sourceDigest 为 `sha256:9d91199c3580bd105ba448223d07aa6583ff10cff408014972bbd7a47048aaed`；完整 classic before／after 数组均为 0／0 且相等。

原全部 owner、opaque mutation、import 和 exception 行完整保持。实测新增 25 个 owner、两条 mutation、四条 SO transaction、16 条 import／12 条原 classifier exception 及三个 offered type。新增 exception 的原分类字段照原生成结果保存，不将新边描述为旧债。只有两条原 platform transaction 物理行号 264→280、285→293，以及两个既有 public type-consumer 数组各新增一个 consumer；原方法、字段、签名与消费者前缀保持。背景工作、commons、facade、guard、SCC 与目标图等其余业务 payload 不变。

完整 129 项 ledger 的顺序、why、预算和其他字段保持，仅给六项真实增量添加一次声明：mutation 1956→1958，transaction 267→271，imports 6798→6814，exceptions 5969→5981，public 1235→1238，owners 27419→27444。沿原五个纯 JSON 函数更新 ledger payload 摘要。随本批发布消费声明后，在普通后继退役，不再运行 census。

私有投影 R1 对原 manifest 文件顺序作错误排序假设、R2 对物理行号变化后的原 ID 排序作错误假设，失败脚本与记录完整保留；R3 按同一文件集合及每条唯一原 ID 核对完整原行，成功保存投影。源码候选和唯一原生成输出不变，没有重跑 census 或用失败投影改 canonical。STATE／plan 原完整前缀和全部并行输出保留，本片配套由独立 reviewer 审核，精确上库、远端同步和 hosted CI 各自验收。

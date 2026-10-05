# 完整统计的实际规模验收

本片执行已批准 `complete-statistics.md` §7 的 100K Task／10M usage 与单组 10M self-total 验收，不新增统计口径、采集来源或产品数量上限。普通 CI 与真实模型验收保持；本片使用明确标记的合成验收数据库，不声称这些记录来自模型或供应商账单。没有达到真实 EOF 或原精确预言的运行必须失败，不能减少人口重跑并报通过。

## 原入口与两个独立场景

使用仓库原 `openDb` 迁移一份专用文件 SQLite/WAL；只由本运行创建并使用，没有 daemon、主库、其他会话数据库或当前任务。原 `seedCompleteTask` 的参数收窄为它实际使用的 `db`，行为不变；第一份原受理／价格／Task／node／capture fixture 提供原表模板，后续仅在真实原表写入明确的合成原始记录。fixture 写入可以批处理，统计与结果不得以种子循环、SQL 聚合或预计算数字替代原消费者。

1. 完整报告：原表包含 **100,000 个 Task、100,000 次尝试、100,000 个受理调用、100,000 份 v1 验收 capture，以及 10,000,000 条唯一用量**；每 Task 100 条。所有任务在同一窗口，独立 Task／调用／记录 identity，复用既有验收 CNY 费率 1／2／3／4 元每百万 Token。每记录四桶为输入1／缓存读3／缓存写5／输出7，期望四桶10M／30M／50M／70M，总160M，人民币500元。原 `originalReportSnapshotSession` → Task owner `createCompleteTaskObservationFacts` → `composeCompleteObservationSnapshot` → 原 file spool → `completeObservationReportService` → 原报告库发布。调用原 worker drain 后必须 `ready`，inventory、四桶和人民币全部精确匹配。再经原 service.page 逐页读所有 Task 和所有 allocation 到 null；每条与所属 Task／调用、记录号、模型、四桶和人民币逐一核对；位图只用于验收重复／缺失，不参与统计。位图 100K／10M 个 bit，不能将整个人口放进 Map／数组。
2. 非覆盖大组：在同一真实原快照的 TEMP 工作区，向原 `completeUsageWorkspace` 分包写 **10,000,000** 条同 source／invocation／root 的 `self-total`。每条具有独立叶 session、真实 fixture 父关系 root→leaf、原 level 与 turn 字段；叶间互不覆盖，model 为 null，四桶仍1／3／5／7。调用原 `selectCompleteUsage`，不得改用数组 oracle 或替代 interval tree。必须 selected=10M、excluded=0、unavailable=0、ambiguous=0、全部完整及精确四桶；再读原 allocation TEMP 行至 EOF，逐原 identity 和桶验证，没有大数组。此场景不声称生成正式 Task／价格报告；它专门验证原持续索引避免旧 totals.map 的平方扫描。

两场景分别使用独立 hosted Linux job 和独立目录，先后不是同一数据库的两份数字账本。SQLite 大组使用磁盘 TEMP，默认存储、排序、覆盖和缓存算法不换成 mock／内存全量实现。不改原分页服务200单页界限；验证会读完全部页，该数值不是总任务或调用限制。

## 测量与失败回执

每个阶段记录 monotonic 时长：初始化、种子、首次完整构建、发布后全量对拍，报告 ready 的 status／第一页／末页查询分开采样。原读链的100份 ready请求样本报告P50／P95／最大值，P95必须小于已有500ms目标。首次 job 时长不能混入 ready 延迟。

由 hosted runner 上 `/usr/bin/time -v` 记录整个实际 Bun 进程 OS 峰值RSS；Bun `process.resourceUsage().maxRSS` 保存对应进程口径。旁观采样器每5秒记录实际工作目录、SQLite/WAL、报告spool、TEMP所在专用TMPDIR及根盘可用空间，保存磁盘观测高水位，并明确这是采样最大值而不是物理绝对峰值。stdout 仅每100K记录输出进度与阶段，不打印原全量数组。没有容量、超时、原页错误或消费失败均保留 FAIL 与已发生的测量，不转成功 subtotal；不删除平台数据或其他会话产物腾空间。

新增专用 `workflow_dispatch`，固定两个完整场景、Bun版本与实际提交SHA；不提供缩小Task／usage的输入。它不挂到每次普通push，不把大规模工作抢进每个普通测试分片。上传实际JSON、时间资源原文、磁盘采样与完整log；即使失败也上传。此新专用规模 job 的预算独立列明，不延长或削弱任何已有CI/test预算。

## 回归与落位

验收代码落在 backend `tests/helpers`，只使用原数据库、composition、application 和 fixture；不是 production public API 或新 runtime owner。配套普通 `rfc371-scale-corpus.test.ts` 通过原双 provider harness：3个Task／6条记录的报告精确结果、所有身份的原分页，以及小型非覆盖self-total的原工作区对拍。边界：非法数量／记录不整除和已经包含额外原人口必须拒绝种子扩增，避免把真实已有库当空验证库；失败回执保持，不能覆盖先前成功或失败文件。专用完整跑入口只允许独占创建的新目录与新数据库。

精确变更清单：本设计；原 `rfc371CompleteTaskFixture.ts` 参数类型；新 `rfc371ScaleCorpus.ts`（有界原表种子与独立预言）、`rfc371ScaleQualification.ts`（原构建／EOF对拍与回执）、`rfc371-scale-corpus.test.ts`；新 `.github/workflows/observability-scale.yml` 与专用旁观采样脚本。生产算法、原断言、权限、schema／migration、价格选择、采集完整资格、普通CI预算与其他会话的共享在制产物保持。

设计功能门通过后实现。秒级精确格式／lint与原实现功能门，再直接提交自有路径、核对 hosted 普通CI，并对确切SHA实际启动两个完整规模job。成功的10K fixture、复杂度说明和原逐页回归不能替代上述实际10M运行。CS的独立100K／10M规模、v2数值consumer与实际producer、托管联合模型任务仍另行验收，两个RFC不因本片关闭。

SOURCE1 功能门发现 Task-zero 别名可替代原 Task 身份，以及组级中断会同时停止 GNU time。原 FAIL 保留；后继核对 Task ID 与原种子逐字相同，并只停止实际被测后继，让原 GNU time 回收及写出 OS 资源。专用 hosted job 在完整规模运行前执行两次实际 Bun 的 SIGTERM／SIGKILL 测量控制，要求中断后原 peak RSS 原文已落盘；控制标记 `fullScaleQualification=false`，没有原 Task／usage 人口，也不作为完整规模通过证据。

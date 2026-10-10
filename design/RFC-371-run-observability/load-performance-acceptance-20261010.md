# RFC-371：2026-10-10 加载耗时与完整报告验收

本记录区分已取得的正确性证据与尚未解决的首次生成耗时。两个 RFC 仍为 In Progress，不将部分成功写成关闭。

## 已恢复原服务并核对正式页面

用户明确授权恢复原 AW 服务及继续验收。原数据库、后端 7456、前端 5174 已恢复；后端完成正常迁移到版本 243。没有为验收另建服务、切换身份、修改全局默认运行时或费率。

原生消息缓存优化已发布 `98e18639401c9e9c70a248b4e46a2c02348ee5e6`，包含原源码、回归和完整原架构配套共 20 路径。它减少同一有效窗口内的重复 TEMP 消息写入，仍保留原字段、顺序、错误、ACK 成功前缀和 EOF。

同一已获准的本机标记任务，完整报告 `f426d997-4539-4fa4-8d59-bfeb0b4d18f6` 实测 12,090 ms。4 任务、8 尝试、5 调用、7 数值记录保持；输入 30,636、缓存读取 42,496、缓存写入 0、输出 2,746，合计 75,878 Token，验收专用人民币估值 ¥0.104488。费率不代表供应商账单。

只读逐行对账覆盖全部 31,826 条明细和 14,997 组计数，原有序字段、类型及数值完全相等。7,798 份收据中，4,066 份原 native／historical key 与 document 全字节相等；其余 3,732 份派生收据仅核对原 database generation、rows、pages、EOF 四类字段的集合，EOF 全 true。每次 report／snapshot 身份不同，不能宣称派生 key、document 全部字段或原字节相等。

正式总览同一范围刷新生成 `e2c0668c-ed05-4c34-a8c3-4f1f03c66d09`，耗时 19,030 ms；137 任务、595 尝试、446 调用、198 历史引用、227 数值记录和原摘要相等。四桶 1,189,241／1,255,680／0／186,002，合计 2,630,923 Token；已记录人民币估值 ¥4.078952，210／227 条已定价。原用量与定价缺口仍按真实原因显示。本次总览没有另做所有物理明细的逐行比较，不外推标记任务的对账结果。

正式浏览器已读到新的统计时间 2026/10/10 16:51:06、恢复可点击的刷新入口，以及 10 月 7／8／9 日三根柱的实际 371,573／2,212,426／46,924 Token。刷新期间保留同范围的上次完整报告。此前 193 ms 仅证明已有报告的一次重入，不证明首次或新范围生成已解决。

## 当前耗时与未采用的研究

标记任务的阶段记录显示，历史 owner／event 遍历约 1.39 秒，原生遍历约 4.50 秒，历史归属处理约 2.06 秒；Worker 封存约 8.41 秒，完整发布后合计 12.09 秒。任务范围虽然较小，原归属判断仍核对可见历史 owner 与原生 roots，不能删除全局冲突与父子归属证据来提速。

原后端的 15 秒只读进程采样伴随一次相同标记任务报告生成，结果为 12,073 ms，完整摘要仍相等。主线程主要等待 Worker，报告 Worker 有 SQLite 读取和不可符号化的 Bun／JavaScript 栈。本次计时包含采样开销，不能据此量化冷启动、JIT 或特定 JavaScript 函数的占比。

仅在中性只读 SQL 研究中比较 TEMP count 查询：全部 14,997 行原完整字段相等，原 OR 53.42 ms、VALUES join 49.24 ms，差异不足以说明主要耗时，因此未改产品 SQL。原生 cache_size 的 2／32 MiB 四次遍历依次为 2,225.91／722.07／717.97／711.67 ms，全部 49,527 行原字段与顺序相等；最后一次 2 MiB 同样很快，存在操作系统热缓存混杂，未据此采用 32 MiB 配置。

首次／新范围完整生成仍需约 12～19 秒，继续开放。原生 sourceGeneration 只标识文件 dev／ino／birthtime，普通 WAL 写入不会使它变化；不能仅按此值跨报告复用旧用量或 JSON 资格判断。

## 精确 CI 与 ACK 夹具修正设计

精确 `98e186394` 的主 CI [38040145754](https://github.com/wangbinquan/agent-workflow/actions/runs/38040145754) completed/failure，72 作业中 64 success／8 failure；Windows [38040145771](https://github.com/wangbinquan/agent-workflow/actions/runs/38040145771) 也 failure。本次新增原生窗口的五个回归在 Windows 实际通过，不代签整个 CI 成功。失败包括并行 RFC-370 的上下文引用类型、冻结 Proxy 夹具、装配 marker，以及旧外链超时和两个 Mac 用例超时。并行修复 `127ab32d`／`abca1d511` 已正常发布，原失败记录保留，新 SHA CI 另验。

本会话的 `rfc371-native-owner-pass.test.ts` 原 ACK case 在 Mac 1 为 5,104.73 ms，触及原 5,000 ms 默认预算。它在九个 ACK 变体内各重建相同的 `fixture(200)`，输入均为一个 root、200 条 message 和 400 条 part。设计只移出这一相同、之后仅被只读连接访问的原生输入构造：九次仍分别调用原 `observedReader(path)`，取得各自全新快照；每次在原临时根目录下创建不同 owner 子目录，调用未修改的 `durableTestOwner`，保留实际 WAL、synchronous=FULL、事务持久化与 finally close。

九个 ACK 变体、原 case 名、全部 expect、一次读取／零 ACK／已关闭、一条真实持久化 page、一次 interruption 和默认 5 秒预算必须逐字保持。其它五个 case、fixture 内容及全部生产源码不改；没有减少人口、提高超时或跳过用例。根目录的原 afterEach 递归清理覆盖所有 owner 子目录，前一变体的文件不会与后一变体共享。先做有限独立功能设计门，再实施、检查原文本逆变换、显式格式／lint、独立实现门及精确提交／hosted CI；不运行本机 AW 产品测试、类型检查或构建。

有限独立设计门已 VALID／PASS，零功能 findings；批准只限上述夹具设计，未认证修正后耗时或整仓 CI。当前测试候选按该设计实施，独立实现门、精确发布及新 hosted CI 仍分别验收。其它验收事实不由设计门重新认证，原 5,104.73 ms 超时保留为失败。

## 继续开放的工作

完整报告的首次生成仍需进一步实测提速；上面的 SQL 研究不算产品验收。CS 原 33 文件完整检查的九项超时与发布／部署、16 内置 Agent 与 Git 原入口成功实跑、所需全局临时运行时配置答复、AW-R02～12 和其它未取得证据的出口继续开放。记忆专用临时配置已在此前验收后恢复。没有启动 observability-scale，也没有以新成功覆盖旧失败。

## 复合键批量读取候选与新正式验收

在原 select 映射及事务内，将计数组的逐臂完整身份 OR 改为同一 reportId 与成对 section/parent 的参数化 IN (VALUES)。两个原写入函数、任意精度计数、原值条件和错误文本逐字保持；原四个测试声明、五个展开用例、29 处 expect 与全部原预算保持。新增双真实 provider 用例使用两个独立报告、250 个共享 parent 的 500 个完整键，验证同父跨分类、另一报告不同计数、回放、零组、全部行与 progress，并录制每次查询只绑定一次 reportId；500 只是该回归的工作批次，统计仍处理所有后续页直至 EOF。有限独立设计门和源码实现门均 VALID／PASS，零功能 findings；实际 PostgreSQL 与新 hosted CI 另验。

同一已批准标记任务的新原报告 `e1a5145b-49e8-41c0-bd90-b89cbbd3842b` 为 ready，耗时 10,719 ms，原 12,090 ms 记录保留。全部 31,826 条明细与 14,997 组的有序原字段、类型和文档精确相等；7,798 份回执全部存在，4,066 份原 raw key/document 全字节相等，3,732 份派生回执核对原 snapshot 四元组前三个 database-generation 字段、rows、pages、EOF 的完整集合，EOF 全 true，不声称变化的 nonce/source/key 或派生全文相等。4 任务、8 尝试、5 调用、7 数值记录、四桶 30,636／42,496／0／2,746、75,878 Token 与验收专用 ¥0.104488 保持。

正式浏览器在同一范围通过原刷新生成 `4b2d9a1b-5287-4aea-855d-bdc514d1da57`，耗时 11,746 ms，原 19,030 ms 记录保留。全部 37,533 条原明细与 16,259 组有序原字段、类型和文档精确相等；8,326 份回执全部存在，其中 4,066 份原 raw 全字节相等，4,260 份派生按同一明确范围核对且 EOF 全 true。原完整 summary、filters、gaps 相等，137 任务、595 尝试、446 调用、198 历史引用、227 数值记录、四桶 1,189,241／1,255,680／0／186,002、2,630,923 Token 与已记录 ¥4.078952 保持。not-ready 是原数值证据缺口，并非漏采统计人口；已知数值继续显示。正式页面统计时间为 2026/10/10 19:03:16，刷新期间保留上次结果，结束恢复原刷新入口，三根柱的分类与实际 Token 不变。

上述是两次不同范围各一次新报告观察，不能把全部差异归因于单个查询或承诺稳定降幅。首次／新范围仍需约 10～12 秒，本项继续开放；不通过减少任务、调用、原归属证据或完整性核对提速。唯一原 canonical 生成已完成，13 份原配套更新 sourceDigest，删除两个旧私有 helper 后 moduleSymbolOwners 从 27,805 到 27,803；不增加增长许可，不重跑生成。

ACK 夹具后继 `ff450237c` 的主 CI [38043641753](https://github.com/wangbinquan/agent-workflow/actions/runs/38043641753) 为 completed/failure：70 作业 success，Markdown link check 与依赖汇总 failure，原失败保留。普通后继 `ca947c2431cd710bdaa63af3bae4903c1ace03b4` 的主 CI [38044940528](https://github.com/wangbinquan/agent-workflow/actions/runs/38044940528) 为 completed/success，72／72 作业 success；Windows [38045024500](https://github.com/wangbinquan/agent-workflow/actions/runs/38045024500) 也 completed/success。这两份是新复合键源码发布前的已提交内容证据，不代签本候选，新 SHA 的主／Windows 结果仍另验。没有启动 observability-scale，两个 RFC 继续 In Progress。

## 复合键优化正式发布与确切 CI 终态

`ef91b49e15412d3908b0911e1f773229a41a38f1` 已将上述复合键优化、双 provider 回归及原完整配套共 18 路径精确提交并推送；提交后的全部 18 个文件与已审候选完整字节一致，main／origin/main 为 0／0，共享 index 为空，并行 RFC-370 在制内容保持。主 CI [38048649757](https://github.com/wangbinquan/agent-workflow/actions/runs/38048649757) 为 completed／success，全部 72 个作业成功；同 SHA 的 Windows [38048649744](https://github.com/wangbinquan/agent-workflow/actions/runs/38048649744) 为 completed／success，原 26 步成功。此前失败记录保留，没有启动规模 CI。

已读取 Ubuntu shard 2／32 的实际目标测试日志：原五个展开场景及新增复合键场景，在真实 PostgreSQL 和 SQLite 上各六例全部 pass，无跳过；新增场景分别为 320.39 ms 与 62.82 ms。Windows 的同组六个 SQLite 场景全部 pass，新增场景为 105.57 ms。主流水线中名称为 real PostgreSQL 的另一个专门任务只运行旧 Task 分页用例，不能拿它作为本次计数组回归证据；上述 PostgreSQL 证据来自配置了真实数据库的 Ubuntu 分片。归档同时含作业汇总和测试步骤副本，按同一次执行核对，不重复计为新增运行。

首次／新范围约 10～12 秒的实测与完整逐行对账仍以上节两个原报告为准；CI 成功不代表已经达到首次加载性能目标。后续只读 SQL 研究比较了原生 JSON 资格查询，在同一原快照的全部 2,743 个 session 上结果相等，但观察顺序和热缓存影响未消除；保留原比较方向及存储类型的候选在热读中为 679.45 ms，原查询为 367.14 ms，未采用，也未改产品源码、运行时配置或统计人口。当前源码不按仅代表文件身份的 sourceGeneration 跨报告复用数值或资格判断。

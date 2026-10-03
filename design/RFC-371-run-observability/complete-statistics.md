# AW RFC-371 / CS RFC-034：完整统计设计 v3

状态：DESIGN v3 已通过独立功能审查，进入实施；不是已实现或完成回执。v1 与 v2 的各三项 P2 和 FAIL 原件全部保留。本版落实用户 2026-10-03 的硬要求：禁止把数量上限、部分采集或缺页结果作为成功统计。CS 开发 producer 仍 OFF，退出/租约/出生/停止保护不由此设计放行。

## 1. 成功、等待与失败

统计的范围是已授权的系统/项目、时间窗口、任务起始 cohort、来源/用途/模型/算力等显式筛选。总览、趋势、各维度、Task/Agent/调用汇总使用同一份冻结输入、原覆盖选择、原受理价格和精确四桶数值。列表和泳道的页大小不是汇总范围。没有 tasks/invocations/records/captures 总量预算，没有成功 partial/lower-bound/unresolved 小计。

正式响应为 `building | ready | not-ready | failed` 联合类型。building 仅有报告标识、当前读取/计算阶段及进度，**没有统计数字**；not-ready 包含具名来源缺口和是否可自动恢复，没有部分数值；failed 包含可重试错误，也不带小计。ready 才有 `coverage: complete`、asOf、版本、源快照标识及数字。用户切换窗口或筛选后，旧范围数字不能伪装为新结果。不可恢复缺失证据或不支持的来源明确说明，不伪造 Token 或人民币金额。

Token 必须完整覆盖 input/cacheRead/cacheWrite/output。金额独立为 complete/unpriced/hidden：只有完整定价且权限可见才显示总人民币金额；缺费率或隐藏时金额 null，不显示已定价子集。空调用零来自原 owner 完整执行事实和原 native 完整空证明；空页、pending=0、没有记录均不是零证明。费用使用原受理版本，不拿当前配置重新定价。

## 2. 所有读取端口的分页合同

内部通用页是 `{items, nextCursor: string|null, snapshotId}`。null **只允许原查询确认没有后续行**；truncated/partial 被移除，不能改名成 EOF。游标绑定 snapshotId、actor/权限版本、查询 scope digest、owner/sourceKind、父 identity 和稳定排序位置。服务逐页到 null；重复游标、重复 identity、游标倒退、无原扫描进度的空页仍有非空 continuation、跨范围/跨快照复用明确失败。普通 owner 行页至少含真实源行；数字过滤后的原 native 扫描页另有 `scanPositionBefore/After`、scannedRawRows、acceptedPayloadRows，非 step-finish 的 parts 仍推进原扫描游标。这样的页可以零数字 payload 并非零消耗/EOF，只有 before!=after 且原扫描计数增加才继续；分页到真正原 session/part 队列 EOF。页内 `limit+1` 是探测后续页，不是总量上限。

- AW 原 Task owner list 保持 `(startedAt DESC,id DESC)` 与每条 positions、ACL、直接 Task cohort。invocations 新增 `(taskId,{after,limit})`，按原 id keyset；attempts 同样分页按原 node-run id；usage 按原 `(invocationId,recordId)`/原 source cursor，补上 invocation identity 谓词以免逐 invocation 重扫整个 Task；captures 按 invocation/source/capture id 分页；平台记录按 binding + generation/revision +原 keyset。所有页由同一快照 Executor 产生。accepted/tariff 缓存是有界 LRU，不保留全部 Task 的 Map。
- CS business owner 的 parents 按 `(createdAt DESC,id DESC)`；原 legacy/v3 attempts 用独立稳定身份与 `(createdAt,id,ownerKind)` 合并页，不能先各读 N 再截总数组；development owner 按同一父排序与 Agent 实际 identity 分页。平台 `RuntimeFactPage` 新增独立 business/development 游标及真实双 EOF，保留两个 owner 的事实归属。任一 owner 未 EOF 不得把合并页视为完整。
- CS 数值、价款和 capture 分成独立 keyset 流，不再共享 20000 remaining；以当前页 Task/attempt 身份表 join/exists，不生成覆盖所有 Task 的巨大 IN/OR。usage/valuation 的同一量表 revision 对齐在完整快照中完成；capture/native baseline/owner steps/repair 各自 EOF。项目/算力/Agent 名称仍由原 owner public facts 提供；参与 q/name 过滤的名称事实必须由原 owner 在同一 Executor 中解析，不在快照结束后改变筛选集合。
- Task detail、attempt、Agent 汇总和泳道也不能复用旧 1000/10000 内层截断。summary 计算完整，明细/泳道另走分页。批处理页可以是 25/500 等，但这些常量仅是单批内存/SQL 参数大小。

## 3. 有界工作区与快照执行

采用**原数据库专用快照连接 + 连接私有 TEMP 工作区 +后台报告构建**，不是另建 Token 账本，也不建立独立 SQLite 统计引擎。数值 authority 仍是原 owner/usage/valuation/native 账本。新增平台 `ReportSnapshotSession.run(work,signal)`：应用只接收 provider-neutral Executor、workspace 能力及 snapshotId，不能根据引擎分支。

AW SQLite 的长期汇总不使用目前主 writer 的 BEGIN IMMEDIATE。在原 verified live generation 的同一个数据库文件上，平台建立独立只读主库连接，使用 BEGIN DEFERRED 冻结 WAL read snapshot，在工作线程执行原 owner queries。禁止打开别的 generation、复制数据库文件或假造一份独立数据集；`:memory:` 原部署无法新连接共享主库时走现有同连接快照并明确其阻塞性能，功能仍精确。这里是产品运行时能力，不是开发用 worktree/clone，也不修改现有短事务的隔离守卫。TEMP 可写性必须在真 SQLite gate 验证；不静默降级为巨大数组。

AW PG 与 CS PG 在原 pool 取得**一条专用 session**，先在 read-write setup transaction 创建连接私有 TEMP 表/索引，提交 setup，再开始 REPEATABLE READ READ ONLY 输入快照；报告期间只写已存在 TEMP 表，不在只读事务 CREATE/DROP。完成后 COMMIT/ROLLBACK，独立清理 transaction DROP，最后归还/销毁连接。CS owner/read/price/name 全部使用这一 Executor，不因公共名称查询再占第二个连接而死锁。

工作区表：`input_records`（原记录引用和必要 scope/model/bucket/revision/price 字段）；`sort_runs`（有限排序块和合并结果）；`ancestry`（root/session/原 ancestor 路径）；`coverage_nodes`（选中 summary 的区间树节点）；`allocations`（每原记录四桶的查询分配）；`report_tasks`、`report_dimensions`、`report_quality`、`duration_order`（派生汇总和分页索引）。这些表仅在本连接生命周期中存在，无永久迁移，不进入备份或成为补采/价款依据。每个读取 batch 和 JS cache 按字节/页界限管理；超内存将页留在 TEMP，不截断输入。

AW 工作线程的所有原数据库/TEMP 操作是同线程同步/Drizzle DB await，不能在现有主 `snapshotRead` 里 await 文件系统、网络或子进程；没有跨原 transactionScope 的旁观者写入。PG 报告 session 可以等待数据库，name 仍走同 Executor。取消、超时、失去权限或 generation 切换都 rollback 并销毁工作区；不得从另一次快照接续旧半份结果。并发相同 actor/scope 的构建合并为一个 job，计算 worker 并发和单页 CPU 是调度参数，**不是统计总量限制**。磁盘/连接不足明确 failed，绝不 partial 成功。

## 4. 覆盖选择：具体精确算法

保留 AW `usageSelection` 和 CS `tokenUsage` 的关系语义作为 oracle，不能每页独立选择再相加，也不能用所有较早原记录的 NOT EXISTS 替代“已选 summary”。先冻结完整组：AW `(sourceId,invocationId,scope.root)`，CS `(sourceId,identity,scope.root)`。无 scope 保持原分配。

输入解析后写 TEMP；分块在 JS 使用**原比较器**排序（level rank、ancestor 长度、turnIndex、recordId.localeCompare、稳定原 ordinal），每块的大小受内存界限约束。TEMP sort_runs 保存块顺序。用固定 fan-in 的 k 路 merge，每路只缓存一页，连续输出 TEMP run，直到一个真实完整 run；不依赖数据库排序去近似 JS localeCompare。所有祖先路径在完整 group 上验证 root/parent/环/冲突，失败不产 ready。AW/CS 对未知 ancestry 的原错误状态保持。需要的一次 ancestry Map 改为 TEMP keyed lookup；scope 长度的合法 schema 边界不能悄悄削掉原记录。

四桶独立按同一 canonical run 遍历。只把 `value != null` 且 level != request 的**已被原关系选中** summary 插入覆盖索引；covered 跳过，partial 记缺口并跳过，null summary 记未知但不能成为覆盖 authority。覆盖索引存原单条 summary 区间，不把相邻区间 union 成新的覆盖证明。

索引采用按 `(group,bucket,session,treeOnly,modelPartition)` 分区的持久 AVL interval tree，节点存 start/end、子树 maxEnd、原 summary identity；有界 node page cache，TEMP nodes 支撑单组 10M 记录。通过 prefix-max 查询“start<=b.start 且 maxEnd>=b.end”找到**单条完整覆盖**；通过 start<=b.end 的 prefix-max 检查任意 overlap。两种查询都检验原 model 和关系，covered 优先于 partial。不能用 `sum(end-start)` 或合并长度证明覆盖。

canonical 顺序在祖先验证后保证：tree-total 比 self-total 早，祖先 tree 比后代早。因此处理当前 tree-total 时，严格后代 summary 不可能已经被选；处理 self/request 时当前不能包含 summary。原 `aInsideB` 的严格后代分支不存在早先已选候选；仍以 oracle 反例和随机差分验证，若条件不满足必须失败，不能忽略。需要查询的候选仅当前 session 的 summary 与全部 ancestor session 的 tree-total。

AW model 分区不能简单按 model 分组：b.model=null 的 overlap 用 any-model 索引，covered 只用 null-model；b.provider=null 需同 id 所有 provider 的 overlap，covered 用同 id/null provider 与 null-model；b.provider 非 null 的 overlap 需 exact id/provider、同 id/null provider、null-model，covered 只 exact 与 null-model。每个选中 summary 更新所需 any/id/exact/null 索引；CS 相应为 null 与 exact modelRef。原 relation 再验证候选，保留未知 provider 的 partial。每条记录分配四桶后再应用原价格/价款关联与原模型筛选；原 money whole/contribution 条件不能改写。

BigInt 十进制与 CNY pico 精度累加到 TEMP 派生 Task/维度行，不用浮点。时间 min/max 是逐条归约，不使用 `Math.min(...millions)`；elapsed/active/wait 仍用实际 interval union，区间同样外部合并后流式归约。p50/p95 采用原 nearest-rank，把完整 duration 值放 duration_order，读 ceil(p\*n)-1 的精确排名，不能用估算 sketch。模型/用途/Agent/运行时、趋势与总量都从同一 allocations/reduction 产出；quality 计数完整，明细理由另分页。

复杂度：排序 O(N log N)、覆盖 O(N*d*log S)（d 为合法 ancestor 深度，S 为选中 summary）、持有内存 O(batch+mergePages+cache)，工作区磁盘 O(N+selectedIndex+reports)。无 summary 的 request 流不会逐条扫描所有历史 request。10M 非覆盖 self-total 不走旧 totals.map 的 O(N²)。性能是否足够由真规模 gate 决定，不能靠此复杂度说明宣称测过。

## 5. 结果生命周期与展示分页

新增**派生报告缓存**（原数据库内）保存 report header、每 Task 的精确 summary、维度 summary、quality 分页和报告页。缓存没有 usage authority、无 native source、无价格受理能力，能随时删掉从原源重算；不拿缓存补缺失账本。schema 需正常 owner migration/lock 登记，迁移独立审查。输入 EOF/覆盖/native proof/完整价款状态全部通过后，专用 report reader worker 保留该 TEMP 连接，按稳定 output ordinal 读全部派生行，分批编码到平台管理的私有结果 spool。spool 是派生传送文件，不是 SQL 引擎/账本/原生采集来源；使用原已解析 operations/data root 的独立报告目录，权限和 job identity 绑定 actor/scope/generation。每页带 reportId、ordinal、payload count、prevDigest/payloadDigest，最后一个 sealed manifest 绑定完整页数、Task/维度/quality行数和 cumulative digest。读 TEMP 与写 spool 在专用 worker，**不**在原主 SQLite snapshotRead 回调 await 文件/网络；本新平台 report 机制允许明确的同步 spool 物理写，并纳入原架构副作用库存，不藏到纯领域函数里。不能把 TEMP 内容整包搬回主进程或用一个大事务写全结果。

仅当完整 spool sealed 后关闭原 snapshot、清理 TEMP、归还/销毁专用连接。之后 transport 按页从 sealed spool 读取，用原短写事务将报告页和 summary 索引写入**隐藏 staging**：`(reportId,ordinal)` 唯一，同摘要重送幂等、异摘要冲突；未 ready 的页任何列表/维度/overview 查询都不可见。所有 staging 页齐全且重算 cumulative digest/行数与原 sealed manifest 完全相等、当前权限/generation仍合法时，仅用一笔短 CAS 事务发布小的 `ready` header；完整 pages 已经在 staging，这笔事务不再搬运全量。PG pool=1 先归还 reader 再启动 writer，不同时占两个连接。building 不暴露已累计数字。失败/取消清除 hidden staging与未sealed spool；崩溃在 sealed之后可以核manifest恢复原同一报告的staging，崩溃在 sealed之前不能跨新输入快照接续半份结果。清理失败保留hidden状态并重试，不允许提前ready。

header 绑定 projectionVersion、完整过滤 scope、actor/权限版本、generation、asOf、原 usage/valuation/capture/fact 来源 watermark/digest、native pass refs。每一页和维度选择 cursor 都绑定 reportId/这些版本。所有响应重验当前权限；过期/权限变化/generation 变化不返回旧 scope，重新 building。明确的 asOf 历史快照可以展示，不能标签成当前实时。新到记录不混入旧报告，刷新构建新报告。缓存保留时间/存储清理只是资源生命周期，不改变某报告输入；被清理的报告重新完整生成。

ready overview **不返回所有 tasks、agent.tasks 或 quality.taskIds**：只返回完整 metrics、trend、状态与各维度 taskCount；分组本身也分页并提供完整 count。AW 复用现有 dimension-task list 导航但绑定 reportId；CS 增加项目/系统两级 task/dimension 明细 keyset endpoint。列表页任务数字来自 report_tasks，不用页内数据再汇总；任务名/项目名/算力名来自原公开事实。Task detail summary 完整，attempts/调用/ledger/trace/swimlane 是页；深层 Task/Agent 汇总也同样 exact+分页。图上显示完整四桶与总 Token，人民币只按完整可见金额。保留用户已经删除的“更多筛选”、CSV、“需要关注任务”卡片，不重新加入。

API：现有 GET overview 可返回 202 building 或非成功 not-ready/failed；POST/GET 构建与状态使用原统一 auth/errors。前端 loading 到 ready，失败标准 ErrorBanner/retry；后台阶段进度不是 Token 值。报告完成后的同水位读取/分页目标仍 P95<500ms；首次完整构建时间另记录，不能以旧<500ms同步目标为由偷读一部分。

## 6. 原生采集与补全：实际 EOF 而非现存 ledger 空页

新 v2 native traversal 协议经**原 usage owner 持久源**接续，不能把旧不可变 capture 改成 complete。输入端口是 `openPass({acceptedIdentity,sourceGeneration,root,lineage,epoch,phase:baseline|final})`，返回一个原 native SQLite 只读快照 reader；`next({cursor,pageBytes})` 返回 steps/session/path 页及 nullable nextCursor，只有原 session/part traversal 队列、非 step part 过滤、子 session keyset 都确认 EOF 才 null。part、session、step 的总计无上限；一页 CPU/bytes 不够只生成 continuation，不能 finish partial 后永不续读。

before-spawn baseline 在原接受之后冻结完整 native 快照，逐页持久 `nativeBaselinePage`（每页有限），原 owner ACK 后才允许该 baseline 的原 begin 完成；未完成不能宣称有恢复基线。采集发生在 native worker，不阻塞主 SQLite writer。baseline 的原 before 指纹/步骤 ownership 与实际 resume/root/turn 完整绑定，不依赖当前历史 stdout。fresh 的原空 baseline 语义与根身份保护保持。

final 仅在实际 process reap + stdout/stderr drain 后开新 native pass，逐页产原 measurement/revision 帧和 baseline-after/历史修订页。原 owner 按 passId、ordinal、prevDigest、payloadDigest 接收不可变 page；有序 cumulative digest/真实 EOF receipt 到齐且全部数字 frame ACK 后，才追加 v2 completion proof。partial/pending 旧帧原文保留，completion proof 明确引用全部页和前后快照、原 process outcome/invocation/root/epoch/source generation。每次平台投影核页数/有序摘要/ledger coverage 后才能 complete，不能只检查 pending=0。

原本 AW scannedSteps/10000/full baseline array、priorRevisions/100 summary、CS ownership 10000/baseline offset 10000 限制迁移为**每页** schema 边界和独立 continuation 持久行；完整总计为精确 decimal。AW includesRecord 从持久完整 baseline keyed membership 查询，不能用前10000数组；CS retainDevelopmentOverflow 不再丢弃第10001原 steps，改为原分页 ownership 写入与 ACK 后续。原 compact summary 可以继续限显示行，但资格用完整页/修订依据。原 native pending修复读取新增 continuation 任务到真实 EOF，原模型/历史修订必须在同一原 owner 上闭合，不产生第二个数值账本。

断进程/丢 ACK 可凭原 pass page 持久游标重送同页，payload 相同幂等，不同冲突。**跨 worker 重启不能把新的 native DB快照续到旧快照**：旧 pass 未 EOF 标记 interrupted，保留原页；从仍可用原文件重新开完整 pass，生成新 passId 并显式 supersedes/ref；**passId/supersedes 本身不是数值幂等依据**。在原 usage owner 持久化 `nativeEmission` 映射：accepted invocation、native source generation/root/epoch、原 step/recordId、完整 measurement payload 与其 fingerprint、eventId、revision、原 durable source row/watermark、pass snapshot generation及fence。发送前原 owner transaction 先冻结此映射，再用同一原 append source 提交；丢ACK/同pass重送逐字读取已冻结 payload，连 observedAt 也不能重建，event/revision完全相同才复用。不同 pass 若 canonical完整measurement fingerprint逐字相同可引用原 emission；新快照计数/模型/observedAt/原 scope不同，不得重用旧revision。原 event-conflict/revision-conflict/identity-conflict/decrease 守卫一条不放宽。

新 pass 产生变化时，旧 pass 的已发 measurement先按原顺序投影/ACK，旧pass以interrupted marker封住原source fence；这不是完整capture，也不提升数字资格。仅原 owner持有原 root/accepted invocation fence、确认没有旧pass待发来源帧、观察原current.observedRevision与全部pending revision高水位后，在同一 original owner SQL transaction/CAS 分配一个严格大于既有原revision的 revision并冻结新payload/event映射。分配与source append同事务，不能凭局部++或新passId分配；并发失败原事务回滚重读，不跳到別的invocation/source。已进入更新pass的旧fence不允许迟到旧snapshot再分配更高revision；其已冻结payload只能原字节幂等重送。owner历史修订的合法数值下降仍必须走原 correction/原native baseline归属证明及 source watermark，不把任意重新扫描宣告 correction。原 nativeUsageRevisions 所需原 owner completion/源水位不能用新pass名替代；未满足时保留not-ready等待或明确不可恢复，不绕过原完成判据。相同meter只由原reconcile折叠最新合法revision，不能将两个pass计数相加。完整 baseline 已经持久时可继续 final；baseline 尚未冻结完整且 spawn 已发生，不能事后拿当前文件伪装 before。

旧 AW/CS overflow/pending/terminal capture 的 repair 先读原完整 document/原 baseline/原 owner steps，只有保留了真正完整 before、after、source generation 和原 turn ownership 时，才能从可用原 native 文件或原保留 source pages 生成追加 `captureSupplement`。补全证明引用原 capture hash，不修改旧 proof/overflow，不冒用别人的 source/turn。对于不可恢复的历史 truncated baseline、已消失的原 native 文件、无出生/root 绑定，**明确 source-unavailable/unrecoverable；系统/项目范围没有完整数字可展示**。不能承诺通过重扫现有 ledger 恢复从未保存的信息，不能把选择范围自动缩小掩盖缺口。

文件路径/访问由原运行时 owner 和租约保护提供，不由统计模块猜 HOME/UUID；CS parent/end/retainUntil、容器出生/reap/PID/退出 guards 保持。生产开发 producer 在原 writer/ACK/基线/补全/退出全门通过之前仍 OFF，不用本协议绕开。非 OpenCode 来源必须按实际原 runtime 合同提供 EOF/退出和四桶语义，未知支持不能硬编码 complete。

## 7. 验收与发布

AW 真 SQLite +真 PG、CS 真 PG 同剧本验证至少201 Task、1001 invocation/attempt、10001 usage、20001 combined records、2001 captures，旧边界外四桶、人民币、模型/Agent/用途、趋势必须计入。全窗口与逐任务/逐调用完整分区之和一致；Task选中页数不得改变 aggregate。单 Task/单 root 巨组不可靠按 Task 分批规避。

算法 oracle 差分包括四桶不同 coveredThrough、null model/provider、多 provider、父子/跨 root、冲突 ancestry、先被 partial 排除的 summary 不覆盖后续 record、单条覆盖而非 union、模型过滤在选择之后、CNY部分覆盖、旧修订。10M self-total 不覆盖反例测峰值内存/临时磁盘与完成时间；100K Task/10M usage 原真规模目标保留，报告完成后的 ready P95与首次job时长分别报告。

native gate 包括10001+原 steps、超旧session/part/修订边界、断页/重复/丢ACK/重启/原文件消失/原 snapshot变化/模型迟到/历史修订、完整空 proof、old irrecoverable 不产 ready、producer OFF 与退出保护不变。四桶和费用最终要在 AW/CS 真任务逐原生记录对拍，不能只比较聚合JSON。正式页面中英文、390/768/1440px、间距、实际柱 Token、CNY、原名、keyboard/theme/network 验收。

实现顺序：设计门 → 正式文档/plan、分页端口与不成功partial合同 → 专用snapshot/workspace/覆盖索引/结果分页 → native v2持久页与补全 → 缓存/正式UI → 原回归与真规模/真任务 → 独立SOURCE/implementation → 精确提交、远端完整CI、CS本机部署。中间阶段不能 declare done 或开 producer。AW只跑 hosted tests/types/build/E2E，秒级自有format/lint/原AST登记允许；CS最终稳定候选只跑一次共同full，不收编他人WIP。

技术依据核对：PostgreSQL current `sql-set-transaction.html` 明确 READ ONLY禁止CREATE/ALTER/DROP，所以 TEMP先setup再只读写；SQLite `tempfiles.html`/`wal.html`说明连接私有TEMP和WAL快照，具体 Bun readonly TEMP 仍须真实数据库 gate，不能以文档替代验收。

用户再次确认：漏任何一条均是严重问题。三个版本都不允许以“最多200”等范围标签获得ready；真实范围全部源行/数字行/修订/分类需要一致的EOF与完整对拍，所有中间页限制只用于分批，不是统计上限。

独立设计回执：`observability-complete-statistics-design-review-v3.json`，SHA256 `726ef877e7797f628b6b6b63c23071a9e282bbedff544c2d3067dd36e860b242`。该回执只批准进入实施，不代替 SOURCE、真实数据库、全量对拍、页面、远端 CI 或部署验收。


## 2026-10-03 完整 EOF 底座接续

用户要求统计不能漏任何一条。任务、调用、用量、采集分别沿原 owner 游标读到真正 EOF；单页大小、排序块、合并路数和缓存容量只限制一次传输或内存占用，不限制总体数量。新底座保留原身份，在专用原数据库快照的 TEMP 工作区内进行稳定外部排序、四桶覆盖选择和逐条派生分配，尚未切换正式接口和页面。

完整 SOURCE31 v2 已独立 PASS，原 v1 的并发 P2/FAIL 保留。内存 SQLite 的 TEMP 创建、工作和清理已全部进入原 snapshotRead 同一租约；新增真实双 provider 的并发报告、既有 owner 事务、失败/取消后续报告和临时数据隔离回归。文件路径使用实际原 WAL 文件，PG 使用原 pool 的一次 reserve。源码本地提交 `9d539605a6c35c4fb6ef223aaae8b0280445189f`，此段不证明其 hosted 行为、远端发布或正式页面已完成。

原官方 scoped census 在该 source SHA 上生成完整 13 产物，排除并保留他人 EmployeeCase/CI 在制源码；报告只读尝试和缺少 seed 增长的静态 FAIL 均保留。纯治理投影复用生成结果，仅登记五项实际增长：mutation 1826→1829、observed imports 5809→5814、exceptions 5167→5171、symbol owners 25932→26021、physical SQLite fixture 文件 319→320。原 scanner、规则、40 required SPI、304 debt、target 69、273 inbound/31 outbound、background 352、public 1056 与 ambient 501 不变。SOURCE digest `sha256:15e57a059a299e942017fa56f89c6a025ebb98955013158876b8246da9639a79`；129 原库存静态核对通过。增长回执需在匹配 canonical 提交后由正常后继提交退役。

正式报告构建、分页缓存/接口、页面切换、native v2 的完整基线与原完成证明、100K Task/10M usage、真任务四桶/人民币和新 exact-SHA CI 仍待。既有正式链路的截断仍是待修缺陷，不能称为完整统计，也不能以本次底座 SOURCE 或旧真实任务回执替代新全量验收。CS 开发 producer 保持 OFF，两个 RFC 保持 In Progress。

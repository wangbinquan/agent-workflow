# 原 native owner 的完整分页接线

> RFC-371 `complete-statistics.md` §6 的实现细化。当前仍未接线，不代表移除了全部旧采集上限。适用 AW 独立部署和 CS 托管部署；CS 自身的开发与业务执行归各自原 owner。

## 当前实际断点

AW 的 `application/nativeUsageCapture.ts` 仍将 before/final 步骤与历史修订装入整份数组；`observationUsage.ts` 的 v1 capture 限制 1,024 session、10,000 step、100 prior revision、64 层 ancestry。`services/runner.ts` 在实际 accepted 后调用同步 begin，只在 reap/drain 后提交最后的原 capture。`NodeExecutionPersistence.appendEvents` 返回 void，缺少节点原归属时直接返回，不能作为 native page 已持久的肯定 ACK。

CS 的 `nativeCapture.ts` 仍将整份 baseline/history/final 转成 candidates，并在 16 MiB 后停止。`DevelopmentUsageJournal.capture` 返回 void，invalid capture、spool 超限或持久失败会记录 interruption，不能被解释为该帧写入成功。`BusinessAgentSupervisor` 的事件队列 processed 也不等于原 journal 已保存：持久失败之后它会继续消费以排空实际进程。原 native order 必须先持有 observer sidecar 的 immediate transaction，再打开原 SQLite read snapshot。

现有 complete report 已按原数据库快照读到真正 EOF。新的 native pass 读取器也能分页扫描所有 part/session/step、保留父节点引用及未完成步骤；这两项不自动修复上述 producer 和原 owner 的持久确认断点。

## 同一原 owner，四种持久事实

1. `nativePass` 绑定原 accepted invocation/turn、执行范围、原 native source generation、root、epoch、phase、原 owner fence，以及 before spawn 或实际 reap/drain 的既有运行事实。新 pass 不能从请求内容、当前路径或当前页面猜归属。fresh 空 before 仍必须使用原 fresh/birth/root 证明；resume 必须持有真正的 before。
2. `nativePassPage` 保存原 reader 输出的严格字段、ordinal、previous/payload/cumulative digest、扫描位置、精确 decimal 计数与 nullable EOF receipt。页数和总记录数无产品上限。单页 bytes/rows 只控制一次传输和内存；没到 EOF 就继续，不转成永久 partial 小计。
3. `nativeBaselineMember` 与 `nativeSessionParent` 按原 pass 和原 step/session 身份保存完整 before 及父关系。membership、after 配对、历史修订与 ancestry 覆盖在这个完整原索引上查询，不能用前 10,000 个数组或伪造空 ancestry。父关系与计量 scope 的原校验保持，v2 引用完整关系；旧 v1 历史不重写。
4. `nativeEmission` 只是原 source append 的冻结映射，不是第二个数值账本。它保存完整 measurement/event payload、fingerprint、eventId、revision、原 source row/watermark 和原 fence。新页产出的数字仍经原 observation source 与 reconcile 进入唯一 ledger。

这些表／日志均由现有 runtime usage owner 的持久接口操作。AW 的 task 原 fence 必须先取得，再取得 node aggregate root 锁，顺序与原 `fencedTaskId` 一致；不能绕开该顺序。CS 必须使用原 accepted journal key、Pod/incarnation、parent/end/retention 和既有终止证明；开发 producer 在所有接线门检视与退出验收通过前继续 OFF。

## 肯定 ACK 与失败

新增原 owner page 操作返回实际持久回执：原 binding、passId、ordinal、payloadDigest、累计水位和实际 source watermark。返回前在同一原 owner transaction 中校验原 fence、插入不可变 page、保存相关完整 membership／parent 行，并按原需要分配 emission 与 append source。没有原 owner、fence 不匹配、事务回滚、journal interruption、容量／磁盘不可用和提前关闭，都不返回肯定 ACK。

reader 只在回执逐字段匹配后调用 acknowledge，随后读取下一页。丢 ACK 后重送同页，只能返回原持久字节对应的同一回执；同 ordinal 不同 payload 是冲突。`appendEvents` 的 void、队列 processed、内存计数、pending=0 和 worker 正常退出均不替代这份 ACK。

before baseline 的所有原页及最终 EOF 回执持久且确认后，才完成原 before-spawn 观察操作。resume 的 before 尚未完成而实际 spawn 已发生时，不能事后扫描当前文件补成 before。磁盘容量不足必须暂停／报告原采集失败和范围未就绪，不能丢掉第 N 条后继续宣称完整。

## revision 与重启

原 stdout 的数字帧和 native final 都使用同一原计量 owner 的 revision 高水位。原 owner 取得当前 observed revision、所有原 pending source revision 和已冻结 emission 的高水位后，在原 fence 下 CAS 分配更高 revision，冻结完整 payload，并在同一 transaction append 原 source。不可用局部 `++` 或 passId 去重来绕开原 event/revision/identity/decrease 守卫。

同 pass 丢 ACK／进程重送只读取已冻结 payload，eventId、revision、observedAt 均保持。新 snapshot/pass 显式封住旧未完成 pass；旧已冻结帧可幂等重送，但旧 fence 不得为迟到快照分配更高 revision。新 pass 若完整 payload 完全相同可以引用原 emission；计数、模型、时间或 scope 变化必须由原 owner 合法新 revision／历史 correction 处理，不能相加两个 pass。

跨 worker 重启不能续用已经丢失的 SQLite read snapshot。旧 pass 标 interrupted，新原快照用新 passId 和显式 supersedes；完整已持久 before 可以继续使用，未完整 before 不可重造。旧 overflow、truncated baseline 或已丢失 native 文件，只在真正的原 before/after/source/turn 仍完整可用时追加补全；否则保留明确不可恢复状态，不能宣称该范围完整。已经归属并持久的原始记录可以继续呈现独立标记的已记录用量及人民币估值，保留真实记录数、调用覆盖数和定价覆盖数；不可确定的原归属或分类仍未知。

## 正式 completion 与投影

新的 v2 capture completion 引用完整 baseline/final pass、全部有序 page digest／精确计数、原 source watermark、全部 numeric emission 的实际 ACK，以及原 process reap/drain 和 root/source/epoch 事实。原投影验证所有引用逐页存在、顺序和摘要匹配、membership 与历史 revision 已闭合、四桶与原归属可确定，才取得完整 Token 资格。任一计量证据缺失仍 not-ready，完整 Token 总量保持未知；执行事实照常展示。同一范围内已经持久且归属确定的全部原记录应显示为“已记录”分类用量及实际人民币估值，明确标记不完整，不用完整 Task 子集替代，也不把缺口按零计。已收到记录自身存在未知分类时，不生成伪造的分类总量。独立费用覆盖保留全部已收到记录，即使没有报价也不能丢掉分母；金额不可见仍不显示金额。费率缺失显示 unpriced，金额不可见显示 hidden，都不降低已经成立的完整 Token 资格，也不补造人民币金额。

旧 v1 proof/schema 保留为历史适配器。正式 OpenCode producer 切到 v2 后不再用旧 snapshot 的 session/step/part/depth/time 总量预算，也不再用 whole-array before/final、prior 100、CS ownership 10,000／baseline offset 10,000 或 16 MiB 累计截断。CS 托管 AW 只读 CS 原持久页和原 platform ACK，独立 AW 走自己的原 owner；不能重复计账。

## 落地与验收顺序

先冻结并检视 v2 page/completion/scope 引用合同及原 owner 肯定 ACK 接口；再实现原 owner 持久页、完整索引、同事务 emission/source 和真实双 provider 回归。随后接入实际 before-spawn、worker final、reap/drain 与原投影；源缺失、丢 ACK、写满、重启、scope/revision 变化、深树及历史补全均保留明确失败语义。最后逐项移除正式 producer 的旧总量分支并验证实际 consumer 使用 v2。

验收必须包括每条原始身份与四桶的大规模比对、超过所有旧上限的真实 SQLite/PG、100K Task 与 10M usage 的 RSS／磁盘／延迟记录，以及真实模型任务、人民币验收费率、项目／系统／AW 页面核对。已有 reader 或纯 display fixture 的 PASS 不能代替这些结果。两个 RFC 保持 In Progress。

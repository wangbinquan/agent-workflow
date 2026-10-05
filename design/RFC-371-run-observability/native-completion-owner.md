# 原持久完成回执

首轮 SOURCE8 v2 的两项 P2 与 FAIL 回执保留。后继只修正最新修订选择和原页范围兼容性：同一真实数字帧内同一 record 的多次修订以最高已分配 revision 为准，complete→partial 与 partial→complete 均以最后实际状态判断；原 step 可引用同一 pass 中覆盖它的较后持久页，保持原 member.ordinal ≤ ancestry.pageOrdinal 以及全部原 scope／ACK／digest 核对。新增真实双 provider 同帧双修订、多页正向和缺页／超出引用页负向回归，不减少既有断言与预算。

确切 0cb05ac9 的主 CI／Windows 失败与三个定时页面 CI 成功终态各自保留。原 resume 数字用例的 source fixture 缺少 reasoning，而原输出归一化要求 output 与 reasoning 两项明确；后继只补实际 reasoning:0，原四桶断言仍为8／5／7／3，不把未知生产数据补零。必需进程时刻相等断言改用等价 Object.is 处理类型，未消费的便捷 public re-export 按并行原改动删除；实际内部原 span capture 保留。新的确切 SHA CI 验证后才能判断修复效果。

本片延续已批准的 native-owner-contract-v2.md。实现完整页／数字来源／过程／历史资格的原数据库核对与原 completion source append，不表示正式 producer、v2 投影解析或历史修订 producer 已上线。AW 既有页面继续呈现已收到分类 Token 和人民币。

`drizzleNativeUsageCompletion.ts` 在原 Task claim 和 node transaction 中从真实 preparation/current pass heads 生成小型 completion 引用。每个 head 持续遍历到实际空页；多个实际 root 不能任选其一。before/final 的原 binding、所有原页、游标、摘要、索引、精确 decimal population 与实际冻结 ACK 沿既有 pass verifier 逐条核对。resume 没有可用完整 before 时保留 partial，不能将旧 part 变成新调用消耗。

`nativeUsageEmissionVerification.ts` 每次最多读取20个原 source mapping，再批量读取其实际原 source，持续到真正 EOF。原 request/fingerprint、冻结 ACK、实际 source row与归属必须一致；每条原 measurement的数值、scope、模型、时间与分配 revision 逐项核对。所有旧 partial completion 也先核对其原 source 和ACK，只在核对后排除出数字帧摘要。实际 spawn／reap／drain保留同一原 process 身份；完成观察时刻不能早于原数字与进程事实。

`nativeUsageNumericCoverage.ts` 逐400个原 final step查询真实 before membership和最新原 source locator，持续到 EOF。每个真正的新 step都必须有对应原数字来源，四桶保持 nullable。没有模型、step time或人民币费率不降低已成立的 Token完整资格；未知 Token桶和最新原数字来源的 partial coverage 分别明确 partial，保留已收到数字，不能补零。

`nativeUsageReconciliationVerification.ts` 对全部原 before step配对实际 final，查询原 source/root/stable part下所有历史owner到 EOF，只有唯一实际历史meter和原 capture才可归属。每个原 packet批量读取历史 capture；scope缓存只保留当前400条 packet。原完整父链、历史数字／模型／当前水位及原 ledger correction逐项核对，形成不包含人口数组的 examined/resolved/unresolved和连续摘要。缺历史owner、未闭合修订或被移除的原 step不会取得 complete。本片只复核原 ledger中已闭合的历史修订；新的有界历史修订生产者仍需后续接线，不能拿本方法代替修订writer。

seal重送先返回原冻结source/ACK；新seal重新从原关系核对小型completion全部字段，并在同一原事务追加原observation source与冻结ACK，真实提交后才返回肯定回执。partial仍允许后续实际页和过程事实完成；complete封住原preparation。保留旧completion记录及原源映射，不形成第二套Token账本、不重写旧报告。

双provider回归覆盖1001实际原步骤、完整零step EOF、未知模型／step time、缺final／process、partial到complete与丢ACK重送、假计数、丢原数字source、早于实际观察时刻，以及原v1历史source经真实投影后resume仅计新step、历史原ledger correction前后资格。每个旧断言和预算保留，本机不执行AW tests/typecheck/build/service；由确切SHA hosted CI验证。

正式numericPages仍默认OFF。本片仍在原Task写事务中遍历完整证据，长baseline／大规模写锁和内存／延迟须真实测量后处理；另存的readonly baseline snapshot原型未接消费，不在本片源码候选中。原v2 captured/ingest/ledger/qualification投影接线、全部before/final生产接线、历史修订writer、CS journal／Pod incarnation与实际100K Task／10M usage继续。两个RFC保持In Progress。

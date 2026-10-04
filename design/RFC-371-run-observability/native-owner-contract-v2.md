# 原 owner v2 合同

本合同细化已批准的 `native-owner-pages-v2.md`；当前只冻结合同，producer 和正式投影尚未接线，不表示旧采集上限已移除。

## 原始页、EOF 与 scope

`observationNativePages.ts` 是原 reader 单页的严格合同。计数、扫描位置、ordinal 和 source watermark 都是无总量上限的 decimal。单页行数和字节预算仅用于传输；reader 必须持续到原 session、part、child 与磁盘队列全部 EOF。摘要按 reader 原始字段顺序计算；owner 校验 schema 后仍用原始 payload 验证和冻结，不能以 Zod 重排后的 JSON 替代。

`observationNativeCompletion.ts` 的 EOF 引用携带实际 ACK、完整页数、最终累计摘要和原 population。owner 沿所有 ordinal 检查每页 previous/payload/cumulative digest、扫描位置、精确累计 counts、索引成员和最终 EOF。只存在最后一页 ACK 不代表整个 pass 成功。

v2 scope 保留 root/session/parent/turn/level，使用原 final pass identity、owner receipt、原页 ordinal 和累计摘要引用 `nativeSessionParent` 索引。原原生 step 与 session 都必须存在，整条父链必须已经在引用的已持久页范围内；查询从当前 session 到 root 的父链接，拒绝缺失、环或冲突。这样提前中断时已经归属确定的原页仍能提供已记录数字，而完整资格仍单独要求整个 pass 的真实 EOF。覆盖算法按完整父链接处理，不能省略 scope、补空 ancestry 或采用前 64 层。旧 v1 仍读原 ancestry；不重写历史。

## baseline 与 process

resume 的 before 是原 spawn 前已经确认的完整 baseline pass；final 与 before 的 invocation/source/generation/root/lineage/epoch 必须相同，examined 必须等于全部 baseline step 数。每一条原 baseline 身份都做 after 配对及历史归属修订；不存在 after 与扫描未覆盖是不同事实。

fresh 只有在原 owner 持久 before-spawn 操作回执、原 runner 的实际 spawnedAt、原 SQLite root 的实际创建时间共同成立时，才可证明空 before。owner 校验 preparedAt 不晚于 spawn、root birth 不早于 spawn，并绑定该实际 root/source generation；请求 fresh 标志和事后扫描不充当 before。时间或原 root birth 缺失时保留 partial，已归属数字仍可展示。partial 的 before 回执、准备时间、root birth、root 与 spawn 时间可明确为 null；resume 缺 before EOF 时 pass 可为 null，final 中断可保留真实最后页 ACK 的 finalProgress，并让 final EOF 引用为 null。这些 null 从不满足 complete 的必需证明条件，已经提供的矛盾事实仍必须拒绝。

completion 独立保留实际 reap/drain 时刻和观察时刻。不可 reap、未排空或任何归属修订未闭合都不能取得 complete。Token 资格不依赖人民币费率；缺费率保留真实定价分母，金额隐藏保持原策略。

## 原持久 ACK 接口

`task-execution/application/ports/nativeUsagePersistence.ts` 是 Task 内部原 owner 接口。binding 必须来自原 accepted invocation 与真实 `TaskExecutionContextRef`，先执行原 Task fence，再取原 node aggregate lock。identity 的 lineage/epoch 必须与该真实 claim 对应；nativeSource、source generation 和 root 来自原 runtime 的冻结事实。任何写事务只处理原数据库，不在其中读取原 SQLite 文件或做网络/文件 IO。

prepare 在实际 before-spawn 操作中持久原 binding、source generation、准备时间和 resume root；fresh 此时 root 尚未出生，明确为 null。admit 引用该原 prepare receipt，再冻结初始 cursor、owner receipt 与原 binding；rootCreatedAt 必须由 reader 打开实际 read snapshot 时从同一原 root row 读取，并在 admission 中保存，seal 只核对该原持久值。缺失可为 null，不由当前文件的事后读取或请求值补造。相同 pass 丢 ACK 可重发；丢失 read snapshot 后必须用新 passId 和显式 supersedes，不能从已经变化的文件续旧 pass。persist 在同一事务保存原 immutable page、所有 parent 和 step membership，真实 commit 后返回原 source watermark。interrupt 只封住指定原 pass，不删除已收到页。baselineMember 只有原 baseline EOF 全部确认后才可排除旧 step。

emit 冻结 eventId 和完整 measurement/event payload，并在原 Task fence 下取 observed、所有 pending source 与 frozen emission 的 revision 高水位，CAS 分配后同事务 append 原 observation source；ACK 引用实际 source row。重发同 eventId 返回原 payload/revision/observedAt；不同 payload 冲突。不得把 void append、pending=0、队列 processed 或 worker 退出当作 ACK。

seal 在所有原 page、baseline 对照、numeric emission 实际 ACK 与过程事实验证后 append 原 completion source。emission 仅保存原 source 的冻结映射，不是第二个数值账本；数字仍由原 source projection 和 reconcile 进入唯一 ledger。无报价不会省略数字及记录分母。

## 接线与验收

本批只定义上述严格合同及 port，暂不导出到正式 v1 schema 或改动原生产 runner。下一批实现原 owner 持久页、父关系/membership、同事务 emission/source、逐条 baseline 对照和投影解析；之后接入真实 before-spawn/final 并替换旧 producer。必须核对真实双 provider 的丢 ACK、回滚、stale fence、重启与所有原行 EOF；未通过前 CS 开发 producer 继续 OFF，两个 RFC 继续 In Progress。

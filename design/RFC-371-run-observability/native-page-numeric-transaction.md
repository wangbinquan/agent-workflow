# 原页确认与数字记录同事务

本片落实已批准的 `native-owner-pages-v2.md` 的原 owner 页确认断点。正式 producer 仍未切换；这不是两个 RFC 或完整采集链路的完成声明。

`DrizzleNativeUsagePages` 的原 Task 事务可以启用数字页写入。先保存该页的原 session／step 索引与文档，再用同一事务生成原步骤的 measurement、分配原修订、追加原 observation source 并冻结 emission ACK，最后确定该页的真实 source watermark。对外只在原事务提交后返回页 ACK。任何数字帧失败都回滚该页、membership、修订索引和 source；重送已提交原页直接返回其冻结回执，不重算观察时间或重复追加数字。

每个原 source 帧至多传输 500 条 measurement，原页至多传输 1000 条原行；这是单个包的工作量，不限制调用、步骤、会话、页数或树深度。新的数字页 writer 不保存完整调用的人口数组。续跑只从实际完整 baseline pass 的 membership 排除旧步骤；缺 before EOF 时保留原页，不把旧步骤归到本次调用。已知的输入、缓存读取、缓存写入和输出即使缺原生模型或时间仍落入原 source；未知字段保持 null。

修订分配沿全部原 pending 与已投影 source 读到真正 EOF。原帧内按记录批量读取 frozen／observed 修订，再按原顺序分配，包括同一帧重复记录；批量 upsert 保留最大原修订。追加的 `source:<record hash>` 只定位实际原 source row，供后续 seal 逐个核对原数字，不持有第二套 Token 数字。原 emission 仍只冻结该原 source 的映射。

`verifyNativeUsagePass` 从 admission 到末页逐页检查原 cursor、ordinal、扫描进度、计数、payload／累计 digest 和单调 ACK watermark，并核对每个原 parent、step 文档及三个关系的完整行数。它不把最后一个 ACK 当作前面各页已经齐全；partial 只能验证已收到的真实进度，不能满足 EOF。每次最多解码八页，全部页仍检查到底。

原双 provider 用例新增：1001 个实际原生步骤分包后全部落入原 source、丢页／丢 parent／丢 step／改文档／多行／改 header、真实 interruption、续跑完整 before 与缺 before、原数字失败的整页回滚，以及模型／时间缺失仍保留四桶。原 10001 步骤／1025 会话／80 层／37 条续页正例同时新增完整原页检查。旧测试人口、断言和预算保持，物理 SQLite fixture 仍复用原两个构造点。

首轮有限 SOURCE13 的两项 P2／FAIL 原回执保留：数字页仅看 before EOF header，可能把缺失的旧成员误算为新步骤；末页 ACK 的 watermark 也未与原 pass 的冻结末 ACK 精确联校。后继在数字页原事务里先逐页核验完整 baseline、所有 membership 与实际行数，结构性缺口不归属；原模型／时间／分类缺失独立保留，不丢已知数字。同时末页 ACK 必须与冻结末 ACK 深度相等。两个原缺口分别新增真实丢页／丢 step 不误计及末页水位改变的回归。当前完整 before 核验仍逐数字页执行，单次解码有界；长 resume 的重复扫描性能与真实大规模验收仍待后续生产切换批次解决，本片不声明规模验收通过。

原 `c83bf7505` CI 日志还指出本片 owner 的归档 callback 类型错误、父链循环的类型推导错误、归档计数索引的 nullable 类型、进程测试 nullable 时间断言，以及 HTTP provider 用例误用 `.run()`。这些按原数据和断言修正，不放宽原规则、扫描器、覆盖要求或预算。同期 native material 的旧 source oracle／债务／公共 consumer 另有并行在制修复，未收编或覆盖。

两个原 Windows run（`1f0a2dc1`／`c83bf7505`）均在第九项 held receipt 用例前停住，最后八项已经通过，之后没有测试输出直到作业上限取消。该用例在调用方仍要释放 receipt 时提前构造 Bun 的异步拒绝 matcher；这被视为待 hosted 验证的悬挂原因候选。后继仅改为先挂普通 Promise 的结果监听、真正释放后再断言 rejected 和原 Error 对象身份，原 receiver、未提前 ACK、settlement 空值断言及预算保持；同文件的有意 partial fixture cast 只补擦除型 unknown 中转，运行期不变。没有将取消记为成功，也没有增加 timeout 或减少断言。

本机只执行本片精确格式／lint 和原纯静态生成，不跑 AW tests／typecheck／build 或启动、更换服务。独立功能门、matching canonical 登记、发布和新确切 SHA 的正式 CI 各自验收。后续仍要完成原 process facts 的生产传递、resume 历史修订对照、完整 seal 与投影、正式 v2 producer 接线、CS 的实际 journal／Pod owner，以及真实 100K Task／10M usage。两个 RFC 保持 In Progress。

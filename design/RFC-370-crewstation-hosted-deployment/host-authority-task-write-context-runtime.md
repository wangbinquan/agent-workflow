# RFC-370 Task 宿主写上下文 W1 有限实现候选

本片实现已复核 D2 的独立端口与持久参与者，不关闭实际 Task 调用者、H7／A-G 或 CS 部署。原设计、R1 FAIL、D2 PASS 和开始编写前的 root 消费记录完整保留。

SO application 的 `HostExecutionWriteContext` 只提供具名生命周期与原 grant 配对查询。`infrastructure/drizzleHostExecutionWriteContext.ts` 复用原会话、原聚合行锁及 SERIALIZABLE，一份实现覆盖两个数据库。它登记实际 prepare COMMIT 后的 opaque receipt，原 reference、holder、generation 和 revision 同属这一 binding；activate／renew／drain／retire 不把嵌套 Task 事务未提交的值冒充 durable ACK。新的安装执行行沿原 SQLite 与 PostgreSQL 安装链追加，不在启动或事务体临时创建表。

`public/participants.ts` 仅提供新工作、恢复和已发出回执三个具名事务参与者。原平台事务帧新增原 client／transaction 配对查询，参与者消费调用者已经打开的同一事务；不另开事务，不请求 CS，不提供通用 SQL callback。Task application 自有端口不含数据库、SO DTO 或 SQL 面；本模块 `infrastructure/hostExecutionWriteContext.ts` 保留原方法、receiver、receipt 和事务对象，后续原 Task SQL 体成功后再调用最终参与者，失败整体回滚。

新工作只接受 active 且尚未到期的执行事实；恢复只接受 preparing 且尚未到期的事实。资格在实际锁 ACK 后读取，等待行锁不能延长有效期。已发出回执允许 active／draining，包括有效期已到而尚在退场的原 receipt；后续调用者仍须先满足原 Task owner／effect 条件，不能借回执入口派发新工作。retire 只在 drain 后由生命周期等待真实受理事务和回执水位再调用；revision 切换后旧 receipt 不复活。

SQLite 首轮原生成器因为既有 journal idx 与 0241 tag 的编号差异写入同名 snapshot；保留首轮完整输出，只移动本次新候选到 0242，历史 0241 snapshot 和原 222 表 payload 字节保持。PostgreSQL 首轮因缺少新表的 exact roster 登记拒绝，保留失败日志后只新增这一表及 SO owner 登记，再沿原 immutable append helper 生成 0018。旧规则、旧表、旧迁移及旧 journal 前缀不收缩或重写。

已编写双数据库真实原事务用例：preparing 恢复与新工作回滚、active／renew receipt 保持、draining 到期后的真实回执 SQL、原业务错误对象优先、旧 receipt 与新 revision、独立数据库／binding、原嵌套事务与外层回滚、control durable ACK 以及原方法／receiver。未在本机运行这些 AW tests／typecheck／build／service／E2E；格式／lint、静态原字节／安装 artifact 核对、独立实现门和后续 exact-SHA hosted CI 分别记录。

本片没有改 Task 原 claim／intent／effect／ACK 方法，没有把端口装入 Task execution context、heartbeat、runner 或实际 provider roots。prepare 也不会覆盖未退休的旧行；崩溃恢复必须先由后续完整 recovery 绑定给出旧受理工作的实际结算事实。resource-only 零执行、全入口早期准入、19 owner、UI 与 M0～M4 仍开放，不能把本片 adapter 的用例当作全量部署验收。

## SOURCE18-R1 F01 接续

原实现门有效稳定 FAIL：receipt 只保留持久身份，失去原 grant 的 current 方法及 receiver。在宿主已报告失权、持久 drain 尚未完成的窗口，active／未到期行仍可能允许新工作。原失败回执和 root 实际消费记录不改写。

本接续将准备入口捕获的原 current 方法及 receiver 保存在私有 receipt identity。prepare、activate、renew、新工作及恢复在原 SQL 实际 await 后继续检查原 grant；失权会使同一原事务的完整业务 SQL 回滚，不修改原业务错误的优先顺序。drain／retire 和已发出回执不要求 grant 仍 current，保留实际退場和结果收取能力。没有新增事务、CS 请求或实际 Task caller 接线。

原十个双数据库案例的全文、断言与预算保持，追加两个真实原事务案例：preparing 失权后替换 current 属性不能替代原方法及 receiver；active 行尚未 drain 时在实际 SQL await 中失权，业务写入回滚、renew 拒绝、已发出回执仍提交。新增案例未在本机执行，实际结论交独立实现门与 hosted exact-SHA CI。

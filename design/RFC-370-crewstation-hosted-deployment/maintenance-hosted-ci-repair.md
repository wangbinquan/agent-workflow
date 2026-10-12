# RFC-370 maintenance：e8057 的实际 CI 修复

本片只处理确切 `e8057a6f5de88a96c5846d77e62ab5e2984e2933` 暴露的 maintenance 功能与配套问题。累计使用量仍由「设计运行观测统计全景」负责。原 maintenance SOURCE-R4／MATCHING-R1 与发布记录保持；它们不代签本次修复，也不代签 hosted CI。

## 已取得的失败证据

- 主 CI `38203511068` 的检查作业 `114661829506`：新 cold service 测试第 636 行直接读取可选的 `eventLoop.sampleCount`，TypeScript 报 TS2532。`MaintenanceStatusSchema` 为旧 embedders 保留 `eventLoop.optional()`；生产合同不应因此改成必填。
- 完整 Windows `38203511110`／作业 `114661829458`：真实 Worker 的 SQLite 案例在 finally 的 `rmSync(appHome)` 报 EBUSY。现有 finally 会遮住此前保存的场景错误，不能据此声称所有 drain 断言已经通过。仓内 `tests/fixtures/tempDir.ts` 记录了 close 后 bun:sqlite 仍持有文件句柄、Windows GC 才释放的同类实证。
- 主 CI macOS 分片 1／作业 `114661829724`：原 W5 判据发现 `maintenanceWorkerSupervisor.ts` 新增一条没有链上拒绝处理器的 `void Promise.all(...).then(...)`。修正调用链，不增加原 debt 账本。
- 主 CI macOS 分片 12／作业 `114661829795`：原 spawn 判据数到同一 supervisor 六处 `spawn(...)`，原登记仍是五处。第六处是 cold explicit start 调用同一原包装函数；应如实登记这一处及原因，所有原 matcher、语料与断言保持。

原始日志保存在本次外部冻结材料，正式结论等待这次修复 SHA 的完整主 CI 与完整默认 Windows；原失败流水线继续运行到终态。

## 有限修正

`rfc370-maintenance-cold-service.test.ts` 复用本文件已有的 `toMatchObject({ eventLoop: { sampleCount: 0 } })` 判据。它仍要求真实 status 包含零采样值，缺字段也会失败，不使用 optional chaining 或非空断言放宽结果。

`rfc370-maintenance-cold-real-drain.test.ts` 保留真实双 provider、同一个 Worker、全部 pending／running／succeeded／下一任务零认领、effects dispose 与实际 drained 断言及原 40000ms 预算。清理依次尝试 stop、channel close、database dispose、严格目录删除；每一步的错误与场景错误完整收集，最终仍失败，并在错误正文保留原事件序列及实际错误。多个错误用 AggregateError 作为 cause，单个错误保留原 cause。Windows 只在实际 database dispose 之后调用与现有 SQLite 测试夹具相同的 `Bun.gc(true)`，随后仍由原 `rmSync` 严格删除；不吞 EBUSY、不改 warn-and-leave、不加重试预算，不以测试清理替代生产 drain ACK。

生产只修改 cold `awaitDrained` 这一段：为原 Promise.all 成功回调链补 `.catch(reject)`，让等待者收到实际读取／回调错误，并保持原 receipt 人口、超时错误、清 timer、迟到 ACK 与下一代等待规则。原 W5 文件与 debt 全文不改。顺带修正本段已确认的 deadline 存活缺陷：正在 await 的 actual drain timeout 不能 unref，否则 Worker bare close 后进程没有其他 handle 时，等待者会先随进程退出而收不到超时拒绝。只去掉这一处 unref；其他 native watchdog、handshake、restart、normal pause／stop 的原预算及 unref 均保持。

`rfc284-spawn-site-ratchet.test.ts` 仅把原 supervisor 那一条 count 从 5 改为 6，并说明 cold explicit start 的新增调用仍经过同一个原包装函数及 receiver。其余登记和全部原测试正文保持。

## 必要回归与验证

保留 service 原 17 案例、supervisor 原 14 案例与真实 Worker 双 provider 原案例、所有旧断言和预算。仅向 supervisor 文件追加两项有外部可见判据的回归：实际 clearTimer 抛错必须沿 awaitDrained 返回同一个错误，不能成为进程级未处理拒绝；独立 Bun 子进程导入实际 cold supervisor，真实定时器、同一注入 Worker、ready 后 quiesce 与 bare close，除了 actual drain deadline 无其他 handle，17ms 后必须输出原超时拒绝的标记。子进程 3000ms 仅作异常退出上限，不延长产品 deadline；父进程断言 error／status／signal／stderr／stdout 五项。

原三套登记不增加新的测试文件：修复后预期 Ubuntu（双 provider）35、macOS（SQLite）34、Windows（SQLite）34，共 103 次 maintenance cold 目标执行，尚未运行。Windows 原完整默认入口照常收录这三套。

实施前后分别做有限、稳定的独立功能门，根实际消费全文材料与正式回执；只在内容改变后按原 scoped census 规则生成必要配套，核对 sourceDigest／原判据及其他行不被改写。只做限定格式／lint、纯语法与字节保持检查；不运行本机 AW tests、typecheck、build、service 或 E2E。精确路径发布、完整 hosted 主 CI 与完整默认 Windows 总绿是恢复新增 RFC 实施的门槛。

本片不关闭完整 H7／十九 owner／三个生产启动根、A-T7／A-G、各层独立 CS adapter、实际 M0 部署与后续 M1～M4。AW 尚未部署到 CS，RFC-370 未完成。pump SOURCE-R2 和 MCP stored queries DESIGN-R1 分别保留，新增适配实现等待 CI 总绿。

## 2026-10-12 有限修复源码候选

DESIGN-R1 母 21 项及独立 service 补充 2 项均有效稳定 PASS、0 findings，root 已实际消费全部正式回执、可读审阅和首／closing／末 EOF 字节绑定。原失败、母 103 计划及补充改为 106 的过程保持。

候选仅含两个原生产文件、四个原测试文件及本设计和 service 补充。supervisor 的实际排空等待删除一处 unref、末端 catch 把原 clearTimer 错误交回等待者；service 只删除自己 cold 实际等待的一处 unref。所有 native 定时器、原默认和显式预算、同 Worker 真实 ACK、待处理 admission 和迟到 ACK 责任保留。

真实 Worker 夹具的三项 release 与 stop／channel close／database dispose／严格 rm 按原次序逐一尝试并收集错误，单一原 cause 或全部 AggregateError cause 继续使场景失败；Windows 的 GC 仅放在数据库 dispose 后、严格 rm 前。原同一 Worker、双 provider、全部业务断言、15000ms 阶段等待和 40000ms 测试预算保持。原可选 eventLoop 改用同文件已有严格嵌套匹配；spawn 原一行登记 5→6，其他 matcher／登记／W5 debt 不改。

仅追加三条回归：同一 clearTimer Error 身份、fresh Bun 的 supervisor bare close 无 ACK 超时、fresh Bun 的 service 实际 enqueue pending 超时。两个子进程均调用原 cold 实现及真实 17ms deadline，父进程 3000ms 故障界和五项正常退出／精确输出判据。最终原三套为 service 18、supervisor 16、真实 Worker 每 provider 1，预期 Ubuntu 36／macOS 35／Windows 35，合计 106；此时实际运行仍为 0。限定格式和 lint 成功，未运行本机 AW test／typecheck／build／service／E2E；SOURCE、唯一必要原生成／MATCHING、精确路径上库和新 SHA 总 CI 后继另验。

## 91024 的 hosted 执行与 service 子进程入口修正

`91024cb54423eedb66e70c60679c7a86b0e16602` 的完整 Windows `38210956922`／作业 `114684775237` 实际为 1437 pass、3 skip、1 fail。原真实 SQLite Worker 排空、17 条原 service 案例及 16 条 supervisor 案例均通过，35 个 cold maintenance 目标案例中实际 34 pass、1 fail。唯一失败是新增 service 子进程案例的退出码为 1；原断言没有展示捕获的 stderr，因此不能把具体子进程错误冒称为已由日志确认。maintenance 持续运行检查 `38210956834` 已成功，主 CI `38210956816` 仍须跑完，完整总绿尚未取得。

同 SHA 的 macOS shard 8／12（`114684775400`）为 1536 pass、1 skip、1 fail；Ubuntu shard 12／32（`114684775440`）为 795 pass、1 fail。两份完整原日志均只有同一个 service 子进程用例失败，退出码为 1；也未展示 child stderr。两平台的其它分片及整个主 CI 终态另验，不以这两个分片代签全平台或全仓结论。

有限修正只涉及该 service 测试的两行：用已有 `join` 从 `tests` 目录选到 backend 目录启动子进程，使它使用包含 `@/* → src/*` 的原 backend `tsconfig.json`；退出码仍严格要求 0，但失败消息附上实际 stderr。backend 的 bunfig 预加载配置仅属于 test，子进程仍执行原 `-e` 脚本。真实 17ms deadline、3000ms 故障上限、完整 Config／注入对象、所有原业务及五项结果判据、18／16／每 provider 1 的人口均保持。下一 SHA 的 hosted 实际执行负责验证该入口修正，若仍失败则使用 stderr 继续定位；不增加案例或放宽结果。

本片没有生产源、依赖、生成规则或架构库存变化，复用已消费且已上库的原生成配套；不再运行整个 census。仅做有限格式／lint／纯语法／逆向全文保持检查及独立实现门，随后精确两路径发布并等待同 SHA 完整主 CI 和完整默认 Windows 总绿。原失败继续保留；累计使用量、其它会话在制内容、完整 RFC 与 CS 部署均未被本片关闭。

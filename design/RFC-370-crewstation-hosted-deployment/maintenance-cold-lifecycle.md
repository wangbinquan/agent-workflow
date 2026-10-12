# H7：维护服务的冷构造与实际 Worker 收据

状态：2026-10-12 设计候选，属于已批准 RFC-370 阶段 A。确切 `77033f619e9c6839c6de9f23e791ed81ae99a577` 的主 CI `38159007086` 已完成且 72 个作业全部成功；恢复推进前置已满足。本片尚未实施，不改变 [实际根装配图](host-execution-root-assembly.md) 的十九 owner、三根、A-T7／A-G 和先 M0 部署再 M1～M4 的完整范围。

`platform/background/maintenanceService.ts` 当前在构造时安装采样、固定作业、开机、checkpoint 与 schedule 的 timer，并立即调用 `startSupervisor`。原 `createPausableDaemonRuntimeServiceBindings` 随后 pause 已经开始的服务，因此它适用于原 native 根，不能表达 selected resource-only 零执行。原 supervisor 的普通 pause／stop 会在 10 秒后 terminate 并 resolve；这一结果也不能表示失权后原作业和 effects scope 已实际排空。

本片补维护 owner 的中立生命周期和现本机实现。保留原 `startMaintenanceService` 与 `startMaintenanceWorkerSupervisor` 的默认时点、重启、timeout、通知、配置和关闭政策；selected 的冷构造与实际收据采用独立完整入口。平台 Worker 代码只处理 start、ready、停止新 claim、drained 和正常关闭，不解析宿主 grant 或 CS wire DTO。system-operations 的 composition 将实际 grant 的 current 回调和机械生命周期配成维护 owner；其他模块只能通过 public participant 消费这一装配。

## 合同与构造

新增冷维护服务入口及其完整机械生命周期：`start`、`quiesce`、`awaitDrained`，并保留 `status`、`reconfigure`、`runSoon` 和正常 `stop`。冷 Worker supervisor 提供相应的 start／ready 与停止新 claim／drained 合同。调用者必须一次交出完整冷 supervisor 工厂；缺方法或混用普通 supervisor 时，在 timer、enqueue 或 Worker factory 前明确拒绝，不补 native 默认值。

平台侧的新增入口采用以下形状；current 只是一份由 owner 捕获 receiver 的动态回调，没有跨线程复制宿主对象：

```ts
interface MaintenanceExecutionLifetime {
  readonly current: () => boolean
}

interface ColdMaintenanceService extends MaintenanceService {
  start(lifetime: MaintenanceExecutionLifetime): Promise<void>
  quiesce(lifetime: MaintenanceExecutionLifetime): Promise<void>
  awaitDrained(lifetime: MaintenanceExecutionLifetime, timeoutMs?: number): Promise<void>
}

interface ColdMaintenanceWorkerSupervisor extends MaintenanceWorkerSupervisor {
  start(): Promise<void> // 本实例真实 ready ACK
  quiesce(): void // 同步关闭重启／wake，并发送本实例 drain
  awaitDrained(timeoutMs?: number): Promise<void> // 本实例真实 drained ACK
}
```

冷 options 用完整 `createSupervisor` 替代 native `startSupervisor`，工厂在调用时交出不创建 Worker 的完整冷 supervisor。机械层按原对象身份检查 lifetime，后续调用不得换一个同名 current 回调来混用旧实例。system-operations composition 从已有 `HostExecutionGrantContext` 固定原 current 与 receiver，并把其 provider／generation 所属的这一份机械 lifetime 交给同一服务；platform 不向 system-operations 反向 import。普通 pause／resume 保持原暂停职责，但 cold resume 必须有已经绑定且 current 的 lifetime，不能成为绕过首次 start／ready 的另一个入口。

冷服务只读取配置、捕获开机前的 intent turn IDs、打开同一准入 store、维护既有 projection 和配置通知。构造、status、reconfigure、冷 stop 都不得创建 Worker、安装执行 timer、enqueue、boot recovery 或 wake。资源状态仍使用原 `MaintenanceStatus`：无 Worker 时为 stopped，nextRunAt 为 null；原 last／backlog 和计数投影继续可读。事件循环采样可以在 start 时安装；冷态 sampleCount／maxGapMs 为零，不能虚构执行或就绪。

冷 store 与之后的运行实例共享同一 store 和可选 close receiver，只关闭一次。native 和 cold 使用同一状态投影函数及 payload／admission／schedule 核心；不复制一套 job catalog 或重写旧服务。冷 start 使用当时的配置，开机 turn 集合仍是 HTTP admission 开放前的既有快照。原原子 enqueue、job／slot 去重、错误分类、退避和通知行为保持。

## 激活、失权与普通关闭

维护 owner 的 start 先绑定当前 lifetime，再启动同一冷 supervisor，等待该 Worker 的有效 ready／catalog ACK；只有此后才能打开新 admission、建立原 schedule／fixed／boot／checkpoint timers 并声明该 owner ready。同一 pending start 幂等等待，不重复建 Worker。握手失败、关闭或 start 期间失权会使本次 start 失败，保留原对象和清理责任；不通过普通 native 自动重启宣称 selected 新一代已就绪。

main admission 在异步 payload 读取后、原 enqueue 调用前读取同一 lifetime 的 current；receipt 返回后失权只抑制新 wake，仍消费原 receipt 和 projection。停止新 admission 时保留原 deferred slot；它们在后来获准启动时重新检查 current，不携带旧代就绪。runSoon 在冷态或失权状态返回明确未就绪错误；status、配置与既有 projection 读取保持。错误由后续真实根的统一 availability API 表达，本片不把它伪装成成功派发。

quiesce 同步关闭 main admission 和所有新 timer／wake，停止自动重启，并向同一 Worker 发送现有 drain 帧。Worker 原 `draining` 分支在下一次 claim 前退出，当前 claim／job、terminal receipt、heartbeat 和 effects／数据库 close 继续走原路径。仍在 await 的原 claim 属于此前已启动的在途操作，由同一 lifetime 等待；不得转成取消或为它另发任务。

awaitDrained 等待同一 Worker 的实际 drained 帧。`maintenanceWorker.ts` 只有在 processing 结束，heartbeat、effects scope 与数据库关闭全部 ACK 后才发该帧，所以单独 completed、Worker 被 terminate、普通 pause resolve 或裸 close 事件都不充作这一收据。超时返回明确失败并保留未结算 lifetime、原 Worker 和等待的 ACK；稍后收到实际 drained 可再次等待成功。超时不 force terminate、不 resolve 成成功、不产生替代 Worker。effects close 失败没有 drained，因此不能提前退役。

正常 provider pause、handoff、shutdown／stop 继续各自原取消和 10 秒兜底职责。它们与 authority-loss 的结果分开记录；正常强制关闭也不能反向伪造旧失权 lifetime 的 drained 收据。close 与失权并发时，准入 store 只在自己的原 admission 和 projection 尾部结算后关闭，旧 lifetime 未 ACK 的事实仍交给根的既有恢复职责。新 selected lifetime 必须在旧 start／admission／worker 收据均闭合后建立。

## 落位与验证

机械状态与 Worker 协议保留在既有 platform/background 文件；宿主语义入口落在 system-operations 的 application／ports、composition 和 public participant。新增代码不往横向 services 放跨域 facade，不让 platform import 模块内部。真实 CLI／embedded 根选择和 Worker 的完整执行权／write-context 配对属于后续根接线，本片仅交付可被它们使用的完整冷生命周期，不签 H7 或 A-G。

新增回归使用原两个 provider store 和真实冷生产工厂：冷构造／查询／配置／关闭零执行；开机快照与 live 配置；单一 store／close receiver；有效 ready 前零 timer／enqueue；catalog／start 失败；start 期间 loss；payload 和 enqueue 等待期间 loss；停止新 claim 而原 job／receipt 完成；drained 前不就绪；超时保留、迟到 ACK、effects close 失败、裸 close／terminate 不代签；正常 stop 原兜底与重复调用。机械协议用原可注入 Worker／timer；至少一条真实 Worker 回归证明当前 job 与 effects close 实际 ACK 后才 drained。

原 native 案例、原 catalog、原 source oracle、全部断言与预算保持。若原源码 oracle 必须适应共用核心抽取，使用有限完整逆向保留其完整判据，不能更换旧哈希为新源码或降低断言。本机只做定向格式／lint 和纯语法／字节核对；正式测试、类型检查与构建以新确切 SHA 的 GitHub 全 CI 和默认完整 Windows 为准。

先完成独立功能设计门，修功能 findings，再实施与独立实现门。与正在交接的 Task／累计使用量候选分别冻结，不能纳入它们已签的 SOURCE 或联合清单。后续生产根必须再次证明同一 provider／generation／grant、十九实际 owner 与全部 admitted ACK，之后才进入 CS adapter 和首次 M0 部署。

## 2026-10-12：冷生命周期实施候选

本节记录设计门通过后的候选，不改变上文的历史设计状态。独立 DESIGN-R1 有效且稳定 PASS／零 findings，根已消费实际功能分析与全文身份。机械实现落在原 `maintenanceService.ts`、`maintenanceWorkerSupervisor.ts`，沿同一核心保留 native 默认入口，另提供完整 `createColdMaintenanceService` 和 `createColdMaintenanceWorkerSupervisor`。Task 与累计使用量联合 SOURCE 的 69 份文件继续冻结；本片生产、测试和本文不并入其发布范围。

服务在构造时读取配置、捕获开机 turn 集合、打开原 admission store 和状态投影，但冷态不建 supervisor／Worker 或执行 timer。start 固定原 lifetime 的 current 函数和 receiver，等待实际 supervisor start／ready 后才 resume admission、采样及原 schedule。完整九方法冷 supervisor 经一次捕获绑定原 receiver；store 的原 close 方法同样在构造时捕获。异步 payload 后与 receipt 后沿原准入控制器检查执行状态，前者保留 deferred slot，后者抑制失权后的新 wake；下一次获准启动按当前配置重新取 payload，原开机 turn 集合仍只读取一次。

quiesce 同步关闭同一 frame 的新工作并保留 admission 尾部，awaitDrained 等旧 start、admission 尾部及所有实际 owner 的 drained 收据。超时明确失败并保留旧收据；迟到的真实 ACK 才允许新 lifetime 创建 owner。正常 pause／stop 的兜底关闭继续独立处理，不能代签实际 loss drain。supervisor 的冷收据记录实际 Worker；裸 close 或强制 terminate 不删除未确认收据，catalog 错误或启动期间失权拒绝 ready，冷态没有自动 replacement。

有限源码复核还修正了一条明确等待时序：B 已选择并等待旧 A 的实际收据时，重新 start(A) 会使两个 start 尾部互相等待。服务现在记录已选择的 lifetime，拒绝重启已被后继取代的旧 lifetime；一次新选择先同步 fence 全部既有 frame，再逐个等待实际尾部。新增案例中两份 current 回调同时仍为 true，以实际服务状态转换验证该行为。正常 pause timer 同样固定请求关闭的原 Worker，并在发送 drain 前安装冷分支 timer；已清除但排队的 timer 不能关闭后来已确认的 Worker。

三个新测试文件包含 8 个 service 案例、9 个 supervisor 案例和 1 个双 provider 真实 Worker 案例。前两组通过完整 store／supervisor 接缝观察原 receiver、等待和实际收据；后一组采用实际 maintenance Worker 与 SQLite／PostgreSQL 开库接口，分别控制 effect 初始化和 dispose，验证构造零 claim、原 job／receipt 完成、停止新 claim，并在 effects 与数据库实际关闭后才收到 drained。Ubuntu 预期 19 次、macOS 18 次、Windows 18 次，共 55 次；这是源码声明人口，尚未登记完整 Windows 或实际执行，不能写为已通过。

本片目前只做定向格式／lint及 `ts.createSourceFile` 语法检查，不创建 TypeScript Program、不执行产品或测试。独立 SOURCE、原清单配套、精确发布及新 SHA 主 CI／默认完整 Windows 仍待验。先完成已冻结 Task／累计使用量联合发布和其 CI，不等待本片完成；随后再登记本片测试与配套。既有本机 backend 的恢复另有独立记录，不能混称测试验收。

该候选仅提供维护 owner 的冷机械基础。Worker 在原 ready 前安装 poll／heartbeat、ready 后启动原 `processQueue` 的完整执行权配对，system-operations write context、十九 owner 和三个生产根的 selected 接线仍属于后续 H7。完整 H7／A-T7／A-G、各层独立 CS adapters、先 M0 实际部署再 M1～M4 和 RFC 继续开放，AW 尚未部署 CS。

## 2026-10-12：完整总绿后恢复本片 SOURCE

确切 `540168eceeabe9a70ba6030dbbd5cb8a79db78c2` 的主 CI `38188857513` 正式 success、72／72；默认完整 Windows `38188857518` 正式 success、26 步成功。根复用原缓存完整核对 46 份日志 EOF（18,596,988 B），原 Task 119 次、生命周期 211 次、Worker 八案例展开 32 次及原登记相关人口实际全部 pass；两条流水线共八个包级 typecheck 实际 code 0。失败历史及各 SOURCE／MATCHING 结论保持，累计使用量和 Phase2 性能仍归「设计运行观测统计全景」；本次不为性能或 CS 部署作验收。

用户要求的总绿前置已满足，恢复本片有限实施检视。原六份 maintenance 候选完整保持；新增完整 Windows 的两个生产输入触发和三个新测试的 push／pull_request 路径及 command 登记，原 command 及全部已登记案例逐字保持。55 次仍是预期人口，必须待本片发布后的三平台真实执行验证。当前新报告 Worker host 修复只在原报告创建处同步传递环境；它不改变本片维护 Worker 的初始化、ready、claim 和实际 drained ACK 合同。

后续独立 SOURCE、必要原 scoped census／MATCHING、精确发布及本片新确切 SHA 的完整主 CI＋默认完整 Windows分别验收；本机不运行 AW test／typecheck／build／服务／E2E。完整十九 owner、三个真实启动根、A-T7／A-G、各层 CS adapter 和先 M0 实际部署再 M1～M4仍未完成，AW 尚未部署 CS，RFC 继续。

## 2026-10-12：SOURCE-R1 两项功能问题与修正候选

R1 独立实施门正式有效、稳定 FAIL，根已完整消费十二项功能分析、七项 owned 结论、40 份输入的三轮实际 EOF 身份和 78 处行引用。两项 P2 分别是已排空历史 frame 仍长期留在强数组，以及 restart 等旧 Worker 收据超时后解除 paused、下次 start 误用旧 ready 成功。原 R1 回执与全部控制、旧案例和预算保留；设计门通过或原 55 次声明不能抵消这两个实现问题。

修正将强等待人口改为实际未闭合 frame 的 Set。只有旧 start、admission 尾部和实际 supervisor drained ACK 闭合后，才释放对应 owner／Worker closure 和强 frame 引用；WeakMap 保留 superseded 身份判据。重复同一最近 lifetime 时也释放已 ACK 的旧 owner，不再累积历史 wrappers；超时或缺 ACK 不释放收据。

supervisor 在等旧 actual drain 的全过程保持旧 Worker 的 paused fence；实际 ACK 到达后才解除并建立新 Worker，仍等其原 ready／catalog。独立 start attempt 记录等 ACK 时的 quiesce／正常 pause／stop，拒绝或失权时继续 fence，避免下次 start 或 wake 误用旧 ready。正常 native 入口、重启、计时器和强制关闭政策保持。

先补三条回归声明，再改生产：连续十次新 lifetime 和两次最近 lifetime 重启后，已实际 drained 的旧 owner 不再被 fence／等待／stop；restart 等待连续两次超时后，旧 wake、强制关闭、新 Worker 和 ready 成功均保持关闭，迟到 ACK 后的新 catalog 才就绪；等旧 ACK 期间的正常 pause 也关闭延迟创建，随后显式 resume 可启动新 Worker。R1 三份测试的原全文前缀保持，真实双 provider Worker／effects／数据库关闭案例不改。

当前 R2 为 service 九例、supervisor 十一例、真实 Worker 每 provider 一例；预期 Ubuntu 22／macOS 21／Windows 21，共 64 次。完整 Windows 仍执行同三份测试文件，原 13 项路径／command 增量和全文件逆向不变。这些均尚未执行，须经 R2 独立 SOURCE、唯一必要配套与发布后新 SHA 的完整主 CI＋默认完整 Windows验证。after-commit 泵的后续设计另在独立文件中，不并入本片 SOURCE 七份或当前 census 的生产人口。

## 2026-10-12：SOURCE-R2 暂停与同步工厂边界的修正候选

R2 正式有效、稳定 FAIL，根已完整消费 43 份输入的三轮实际 EOF 身份、十二项功能分析、七项 owned 结论、83 处结构化引用及 85 处文档行引用。R1 的两个原问题针对性修正成立，但新增两项 P2：cold service 初始 paused 状态使 pending start 期间的普通 pause 直接成功返回、随后又激活；同步 createSupervisor／workerFactory 回调记录 quiesce 时，新 owner／receipt 尚未登记，返回后仍先启动或等待 ready，可能留下无 drain 的永久等待。R1／R2 的原 FAIL、冻结稿和消费回执全部保留。

修正为 cold 普通 pause 单独记录意图及请求序号，立即关闭主准入和 timers，只对当前 selected frame 的原 owner 调用普通 pause，不把前代的 loss 收据当成正常强制关闭对象。等待旧 ACK、工厂返回和 ready 后均核对该意图；显式 resume 前保持关闭。普通 pause 不退休仍 current 的 lifetime。未曾 start 的 pause／resume 仍不创建执行器，首次执行须明确 start(current)。已经创建但从未 start 的 owner，只有显式 resume 后才调用原 start 并等真实 ready；已经 start 的 owner 则调用捕获的原 resume，保留其 receiver。

同 frame 的 pending 普通 resume 另记录实际尾部，公开 start 复用它；内部尚无 owner 的恢复走内部 start，避免自等。loss drain／正常 stop 同时等待这个 resume 与原 start 尾部。强人口清理也要求两者已闭合。新 pause 的序号能够阻止较早 resume 在异步等待后重新开准入。supervisor 的 cold resume 在等待普通 pause 的实际 ACK 前先建立原 start attempt，使等待期间的 quiesce 能阻止延迟创建；native 的原 resume、10 秒正常关闭兜底及实际 drained 判据保持。

两个同步工厂返回后都先登记完整对象，再处理已记录的 fence。service 在失权后不调用返回 owner 的 start；supervisor 对已经创建的同 Worker 发原 init／drain 并拒绝此次 readiness，保留真实 drained 收据，不以 timeout、裸 close 或 terminate 代签。既有原 store、payload、catalog、错误和九方法捕获合同不变。

新增七条 service 和三条 supervisor 回归，覆盖 pending ready 的普通 pause／原 owner resume、等待前代 ACK 时 pause、未启动 pause／resume、两个工厂的同步 quiesce／pause、pending resume 实际尾部与后继等待、新 pause 覆盖较早 resume，以及 supervisor resume 等普通 pause ACK 时的失权。原 R2 全部具名测试调用、断言和预算完整保持；仅给原 fixture 添加同步工厂重入和实际 resume 尾部的控制接口，真实双 provider Worker 文件逐字不变。当前为 service 十六例、supervisor 十四例、真实 Worker 每 provider 一例；预计 Ubuntu 32／macOS 31／Windows 31，共 94 次，实际运行仍为零。完整 Windows 文件及原 13 处注册全文保持。

本候选已做定向格式、lint 和纯 `ts.createSourceFile` 语法／原具名调用保持检查；没有建立 TypeScript Program 或执行本机产品／测试。R3 独立 SOURCE、必要原配套及新提交完整主 CI＋默认完整 Windows仍须验收。after-commit 的独立设计门已通过并完成根消费，只签其设计，未纳入本片生产人口；累计使用量与持久化缓存仍由另一会话负责。十九 owner、三个真实根、完整 H7／A-T7／A-G、独立 CS adapters 和 M0～M4 均继续开放，不签 CS 部署或 RFC 完成。

## SOURCE-R3 正式 FAIL 与第四轮有限修正

SOURCE-R3 已独立关闭为有效、稳定 FAIL：一项 `MAINTENANCE-COLD-P2-005`。root 完整消费 48 项材料、正式回执和可读分析，并核对七份 live 候选、三轮真实身份及全部引用；原 R1／R2 失败与已修正的四个触发均保留。普通 pause 先于 loss 时，全 service 的暂停意图挡住 B 的选择；显式 resume 仍取失权 A，并在清意图前抛错，因此后继 current B 永久不能启动。

本轮只把清普通暂停意图移到原 current 调用及请求序号复核之后、旧 owner 激活判据之前。显式 resume 对失权 A 仍明确失败，不调用其 start／resume；下一次 current B 的 start 才承担原真实尾部与 ACK 等待。新 pause 的序号继续优先，不把旧 ACK、意图清除或失权 resume 失败签为 B ready。新增一个具名回归分别覆盖旧 ACK 已完成与尚持住两种顺序，验证零旧 resume、新 owner 创建前的 ACK、实际新 ready 和受理关闭。

原 service 16／supervisor 14／真实 Worker 1 的完整调用及所有预算保持。本轮 service 17、supervisor 14、EachProvider 1，对应 Ubuntu 33、macOS 32、Windows 32，共 97 次预期执行；实际执行仍为零。此为 SOURCE-R4 候选，仍须独立实施门、匹配与新 SHA 全绿后发布验收；完整 H7、CS adapters／部署、M0～M4 与 RFC 完成均不签收。

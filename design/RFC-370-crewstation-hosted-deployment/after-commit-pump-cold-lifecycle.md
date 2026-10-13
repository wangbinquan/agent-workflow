# RFC-370：after-commit 事件泵的冷受理与真实尾部

本片沿已批准的 RFC-370 和 [H7 真实启动根设计](host-execution-root-assembly.md)，补齐 `after-commit-event-pump` owner 的机械基础。当前 maintenance 候选仍在独立实施检视；本文件不改其七份冻结输入，也不接管另一会话的累计用量、缓存与报告性能。有限设计门已通过并由 root 完整消费，当前实施候选尚待独立 SOURCE；不签完整 H7、十九 owner、三个启动根、A-T7／A-G、CS 部署或 RFC 完成。

## 原始调用与缺口

`platform/events/committed/afterCommitEventPump.ts` 的 `publishNow` 先过滤 dispatchable refs，再将读原持久事件、排序／解码、逐个 awaited projector 和 finally nudge 串接到 `projectionTail`。原尾部会吞掉前次失败以允许下次继续；本次调用仍向调用者传播原错误。去重由原 projection ledger 管理，ephemeral projector 的失败继续记录并处理后续 projector。

`platform/events/committed/runtime.ts` 的 `publishCommittedEventsAfterCommit` 同步捕获当前泵并调用它，没有捕获后、调用前的异步间隙。无泵时返回 false，已提交的 durable delivery 留给原恢复路径；投影失败保留原日志和返回语义。空 refs 的返回语义同样保持。

`cli/start.ts` 的 PostgreSQL 与 SQLite daemon 各有一处 `afterCommitPumpFactory`。start 注册原 pump；stop 撤销注册；drain 目前只检查 stopped，没有消费 `projectionTail`。已进入 `getStored`、projector 或排在原序列后的已受理 publish 可以在这个空 drain 返回后继续工作。这个结果不能成为 provider／宿主交接的实际 ACK。原源码判据仍要求两个 daemon 的注册均处于 session handle 的 start 内。

## 完整机械合同

保留原 `AfterCommitEventPump` 两方法合同，避免要求原 fixtures 和临时注入对象实现宿主生命周期。原生产工厂另外交出可等待真实尾部的完整 tracked pump 类型；`publishNow`、`nudge` 的原 native 行为保持。新增独立冷工厂复用相同投影核心，提供完整 `publishNow`、`nudge`、`start(lifetime)`、`quiesce(lifetime)`、`awaitDrained(lifetime, budgetMs)`。不使用 partial 默认，不在 platform 中导入 system-operations 内部，不加入 CS DTO 或 SDK。

冷 lifetime 只有原机械 current 函数；由真实根在后续接线中绑定同一宿主 grant／provider／generation。冷工厂一次捕获 current 的原函数和 receiver；投影持久端口、codecs、projector handle、ledger 和 nudge 的实际函数与 receiver 同样固定。冷路径的异步等待不改用调用方后来替换的方法。native 仍沿原方法查找、callback 时点和错误传播，不因新增 tracked 尾部端口改变原可注入对象的行为。

冷构造与查询不注册泵，不读事件，不建 timer，不调用 projector 或 dispatcher。start 选择 lifetime，等待所有此前实际受理的尾部后才允许新 publish；同一 pending start 共享等待。B 已选择时不能重启旧 A，也不能形成 A 与 B 相互等待。已经实际闭合的旧 owner 从强等待人口释放；未 ACK 或超时的尾部保留，弱身份记录只承担旧 lifetime 已被后继取代的判别。

一次 publish 的受理点在同步检查当前 lifetime 后、排入原串行尾部之前。受理后由同一 lifetime 承担这个完整事件批次：原 getStored、顺序和去重、所有原 projector 尝试、原错误传播与尾部结算。loss 不中断或改写已受理批次，不把它记为主动取消，也不另发替代批次。受理前失权的调用明确失败，原 committed receipt 和 durable delivery 保留。nudge 在冷态或失权后不打开新 dispatcher 工作；已提交 durable delivery 在后继 owner 的原周期对账／受控启动中继续恢复。

quiesce 同步关闭这个 lifetime 的新 publish／nudge 受理，固定当时已受理人口，不调用业务取消。awaitDrained 必须等待这些实际 promise 全部结算，包括 getStored 与 projector 内部 await；只到达 stop 标记、只收到 publish 请求、只更新去重账本，均不是实际排空。投影尝试失败的 promise 已真实结束可计为尾部结算，但原失败仍传播给 publish 调用者并保留日志；drain 不将它改签为投影成功。budget 超时明确拒绝调用者，不删除未闭合尾部、不建立新 lifetime；迟到的真实结算允许再次等待。

注册仍归 owning root。补一个按原 pump 对象身份撤销的 registration release 操作：旧 handle 的迟到 stop 只能释放它自己的注册，不能清掉后继已注册的泵。原 `registerAfterCommitEventPump(pump|null): void` 全局 API 与无泵 durable 恢复语义保留。冷机械工厂不自行设置全局 binding；真实根先受控 start，再注册同一 pump，stop 先同步撤销同一 registration、quiesce 新受理，最后等待其真实 tail。后续完整 H7 再验证三个根和全部 owner 的写上下文及跨进程前代事实；本片不能用内存 tail 代签它们。

## 落位与实施顺序

投影尾部和机械状态落在现有 `platform/events/committed/afterCommitEventPump.ts`，身份撤销落在原 `runtime.ts`；宿主语义和真实 handle 装配按 RFC-294 落在 system-operations 的 application／composition，跨模块只通过 exact public 合同。先完成本片设计门与实施门，发布中性能力和真实回归，再在 H7 接线批次消费完整生命周期。原两个 CLI native 注册点、旧 start／stop 错误、所有原判据和预算保持；不能因“有了 drain 方法”提前宣称真实根已接入。

测试至少覆盖：冷构造／关闭零效果；原 native 异步顺序与 overlapping publishes；start 去重、待旧尾部时失权、A→B→旧 A 拒绝；读事件和 projector 等待期间 loss 后原批次完整结算；loss 后零新受理；原读失败与 projector 失败／finally nudge、durable 恢复；超时保留和迟到结算；原方法与 receiver 捕获；连续换代不遍历已排空历史；旧 registration release 不清除新 pump。至少使用两种原真实 provider 的 committed-event persistence 和实际 awaited projector 验证 tail，不能只依靠一份空 drain 夹具。

原 `rfc349-async-committed-event-projection`、`rfc341-collaboration-committed-events`、`rfc341-collaboration-source-locks`、`rfc349-sqlite-daemon-pausable-writers` 与真实 Task post-commit 回归保留。新增测试登记完整 Windows；本机仅定向格式／lint与纯源码／字节核对，正式产品测试、类型和构建以发布后 exact-SHA 的完整主 CI＋默认完整 Windows 为准。本片必要清单在 SOURCE 通过后只执行一次原 scoped census，排除另一会话未提交的报告性能改动；独立配套门及短串行发布另验。

## 有限设计门与实施候选

DESIGN-R1 正式有效、稳定 PASS／零 findings。root 已完整消费十九项冻结材料、可读分析与正式回执，并核对三轮实际身份和全文；它仅批准本文的有限设计，不签生产代码、CI 或真实根接线。上文 register API 的文字现按原实际 `pump|null` 参数更正，保留原实现与调用合同。

原 native 工厂的 tracked 类型只增加 `awaitDrained()`，返回当时实际串行尾部；原过滤／排序、动态依赖方法查找、attempt ledger、逐个 awaited projector、错误及 finally nudge 全部保持。旧两方法 interface 保留，原临时注入对象仍合法。冷工厂完整绑定原七方法持久端口、codec、projector、ledger、hook 和 nudge 的函数与 receiver，不改变 native 的替换方法行为。构造只复制配置与函数，不启动执行、不注册、不读数据库、不设 timer。

冷 frame 用 WeakMap 保存原 lifetime 身份；强等待集合只保留未闭合的受理尾部或 start attempt，实际完成后退役，最近选中身份另保留一个。start 只等原受理 tails，不等前代 start promise，连续 A→B→C 不形成反向等待。受理前后检查捕获的原 current 和同步 quiesce 状态；原 current 回调中重入关闭也不能重新激活。drain／start 的十秒预算只在实际非空等待时创建 timer，超时不删除原尾部、不签 ACK；已受理批次不因 loss 中止，其全部原 projector 尝试继续结算。明确 quiesce 后等待原 start 和批次实际完成，失败尝试的结算仍不等于投影成功。

新增十六个普通用例和一个 `EachProvider` 用例。普通用例覆盖零效果构造、原 native overlapping／失败后继续、pending readiness 去重、完整批次与 queued publish、后继／三代等待、超时与迟到结算、原依赖及错误 hook 捕获、attempt 去重与失败传播、身份撤销、连续已完成身份、current 重入，以及原同步 ref 过滤中的 loss。受理尾部在调用原过滤前登记，防止同一同步调用中关闭 A／选择 B 时遗漏已接纳批次。真实用例沿原 SQLite／PostgreSQL append、cutover、持久端口和 dispatcher；projector 实际 awaited 原数据库读取并持住结算，验证 loss 后完整两事件批次、零新受理、晚 ACK、原 ledger 去重，以及另一未即时 publish 的 receipt 由原 durable claim／settlement 恢复。durable 业务效果端口采用原有限 fixture，本例不签完整事件中心或 CS webhook。

预计新增 Ubuntu 十八次、macOS 十七次、Windows 十七次，共五十二次；实际产品／测试／类型执行为零。当前 SOURCE 的五份 owned 为两个原生产文件、两个新增测试和本文。maintenance SOURCE-R4 冻结的实际 Windows 文件保持，pump 的完整 Windows 注册另保存为可审的配套候选；待其冻结解除，按完整共同文件匹配、保留双方输出后才落位／发布，不把计划或注册签为运行。原 CLI 两处 empty drain 仍须在 H7 真实根接线中消费 tracked tail；此中性能力不能代签它们已修复。

## SOURCE-R1 实际失败与 R2 有限修正

正式 SOURCE-R1 为有效、稳定 FAIL，唯一功能 finding `ACP-SOURCE-P2-001`：cold `waitActual` 把调用者实际等待的拒绝 timer 设为 unref，只有未完成读库／projector Promise 时不能保证十秒或显式预算的拒绝发生。根已完整消费 35 项实际材料、正式回执和全部 24 项分析；原 FAIL、完整逆向、旧 16 个普通案例和 provider 案例保持。

R2 仅删除这一个 `timer.unref` 调用，保持 ref 直到原实际结算或预算拒绝，沿用两条原 `clearTimeout` 路径，不修改预算、尾部人口、原 native 核心或注册行为。新增一条独立 Bun 子进程回归：调用本片实际 cold pump，原持久读取只交出未完成 Promise，不载入测试 runner／数据库 helper；失权后以原 17ms 预算等待 actual drain，要求子进程确实输出预算拒绝并正常退出。父进程只以 3s 上限阻止故障子进程残留，不增大产品预算。此回归尚未实际运行，不能把它代签为功能通过。

R2 保持原源码／方法／receiver／错误和 16 个旧 case／断言／预算，新增后共有 17 个普通案例＋1 个 EachProvider 定义，预期 Ubuntu 19／macOS 18／Windows 18，共 55 次，实际为零。维护源码门与其配套候选保持；R2 独立 SOURCE、未来 Windows 正式落位、必要唯一清单、精确发布与新确切 SHA 的完整 CI 分别待验，H7 真实根／十九 owner／三个根／A-G／CS／RFC 不提前关闭。

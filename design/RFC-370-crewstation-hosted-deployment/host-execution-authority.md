# RFC-370 H7 执行权、执行就绪与恢复接线 D1

状态：设计候选，尚未实现；待独立功能设计门。沿用已批准的完整接入和阶段 A／A-G → 独立 CS adapters → M0 首次部署 → M1～M4 逐项接管顺序。本文件不关闭 H7、A-G 或 RFC。

## 实际起点

`DaemonStartupLease` 已把启动排他和 release ACK 抽到 System Operations。其 recovery receipt 只包含 daemonGeneration、acquiredAt 和 receiptDigest；PID／文件路径留在 native adapter。它仍不是完整的运行中执行权生命周期。

`DaemonProviderRuntimeSession.execution.pause/resume` 能单独控制后台 handles，资源 HTTP／WS 继续可用。两个 CLI provider 会话各有五个 runtime factories、十四个 background writer factories和七个 close participants。provider pause／switch 同时排空 HTTP／WS；execution pause 不执行 provider close。

但 SQLite 的任务四步恢复、webhook terminal reconciliation及其他 boot writers，PG application 中较早的 webhook／delivery恢复和较晚的任务四步恢复，都早于 runtime session 的执行控制。PG 的 detached skill backfill也不在该 handle集合。仅在 session 建成后 pause，不能得到零执行的待机实例。

另外，Task claim gate只挡 claim／attach；launch可先物化工作区、写 task与intent。`DefaultTaskDriveCoordinator.submit`、legacy `services/task.ts` 的 start／resume／retry、root launch kernel与各 owner 的HTTP即时执行，都需要真正的执行就绪入口。新Task也不能依赖后续claim失败来清理一半的启动。

现 `MrTerminalControlWorker.stop` 会调用 supervisor.abortAll，`TaskExecutionModule.pause` 会 abort exact runtimes；这些完整旧语义用于正常provider pause和shutdown，不能直接当作失去远程租约后的平台批量取消。

## 所有权与完整选择

System Operations application拥有中立生命周期和对外就绪查询；native和以后CS adapter各拥有自己的claim／renew／activate／release机制。bootstrap只装配完整选择。Task Execution继续独占Task owner、intent、effect journal、durable恢复及Task业务事务。Integration、Intent、Memory、Development Automation、Digital Employee、Knowledge Evolution等owner各保留自己的效果和worker政策，不放进一个CS业务总适配器。

SO application/ports新增完整 `HostExecutionAuthorityFactory`，创建一个绑定provider／generation的driver。driver闭合地提供 `claim`、`renew`、`activate`、`quiesce`、`release`、`subscribe` 六项；claim和activate返回明确的 `standby` 或 `granted`，grant为同一driver解释的opaque reference。subscribe只报告实际grant变更／丢失并返回可await关闭的handle。CS epoch／leaseId／instanceId、网络请求、计时机制与平台DTO只在CS adapter内部；native PID锁、原recovery receipt和本机计时机制只在native adapter内部。

SO公开participants提供 `HostExecutionAvailabilityQueries` 和 `HostExecutionAdmission`：查询阶段、generation、已就绪效果组及未就绪原因；named `acquire(group)` 返回同一generation的admission lease或明确的暂不可执行结果。lease持有opaque grant引用、可观测完成ACK与原工作所需的中止通知。资源读写不消耗执行admission。显式选择缺少任何必需方法、恢复配对或同generation接线时，在效果前报告装配不完整；不补native能力。

driver的具体中立合同如下；factory创建和同步native操作不引入额外await，异步实现的每个ACK必须等待。`reference`由driver解释，common不读取其字段。

```ts
type AuthorityReference = object
type MaybeAsync<T> = T | Promise<T>
type AuthorityObservation =
  | { readonly kind: 'standby'; readonly reason: string }
  | { readonly kind: 'granted'; readonly reference: AuthorityReference }
  | { readonly kind: 'lost'; readonly reason: string }

interface HostExecutionAuthorityDriver {
  claim(): MaybeAsync<AuthorityObservation>
  renew(reference: AuthorityReference): MaybeAsync<AuthorityObservation>
  activate(input: {
    readonly reference: AuthorityReference
    readonly preparationDigest: string
    readonly acceptedTaskContractVersions: readonly string[]
  }): MaybeAsync<AuthorityObservation>
  quiesce(input: {
    readonly reference: AuthorityReference
    readonly reason: 'authority-loss' | 'handoff' | 'shutdown'
  }): MaybeAsync<void>
  release(reference: AuthorityReference): MaybeAsync<void>
  subscribe(input: {
    readonly onObservation: (observation: AuthorityObservation) => void
    readonly onFailure: (error: unknown) => void
  }): MaybeAsync<{ close(): MaybeAsync<void> }>
}
```

driver负责真实有效期及renew时机；错误或有效期到达必须报告lost，不能只记录日志继续持有active。subscribe在claim前注册，loss通知同步关闭新admission；后续drain进串行生命周期队列。迟到的claim／activate结果不能重新打开已丢失或closed的generation。authority-loss的driver.quiesce只停止本实例控制和观察，不使用失效reference执行远程取消／交接写。正常handoff通过仍有效的选定driver完成实际平台ACK。

native driver借用bootstrap已获得的startup lease，不新增PID协议；其runtime grant的release不提前释放借用的PID锁。PID锁仍由原DaemonHostApplication在provider／listener关闭后释放，failed boot仍由原runDaemonStartupWithLease处理。HTTP embedded默认选择保留原进程／Task owner语义，不凭空制造一个已经获得全局PID锁的事实。

实际bootstrap selection由各owner的独立binding组成：SO authority、Task恢复／写上下文、各owner效果就绪及runtime quiesce面。绑定共享同一authority实例和grant；不通过字符串namespace相同猜配对，不把配置快照当执行权。默认native choice保持全部原能力；CS choice只开放已经完整接管的效果组，未适配组保持未就绪。

## 生命周期和两种恢复语义

共同状态为 `standby → preparing → active → draining`，结束为 `closed`。resource readiness与execution readiness独立。preview或M0资源模式能够ready并编辑资源，execution仍为standby，不凭slot名claim。控制器先关闭新增执行admission，再await其他状态转换；await claim／renew／activate不能提前打开执行。

获得有效grant后，Task owner先完成同grant下的恢复准备，再由authority driver确认activate；之后才开Task admission、各就绪效果组及其handles。失败保持不可执行，不能用ACK假装恢复已完成。一次native startup仍执行原prepare／reap／repair／finalize序列、相同计数／错误和原启动顺序；完整旧boot动作在native binding中保留，原case／assert／budget保持。

selected恢复合同显式区分 `local-startup` 与 `durable-intent`。后者由Task owner消费现有durable intent／effect receipt与实际运行事实，不能调用local startup的全量interrupted／orphan replay。common只把同一opaque恢复引用交给所选完整family，不构造PID证明，也不让CS driver直接改Task状态。其他boot writers按自己的named启动步骤交给同一authority lifecycle；没有实现的恢复步骤返回deferred并阻塞其效果组，不能记录为完成。

失去grant时同步关新增admission与下一次worker claim／dispatch，随后进入draining。专用authority-loss quiesce停定时器、停止新的外部回写／派发并await已受理工作的可控drain，保留intent／receipt；不调用正常shutdown的mass-interrupted、graceful bulk cancel或native orphan algorithm。receipt intake与资源HTTP仍有自己的耐久接收面。正常provider切换／shutdown保持现有旧stop语义和完整close顺序；迁移屏障另需排空HTTP写请求，不能用execution pause代替它。

driver报告重新获得grant时，完成新的恢复与activate后再恢复handles；不得复活旧grant或仅翻转enabled布尔值。失败的某个start／stop／drain／release保留准确进度，重试同一generation中尚未ACK的操作。driver subscription自身由同一生命周期关闭；其关闭ACK不能被provider close越过。

## 业务事务和执行效果

Task原owner／epoch／revision以及受控写事务继续作为业务并发事实，不改原状态迁移表。authority层只增加本安装当前holder／revision／有效期的持久执行上下文；其数据归SO，Task persistence在原业务事务中消费选定上下文，保留原Task所有条件和返回形状。native选择复用原local单实例／Task owner语义；hosted选择采用真实当前安装上下文。不能另开一次检查事务再声称它与原业务提交原子。

SO lifecycle先冻结受控写的新admission，等待原已受理事务drain及水位ACK，才发布handoff preparation；新owner在取得平台activate结果后提升本地holder／revision、恢复cursor和未决intent。common不宣称CS远程fence与AW数据库可以原子提交。Task owner保留派发intent与稳定requestKey，adapter按同grant提交，重启按实际durable receipt恢复。

authority-loss中已经发出的远程请求不能靠失效身份取消。Task Run与其他效果family必须接收区分正常cancel／provider pause／authority loss的停止事实；各owner adapter对authority loss只停止新请求与观察并保留实际收据，对有效正常取消仍保持原取消语义。恢复收据ACK、请求ACK、真实terminal完成分别记录，不互相代替。

## 必须接线的入口

| 入口 | 实际文件／owner | 接线要求 |
| --- | --- | --- |
| CLI启动与provider重建 | `cli/start.ts` | StartOptions、共同compose input、SQLite／PG session都选同一完整authority binding；在任何执行boot writer前确定可执行／deferred模式 |
| PG与HTTP组合 | `cli/postgresqlDaemonApplication.ts`、`server.ts` | 同一binding传到所有业务子装配；HTTP fixture不新增boot恢复，standalone默认能力保持 |
| Task启动 | `services/task.ts`、`taskRouteLaunchOperations.ts`、`hostTaskLaunch.ts` | 在物化／task与intent提交前受理named admission，覆盖workflow／agent／workgroup／DE／schedule／event／webhook／child arm；保留旧错误优先级和cleanup责任 |
| Task继续／驱动 | `taskDriveCoordinator.ts`、Task route与lifecycle commands | resume／retry／sync及每次新node效果用同一generation；background ACK只表示受理；旧完整driver与failure／finally规则保留 |
| Task业务持久化 | Task ownership／intent／effect persistence | 在原named事务消费同一执行上下文；旧Task epoch／revision事实不删减，旧启动恢复与durable恢复配对明确 |
| provider handles | `daemonProviderRuntimeSession.ts`、`providerBackground.ts`及各owner runtime binding | 完整十九handle集合；新增authority-loss专用quiesce，不借正常provider pause进行平台取消；零ready组不start |
| 提前恢复与detached writer | 两CLI根、Integration worker、skill boot、fusion／maintenance恢复 | named boot步骤和可drain handle纳入同generation；无法适配的步骤和worker保持deferred；原native顺序全文保留 |
| 即时执行与验证 | Intent回合、runtime/MCP诊断、custom observer、Verification、Purpose、DE actions | 所选实际入口受理同一group admission；资源编辑／预览与纯读取继续可用，无本机spawn fallback |
| Event Center与webhook | Integration、Event Center composition | 耐久受理与实际dispatch独立；待机不派发，迁移期间写受理可重试503；既有逐目标事实／去重不改 |
| UI／API状态 | SO查询与共享API／前端 | 展示真实resource ready／execution standby或active、未就绪组及原因；M0没有伪成功运行／probe按钮 |

这张表只定义完整H7交付边界；实施前仍须把每条实际callsite归到具体binding，并在A-T7证明没有遗漏。有限authority coordinator PASS不够关闭整张表。

## 实施与验收

依次实现完整中立ports／native pairing／lifecycle；原bootstrap boot与十九handles接线；Task启动、继续、effects及原业务事务上下文；其他owner即时执行与状态查询。每片使用已通过的设计，源码独立功能复核后发布，并等待精确SHA hosted CI；本机只做owned格式／lint、纯AST／byte／JSON及不同最终生产候选的一次原scoped生成，不运行AW本机tests／typecheck／build／service。

新功能回归必须实际证明：standby资源编辑和dispose/rebuild耐久成功且所有执行／spawn／boot mutation为零；claim／renew／activate ACK顺序；native原boot全文与顺序；两个provider和HTTP所有子根传递同一binding；提前webhook与detached writer没有逃逸；一次loss先关新claim／dispatch再drain、无bulk cancel／interrupted；租约丢失和新grant交接后只恢复未决intent；某个start／stop／drain失败可重试而不重做已ACK效果；所有十九handles完整；Task原事务与requestKey／receipt关系；迁移排空与resource readiness的区别。旧native全部case／assert／budget继续，不以仅接口编译或假standby响应替代实际零执行证据。

H7完整实现和A-T7全入口闭合后才进行独立A-G及双OS／双数据库精确SHA CI。CS authority driver、实际平台lease／handoff／recovery及M0～M4部署验收仍属于后续独立adapter阶段。

## D2 对迟到租约响应的补齐

D1 独立功能设计门有效、稳定，发现唯一 P2 `H7-D1-F01`。本节补齐该异步合同；D1 原正文完整保留，尚未签源码、完整 H7、A-G、CI 或部署。

SO lifecycle 在调用每次 claim／renew／activate 前登记其 exact operation、generation 和待结算 ACK；同步 native 返回继续同步处理，异步返回的同一 Promise 必须始终被跟踪。loss／close 同步关闭新增 admission，并把未返回操作标记为过时；它们不再产生新的 activate、续租或业务 dispatch。迟到返回的 standby／lost 按原操作结算；迟到 granted 不能丢弃，必须把其 exact reference 加入同一 generation 的可追踪退场清单。重复观察到同一 reference 只收尾一次，不把旧响应当作新 generation。

driver 负责停止过时活动的自动续租、观察和未发出的控制请求；实际在途请求须通过 adapter 自己的有界结束或撤销观察机制返回终态 ACK。common 不读取 reference 的平台字段，不用失效 reference 发起远程取消／交接写。晚到 grant 的清单逐项等待 `quiesce({reason:'authority-loss'|'shutdown',reference})` 和 `release(reference)`，或 driver 内部等价的完整收尾 ACK；release 只处理该 driver 所有的有效租约释放或已失效租约的本地退场，不能冒充远程取消成功。native driver 对借用 PID 的 release 仍只结算本次 runtime grant，原 host 的 PID release 顺序保持。

close 不以关闭 admission 为完成。先封闭新增控制活动，启动 subscription.close 以停止新通知／自动续租并推动在途操作结算；继续跟踪和消费所有已登记结果，将晚到 reference 纳入上述收尾，再等待 subscription 和所有 owned 操作／退场清单的真实 ACK，最后返回 provider close。subscription.close 的完整合同包括停止它启动的观察、续租和控制活动，不能遗留无人追踪的 Promise；adapter 必须允许 lifecycle 在它的关闭过程中对晚到 reference 完成 quiesce／release。loss 的 drain 同样等待该 generation 的过时操作与退场 ACK，再接纳新 generation 的实际 grant；晚到旧结果不得加入新 generation 的就绪组。

收尾按 operation／reference 记录准确进度：某个 quiesce、release 或 subscription.close 失败时保留原错误与尚未 ACK 项；重试只继续未 ACK 项，不重复已经成功的释放，也不越过 pending 操作宣告 closed。正常有效 handoff 与 shutdown 继续使用其对应原因和原责任；因 loss 已失效的调用不能恢复为正常 handoff。

新增验收场景用可控 deferred claim、renew、activate 分别在 loss 和 close 后返回 granted，证明 admission 始终关闭、同一 exact reference 只退场一次、无残留续租／观察／控制任务，provider close 确实等待全部 ACK；在 quiesce／release／subscription.close 各处失败后仅重试未 ACK 项，后继 grant 等旧清单完成后再准备与 activate。native 借用 PID 的原 host release 次序也必须实际验证。

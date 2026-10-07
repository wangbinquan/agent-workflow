# RFC-370 H7 Task 后台执行权切面 D1

状态：设计候选，生产代码尚未修改；需独立有限功能设计复核。沿用已批准的阶段 A → A-G → 独立 CS adapters → M0 先部署 → M1～M4 顺序。本切面不关闭 H7、Task 原事务/admission、A-T7、A-G 或 CS 部署。

## 实际缺口

`packages/backend/src/modules/task-execution/composition/providerBackground.ts:301-427` 持有五类原循环、启动配置读取和 detached auto-resume。当前循环在读取配置之后检查 `authorityQuiesced`，启动也只检查该标记；原 context 已失效而 SO quiesce 尚未执行时，标记仍可为 false。原 `resume()` 捕获 quiesce version，不能代替实际 generation 的派发检查。

`packages/backend/src/modules/task-execution/composition.ts:100-129` 已区分失权关闭 claim gate 和正常 pause/dispose 的原 runtime 取消；不应把后者用于失权。现 Task 模块的构造默认和真实启动根尚未接入所选执行权，单改后台循环无法保证资源模式的全入口停止派发。

`packages/backend/src/cli/start.ts:582-592` 当前绑定的是原共享 control 的 start/pause/resume。本批只增加 Task 自有切面；后续真实根必须为每次 grant 捕获其独立 handle，不能借共享 control 的零参数 resume 打开 selected 执行。

## 层次和合同

新增中立 application port `packages/backend/src/modules/task-execution/application/ports/taskProviderAuthorityRuntime.ts`，只定义回调和 Task 自有 runtime handle，不依赖 SO/CS DTO、平台 lease 或 CLI 类型。

authority 输入为只读 `{ current(): boolean }`。创建 handle 时捕获原函数对象和原 receiver，以绑定同一次 context；之后修改输入对象的 current 属性不得改变已创建的 lifetime。

handle 提供 `pause(): Promise<void>`、`quiesceAuthorityLoss(): Promise<void>`、`drain(): Promise<void>`。正常 pause 保留原 Task pause reason、取消和真实 runtime ACK；失权只关闭新 claim/循环派发并等待原已受理工作，不调用 abortAll/dispose。两种停止 ACK 独立记录，等待中的正常停止不能充当失权 ACK。

独立 composition 扩展 `TaskExecutionProviderBackgroundControl.startAuthority(dependencies, authority)`，返回这一代的 Task handle。原 `start(dependencies)`、零参数 `resume()` 及全部 native 控制面继续工作。一个 control 首次选择 native 或 selected 后不得混用；selected 不退回 native，也不允许零参数 resume 绕过 context。

不增加 CLI/CS 业务分支。原配置 query、scheduled operations、恢复命令、module 和真实 provider persistence 继续由当前 Task composition 装配。

## 每代生命周期

每代有自己的 captured current、循环、启动 Promise、停止/排空 ACK 和退役状态；不得把旧异步 continuation 改绑到新 context。只有上一代的真实 drain 完成，才能创建下一代；旧 handle 的重复 pause/quiesce/drain 只能操作旧资源。

selected start 在任何配置读取、timer 或业务恢复之前检查 current。缺少合法回调或 current 为 false 时立即失败，不创建循环、不读取配置、不恢复任务。通过检查后同步关闭 Task claim gate，并等待已受理 claim 的真实 ACK；await 之后再次检查原 context，失效则保持关闭。

配置 query 与原 read failure 语义保持。循环和启动任务绑定该代的 captured current，在每个原配置 await 后、调用下一条业务命令之前检查。失权期间 timer 不派发新业务；quiesce 立即清除 timer 并等待正在读取/运行的原循环。

启动读取和已发出的 auto-resume 都归入该代 drain。晚到配置结果不得恢复旧执行。已经发出的 auto-resume 等待其真实结果，不伪造成功或取消；尚未发出的启动恢复保留为待完成工作，下一代以当前配置执行，不能消费旧读取结果。恢复已经实际发出后不因换代重复发出。

新一代只在旧 drain ACK 后创建新的循环，并重新检查 current 后打开 module。原循环频率、监督 tick、热配置、schedule 专属 legacy reader 条件和 observation callback 保持。旧 context 的后续通知不得关闭新一代 claim gate 或取消新一代任务。

selected 启动读取失败必须收回自己创建的循环、等待真实停止/排空再向调用者报告失败；不泄漏无法取得 handle 的后台工作。停止过程中失败只重试缺少的 ACK，不重复已成功的业务效果。

## 正常控制与最终关闭

原 native start、pause、resume、stop、close、awaitIdle 的顺序和错误预算逐项保持。selected handle 的正常 pause 使用原正常停止策略；全局 stop/close 仍是终端关闭并使用原 dispose reason。close participant 的最终 provider 释放责任不迁移到 application port。

selected control 的全局 pause/quiesce/awaitIdle 转交当前实际 lifetime；最终关闭等待实际 lifetime 后再执行原 module dispose。所有全局入口保留 serialized 顺序，失权关闭派发发生在等待队列之前。已经完成 drain 的旧 handle 再次调用，不操作当前 module。

## 回归与边界

保留原完整 `rfc370-task-background-configuration.test.ts`、`rfc370-task-authority-loss-quiesce.test.ts` 和 `rfc370-root-background-bindings.test.ts`。新增实际 TaskExecutionModule、两 provider persistence 和原 loop timer 的回归，至少覆盖：

- start 前无效 context 的零配置读取、零 timer、零恢复，以及缺少回调拒绝。
- 配置 await 后 current 已失效而 quiesce 通知尚未到达时，零 auto-resume/repair/schedule 新派发。
- 失权同步关闭 claim gate，等待 held config、原命令和 claim permit 的实际 ACK，不批量取消 live runtime。
- 旧 drain 尚未完成时新 grant 被拒绝；完成后读新配置，旧 handle 不关闭或取消新一代。
- 原函数对象/receiver 被捕获，输入 current 属性替换不能重绑旧代。
- 正常 pause 正在等待时发生失权，两种真实 ACK 独立，正常取消只来自原正常请求。
- 配置读取失败的真实清理，以及正常最终 close 的原 reason/ACK。

Windows 原触发路径和平台命令加入新增套件；全部旧 YAML、测试用例、断言和预算保持。只运行本批格式/lint、纯 AST/字节/JSON 对照和一次原静态清单生成；功能测试由精确 SHA GitHub Actions 执行。

此切面只负责后台命令的受理边界和已受理工作 ACK。命令内部的逐 Task 派发、Task 原业务事务对同一执行 context 的消费、所有 HTTP/child/group/事件 admission，以及 resource-only 创建根在暴露 HTTP 前关闭 claim gate，仍属于下一批完整 Task/真实根接线。不能以一个 current 回调声称原事务已原子绑定远端 lease，不能以后台有限 PASS 声称 Task group ready。

## SOURCE4-R1 实现候选

设计门有效稳定 PASS 已由根会话绑定十四项实际内容和三个包装后进入实现。新增独立 Task application port 与 composition startAuthority，每代持有自己的配置/启动、循环、停止和排空 ACK；保留原函数及 receiver，旧代不能操作新代。原正常停止的已返回 runtime tickets 复用，失败仅重收实际 ACK；失权不发行新取消。配置或初始 claim ACK 失败先实际清理后报告。

新增每 provider 九个回归，实际 TaskExecutionModule、owner/intent 行与原 timer/persistence 参与；三套旧测试完整字节保持。纯 AST 逆变换恢复原整个 providerBackground，全部原循环、native 方法和预算保持。首次 lint 的 const 问题与首次私有 checker 的 printer 布局比较失败原样保留，修正后的目标 lint/format 和完整 AST 结构对照通过。未运行 AW tests/typecheck/build/service/census；Windows 新套件登记将在前批发布后独立完成。

当前没有真实根消费 startAuthority，也没有完成 Task 原事务、命令内部逐 Task dispatch 或全入口 admission，不声明 Task group ready、H7/A-G/RFC 或 CS 部署完成。

## SOURCE4-R2：实际 module-open 启动 ACK

SOURCE4-R1 原正式有效 FAIL 与唯一 P2 H7-TASK-BACKGROUND-SOURCE4-F01 保留，根会话已绑定完整 32 项和三个包装后修改。必需的 module.resume 现在独立形成 moduleOpen Promise，启动等待其真实成功；autoResume 继续使用原 detached 链，已发出工作仍由本代 ownedStartup 跟踪。打开原 gate 抛错时进入原失败清理、等待循环停止与排空，再向调用者报告原错误，不返回成功 handle。

新增第十个双 provider 回归，用实际 TaskExecutionModule.seal 触发原 resume 错误，证明启动拒绝、每个实际 timer 都被清理、没有 auto-resume/repair，并且下一尝试经过同一真实 gate 而非假 pending drain。原九个回归、三套旧测试、native 全体 AST 和原文档完整前缀保持；新有限源码门、Windows 登记、唯一 scoped census、配套门和 exact-SHA CI 分别留证，完整边界仍开放。

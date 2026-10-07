# RFC-370 selected 轮询运行 handle 切面 D1

本增量承接已批准 H7 设计，补 CLI provider 的原轮询 handle 适配器所需的独立 selected 入口。原 native 工厂及全部语义保留；本片不接 CS，不关闭实际启动根、完整十九 owner、命令内部准入、Task 原事务、H7/A-G 或 RFC。

## 当前调用与 owner

`cli/daemonProviderRuntimeHandles.ts` 已有 managed worker、polling、eager/lazy pausable service 等完整原适配器。两 provider 的启动根用 polling 工厂控制 memory distill、development wake、DE OS、Event Center、fusion、limits 和 idle-timeout。原 polling 工厂拥有计时间隔、beforeStart、run/onError、独立 AbortController 和真实 done；stop 只停止下一 tick，drain 等实际在途 run，原 run 没有收到这个 sleep controller 的 signal。

`cli/daemonProviderRuntimeSession.ts` 已有完整 selected handle binding，包含 id、named group、start、专用 loss quiesce/drain，按原 generation/context 记录正常停止与失权 ACK。实际根尚未传入完整 binding。仅在根外检查一次 current，不能阻止 owner 在配置/query await 后再派发下一效果。

本片仍由 bootstrap 所属的 CLI handle adapter 拥有运行生命周期，业务读写、恢复和命令内部派发留在原 owner。不会把 worker 业务规则移入 SO，也不让共同切面认识 CS DTO。

## 新独立完整选择

新增 `createAuthorityPollingDaemonRuntimeHandleBinding`，返回现有 `DaemonProviderHostExecutionHandleBinding`；使用原合同派生 group、start scope/context 类型，不新增平台协议。原 `createPollingDaemonRuntimeHandleFactory` 整体保持。

输入包含 id/group、原正整数 intervalMs、runImmediately、可选 beforeStart、必需 run/onError。selected 函数完整性在任何效果之前验证；不完整选择不补 native。新函数捕获所选回调身份和 receiver。

每次 start 捕获原 context/current 函数与 receiver，并保留原 scope/context/reference identity。交给本代 beforeStart/run/onError 的参数增加独立捕获的 `current()`，供各 owner 在实际 await 后、下一项写入/派发前使用；它不随着外部替换 context.current 或回调属性重新绑定。共同 adapter 也在 beforeStart 前后、每次 run 之前及在途 run 完成后检查这个捕获的 current。

current 缺失、scope/generation 不配对或 start 时已失效，在创建 timer、调用 beforeStart/run 或任何业务效果前拒绝。beforeStart 的真实 Promise 是该次 start 的 ACK；迟到 ACK 后发现失权则返回已停止且零循环的实际 handle，由原 RuntimeSession 收回该代，不能启动定时器或 immediate run。beforeStart 拒绝保持原实际错误且不遗留循环。

业务回调内部的逐步派发必须使用传入的捕获 current；本片不以轮询入口检查替代命令内部准入，也不宣称某 group 已完整适配。root 后续必须逐一改造各实际 owner 的查询/配置后派发点。

## 停止与真实排空

每个 handle 只控制自己的本代 sleep controller、已受理 callback Promise 和 done。normal stop 继续采用原 timer 停止语义；loss quiesce 同步标记本代退休、清理等待 timer、阻止下一 run，然后等待其实际在途 ACK。这个 controller 只控制轮询等待，不能传给已发出的业务工作作为取消信号；loss 不调用 owner 的正常 bulk cancel。

loss drain 必须先发生本代 loss quiesce，等待原 done 及原错误；未停止不能成功 drain。binding 的 loss 方法校验实际返回 handle 与原 context identity，错误 handle/context 在任何停止效果前拒绝。旧 handle、重复通知和旧 drain 不能影响新代 controller。某次实际 callback/error ACK 拒绝按原错误结算，不能制造成功回执；需要新的 epoch 时仍由原 RuntimeSession/lifecycle 等待旧代真实退场。

原 interval、runImmediately、原错误预算不改变，native 全部函数、旧用例、断言和时间预算保持。selected callback 仅收取原已发出工作的结果；收到 loss 后不发新 run，也不把资源 HTTP/WS 关闭当作执行停止 ACK。

## 回归与发布

新增回归使用原 timer 和实际 RuntimeSession selected 合同，明确区分 provider scope fixture 与真实十九 owner/数据库验收。覆盖无效选择的零 timer/零回调、held beforeStart ACK 期间失权、held run 的真实 loss drain、query await 后捕获 current 的功能、callback receiver/property 替换、原 onError 和真实失败、正常 stop、旧 handle/new epoch，以及错误 handle/context 的零停止效果。

固定原 `daemonProviderRuntimeHandles.ts` 完整前像；只增加新 selected 声明和一个原类型 import，AST 逆变换恢复整个原模块。保留原 `rfc349-daemon-provider-runtime-handles.test.ts`、相关 runtime-session 回归及本片触及的源码 reader 完整字节。设计/实现独立功能门分别绑定真实候选；本机只做本批格式/lint、静态 AST/字节和一次必要的 original scoped census，功能 tests/typecheck/build/service/E2E 交 hosted 精确 SHA CI。

本片随后交给实际根逐 owner 接线。maintenance 构造前延迟启动、其它 managed/service owner、提前 boot writers、Task 原事务/准入、UI、完整 A-G 仍分别完成。之后才进入各层 CS adapter，按 M0 首次部署、M1–M4 逐步接入的原顺序交付。

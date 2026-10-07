# H7 provider runtime 的执行权切面

本片落实已获批准的 H7 D1/D2 设计，仅增加实际 provider runtime session 的完整 owner 配对入口；尚未把两个 bootstrap 的十九个原入口接线，不关闭完整 H7、A-T7/A-G、CI 或 CS 部署。已有资源会话和原 native 生命周期继续使用同一实现。

## 完整选择与资源就绪

CLI composition 可传入 `hostExecutionRuntime.handles`。每个实际 runtime/background factory 必须按原 id 配对一个 group、selected start、authority-loss quiesce 和 drain；缺项、重复、未知 id、缺少 group 或方法在任何 admission/start 副作用前失败。当前实际 root 的五个 runtime 与十四个 background 共十九项，需要后继逐项提供其原 owner 的真实回调，不以本片测试中的十九项 fixture 冒充实际接线。

省略选择时，仍调用原 native factories，保留资源 resume、正常执行 pause/resume、stop/drain、七个 close participant 到 identity/provider 的原顺序。显式选择时，资源 resume 只打开原 HTTP/WS 和资源写入口，执行默认关闭；此时未获准备后的 grant，十九个执行入口均不启动，没有 selected-to-native fallback。

session 返回的 `hostExecutionRuntime` 只在完整选择存在时提供。SO lifecycle 原 claim → recovery prepare → driver activate ACK 之后调用该 family 的 start，并传入原 exact grant context 和实际 ready groups。family 要求同一 provider generation、已运行的资源会话、当前有效 context、未退役的请求版本；只按原 factory 顺序启动就绪 group，每次 awaited start 前后重新检查 context。最后一项真实 start ACK 完成前不标记 execution running。

## 失权、迟到启动与正常关闭

family quiesce 同步废止旧版本并关闭新执行，然后串行等待各实际 handle 的 owner ACK。authority-loss 使用该 owner 的 `quiesceAuthorityLoss`/`drainAuthorityLoss`，与正常 handle stop/drain 分开；drain 不越过尚未 ACK 的 quiesce。真实返回的 handle 保留其 exact context、owner 和原 factory id，不以新的 grant 替换旧 handle 的归属。

SOURCE4-R1 独立功能门有效稳定 FAIL，发现正常 SO shutdown 在 held start ACK 期间先使 current=false、稍后才送到明确 quiesce reason，会被旧候选误选为 authority-loss。该候选没有发布，原正式失败回执与根绑定完整保留。后继只依明确 reason 选择失权面；原因尚未到达时保留 exact handle 等真实 SO retire，不从 current=false 推断原因。新增真实 SO lifecycle 的 held-start＋close 回归，要求 normal stop/drain、零 loss 回调且 release 等正常 drain。

丢失后才返回的 start handle 仍登记并按原失权原因收尾；不再启动后面的 handle。已排队的旧 resume 不能重新启用失权版本，新 grant 必须等旧 handles 排空。quiesce/drain 失败保留原错误并且只重试未 ACK 项；已成功的 handle 操作不重复。provider close 等待 pending start 及其实际收尾，不把已丢失的 context 改成普通 cancel。未失权的正常执行 pause、provider pause/close 继续使用原 stop/drain。

SOURCE11-R2 独立功能门有效稳定 FAIL，发现 held normal stop 后收到 loss 时，修改请求模式会让成功的 normal ACK 被误记为 loss ACK，实际 Integration owner 尚未 quiesce，后续 loss drain 永久拒绝。该候选没有发布。SOURCE11-R3 分别记录当前请求模式、实际 stop ACK 模式和实际 drain ACK 模式；等待中模式改变后，普通 ACK 仅结算普通操作，还须等原 owner 的真实 loss quiesce/drain。普通 drain 的迟到 ACK 也不能移除仍欠 loss ACK 的 exact handle。新增实际 Integration worker 与实际 runtime session 联合 held-stop 成功回归，以及双 provider tag 的 held-normal-drain 回归；两个历史失败回执及根绑定完整保留。

资源状态与执行状态分开：失权后的 resource session 仍 running，可以继续原资源查询和编辑；本片不把这种状态伪装成可执行。owner 已受理业务、Task 原事务、实际 dispatch、提前恢复与 UI 就绪状态需要后继沿同一 context 接线。本片 family 的同步关闭不能替代各实际 owner 在配置读取/awaited dispatch 前后的即时检查。

## 回归与验收边界

新回归在 sqlite/postgresql 两种 provider tag 下调用实际 `createDaemonProviderRuntimeSession`，覆盖完整十九项配对、资源待机、就绪组顺序和 awaited start、全部失权 ACK、旧 resume/新 grant、迟到启动、正常 pause/resume、失败 ACK 重试、关闭等待、错误 generation/空组。另将实际 SO binding/lifecycle 与实际 provider runtime family 连起来，证明 driver activate 在 handle start 前、实际 owner drain 在 driver release 前，资源会话仍可用且没有普通 stop/cancel。

这些是可控 callback 的实际会话回归；不是 PostgreSQL 数据库实例验收，也不是原十九个 owner 已全部接线的证据。原 `rfc349-daemon-provider-runtime-session` 与 `rfc370-execution-runtime-lifecycle` 用例全文不改；新增套件只追加到原 Windows push/PR 路径和平台命令，保留全部旧 case、预算、步骤与环境。

本机只做 owned 格式/lint、纯 AST/byte/JSON 对照，不执行 AW tests/typecheck/build/service/E2E。源码必须经独立功能复核和根会话完整实际文件绑定，再对最终候选执行一次原 scoped census及精确配套投影。新精确 SHA 的 hosted CI 是正式测试判据；实际 bootstrap、提前恢复、Task 同事务上下文、完整十九项 owner、全部 admission/UI、H7/A-T7/A-G 与 CS M0～M4 继续开放。

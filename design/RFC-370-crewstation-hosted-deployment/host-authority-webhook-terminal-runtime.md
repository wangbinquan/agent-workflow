# H7 webhook terminal-control 的实际 owner 停止面

本片是既定 H7 设计下的一个实际 owner 切面，补齐 Integration terminal-control 的失权停止派发与排空能力。没有把十九个入口全部接线，也没有提前接入 CS。原正常 provider stop/cancel 和耐久逐目标收据继续保留。

## 独立 runtime 合同

`application/ports/mrTerminalControlRuntime.ts` 扩展原 `MrTerminalControl`，通过 exact `public/participants` 导出 `MrTerminalControlRuntime`。既有业务合同全文保持，旧调用者仍可只消费原面；实际 composition 返回包含 `quiesceAuthorityLoss` 和 `drainAuthorityLoss` 的完整 owner。后继 bootstrap 需要显式配对这两个方法，不允许在 selected 路径降级使用普通 `stop`。

composition 接受可选 `canDispatch`，其调用读取同一 grant 的实时 current 状态。省略时仍为原 native 行为；selected bootstrap 要显式提供真实 context，不把配置快照或 enabled 布尔值当作 grant。public runtime 不包含 CS wire DTO、数据库句柄或平台私有字段。

## 失权与真实 ACK

`quiesceAuthorityLoss` 同步废止旧派发版本、停止新 wake/claim、清理 interval 和这个 owner 创建的所有 retry timeout。它不调用原 `supervisor.abortAll`。`drainAuthorityLoss` 等待原实际在途 attempt 和提前 `reconcileOnBoot` 的真实 ACK，不把停止定时器记为排空完成。

每次实际 guard list、claim、launch barrier 和 release-outcome await 后重新检查原 invocation 的 current/version，丢失后不再启动 Task 取消或第二轮 fixed-point sweep。尚未执行的迟到 claim 保留原耐久 leased 事实，交由原 lease/recovery 处理，不伪造 succeeded/canceled 收据；旧派发未 drain 前拒绝 resume，新 grant 不能收编旧 invocation。

已经在有效 grant 下发出的 participant apply 仍等待真实响应，并将它返回的逐目标收据写入原 receipt intake；receipt intake ACK 不代表整个控制效果已经 succeeded。失权后不做下一次 apply、等待重试或普通 bulk abort，已持久收据保留供下一 owner 恢复。这里不宣称 AW 与 CS 远程请求可以原子提交；实际 Task 原事务上下文与 CS durable-intent adapter 是后继工作。

原 `stop` 完整体仍设置 stopped、停止 interval、调用 `supervisor.abortAll` 并等待原 active attempt；正常执行的两次 sweep、原错误/重试预算和完整收据投影保持。new loss 面与正常终止面分别调用，不通过 `current=false` 猜测一个普通 shutdown 的原因。

## 回归与交付边界

新套件调用实际 worker、实际 launch-guard coordinator 和实际 provider-neutral composition，覆盖 standby 零 work、迟到 claim、已受理 apply 的真实 receipt、held barrier、held guard list、提前 boot ACK、正常 stop、旧版本/后继 resume、retired retry timer、quiesce 前 drain 拒绝及 composition 的完整双面。原 RFC-349 worker/provider-fence 用例和时间预算全文保持。

SOURCE11-R2 的实际运行会话复核发现 normal stop 的迟到成功 ACK 可能跳过 owner loss quiesce。SOURCE11-R3 联合本实际 worker 与实际 RuntimeSession，在 sqlite/postgresql 两种 provider tag 下稳定保持 apply ACK，再在 normal stop 等待中送达 loss；要求只执行原已发出的 normal bulk abort 一次，保留 actual receipt，不做第二次 apply，并且实际 loss quiesce 恰一次且先于 loss drain。原 owner 方法不作该修复之外的改动，正常 stop 完整体继续保持。

本机只执行 owned 格式/lint 与纯 AST/byte/JSON 对照，没有本机 AW tests/typecheck/build/service/E2E。正式功能门及精确 SHA hosted CI 分开验收。新原 runtime port 及 owner 方法只是完整十九入口接线的必要依赖；实际 bootstrap、Task 原事务/admission、其他 owner、UI、完整 H7/A-T7/A-G 与 CS M0～M4 均继续开放。

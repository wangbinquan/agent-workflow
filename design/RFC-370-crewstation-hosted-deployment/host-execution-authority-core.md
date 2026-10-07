# H7 执行权生命周期核心（有限实施候选）

本批依赖 `host-execution-authority.md` 的 D2 功能设计门，仅实施 system-operations 的中立生命周期与 local 单实例借用 adapter。完整 H7、A-T7、A-G 尚未通过，CS adapter 尚未实施，AW 尚未部署到 CS。

## 本批行为

中立 driver 的 claim、renew、activate、quiesce、release 和 subscribe 为完整所选 family；中立恢复 family 的 prepare/quiesce/drain 与 runtime family 的 start/quiesce/drain 分别承担自己的 ACK。核心不读取 reference 的内部字段，不含 CS DTO，不改变 Task 的原事务 owner。

执行入口只在恢复准备、activate 与 runtime start 三项 ACK 完成后开放所选 named group。resource-only 不 claim、不恢复、不启动执行组。失去执行权或关闭时同步停止新 admission，并向既有 admission 发出独立的停止原因；新一代必须等旧代 quiesce、drain、业务 owner 的完成 ACK 和 release 后才启动。

claim/renew/activate 的迟到 granted reference 仍由当前生命周期跟踪并退役。关闭订阅可与未返回的 control 并行开始，但完成关闭必须等所有在途响应、迟到 reference 的 quiesce/release、恢复/runtime/admission ACK 和订阅 close ACK。每项 ACK 单独记录，重试只继续未完成的阶段，不重放已完成的阶段。

local factory 同步创建，借用原启动 lease，不再次 acquire，不读取 PID diagnostics 或 Task 恢复 receipt，不调用原 lease 的 release/releaseOnExit。原 daemon host 继续拥有 PID 的释放与失败启动收尾。embedded HTTP 保持原进程及 Task owner 的语义。

## 回归候选与证据范围

新增两份回归覆盖 resource-only、完整 family、opaque reference 和 receiver、恢复/激活/start 时序、迟到 claim/renew/activate、订阅关闭期间的新 reference、立即停止 admission、各阶段失败后的 ACK 重试、原失败对象，以及双 provider 的原 daemon host 关闭/失败启动释放 ACK。

只对本批五个 TS 文件运行目标 Prettier、ESLint 与纯源码解析/字节证明；没有运行本机 AW test/typecheck/build/service。测试结果以发布候选的确切 SHA hosted CI 为准。有限独立源码复核另有冻结 manifest、完整候选、allowlist 与回执，不以此文自签通过。

## 下一批仍须完成

三个实际装配根的所选 factory/recovery/runtime、公有合同、原 Task 四步 boot recovery 的切换、所有在途 Task 写入上下文、全部 named admission、19 个执行/后台句柄，以及停止派发与原业务取消的区分，均未由本批接线。未接线的现路径继续走原实现；不能把本批核心测试当作这些生产调用者已经迁移。Task 配置的所有热读取入口、后台恢复的剩余 owner 与 A-G 总体验收继续，随后按已批准顺序实施各层 CS adapter，先 M0 实际部署，再逐项 M1–M4。

## SOURCE7-R1 失败的正常向前修正

SOURCE7-R1 首末完整绑定有效稳定，但功能门 FAIL，原完整候选和回执保留。F01 是首次 adopt 前的多个不同 grant 未使前者过时；F02 是 subscribe/claim 启动错误后已排队 grant 仍可能激活。本次每个新 reference 的 observation 都先令上一代过时，同一有效 reference 的重复 observation 保持幂等；启动错误先关闭新增 admission 并结算所有已观察的 reference，再保留原失败对象返回。所有原测试正文/名称/预算/断言保持，追加六项实际异步回归，覆盖重复/替换观察、pending claim 的不同迟到结果，以及 subscribe/claim 的同步/异步失败。R2 有限源码复核另记，未据修正文字自签通过。

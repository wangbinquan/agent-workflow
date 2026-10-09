# HTTP handoff 后续写入的 CI 配套

精确 `ab457f9c8e5b9eb8859a2866a5b2165d245b0406` 的主 CI `37987208134` 中，Ubuntu backend shard 7 job `114012062284` 的原 PostgreSQL HTTP handover case 失败：同一个 mission 的 handoff 返回 200 后，紧接着 resume 在原 200 断言处实际返回 409。分片实际 `819 pass / 1 fail`、73 文件，原始日志与作业元数据完整保留；日志没有响应 body，不能把具体冲突 code 写作已经观测到的事实。该 SHA 的完整默认 Windows `37988483492` 与四个工作区类型检查均成功，不代签主 CI 总绿。

原 handoff 路由通过 `missionOperations.ts` 的 `fireReconcile` 异步启动真实 drive。此 HTTP 夹具的 `seedMission` 将 policy 引用设为 null，`missionReconciler.ts` 因而选择 `block(policy-content-missing)`，最终 `publishReadiness` 再通过原 `occUpdate` 写入 revision 和 readiness。`missionDriver.ts` 对这个 blocked 结果立即停止；后续 `.then/.catch` 只记日志。`providerHttpApplication.ts` 的真实应用装配不启动周期调度。因此在同一个 mission 上立即 resume，会与这次尚未完成的版本写入交错，这是源码支持的时序解释；实际排障不扩展到权限规则或其他业务。

只在原 HTTP case 的 handoff 和 resume 之间，以原 `fx.store.getMission(m1)` 等待 seed 中原本为 null 的 readiness 首次非空。轮询间隔 10ms，最多 10 秒后给出该 mission 的明确诊断，原整条 test 的 `120_000ms` 预算保持。两条命令仍操作原同一 mission；原全部 case、HTTP 状态、typed code、matcher、三命令 provider 回归及清理保持。没有 HTTP 重试、后台 drive stub、生产代码修改、新规则或 census。

有限独立功能门、保持检查、精确发布与新 SHA 主 CI／完整默认 Windows 分别验收。现有生命周期候选的 69 项内容保持，不借这次 CI 配套签收其 211 个新 case；AW 在 CS 的部署与 RFC-370 仍未完成。

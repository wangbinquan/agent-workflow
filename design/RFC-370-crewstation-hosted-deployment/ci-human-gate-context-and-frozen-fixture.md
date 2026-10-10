# RFC-370 HumanGate：上下文解析与冻结夹具的 CI 修复

本片修复已发布的 HumanGate 增量，继续遵守完整主 CI 与默认完整 Windows 总绿门槛。SOURCE1-R2、MATCHING1-R1 的 PASS 及已消费回执保留为历史证据；它们不代替本片的新源码检视或 hosted CI。完整 H7、A-G、各层 CS adapter、M0～M4 与 RFC 仍未完成，AW 尚未部署到 CS。

## 原失败证据

源码提交 `32679b0c20f69162fbcc71ca94e7cb286a31e9aa` 和紧邻许可退役提交 `eb6a4884389257ea0989ce8f21fa3a442c009c25` 已推送。该精确 SHA 自动触发了[主 CI 38037342413](https://github.com/wangbinquan/agent-workflow/actions/runs/38037342413)及[完整 Windows 38037342486](https://github.com/wangbinquan/agent-workflow/actions/runs/38037342486)，没有手动补跑或重复触发。

主 CI 的一个排障快照为 47 success、4 failure、20 未完成，共 71 个已创建作业，流水线尚非终态；这不是总绿结论。Windows 已 completed/failure。已取得五个失败功能作业的原始日志，定位到三个原因：

- 类型作业在 `composition/humanGate.ts` 报六个 TS2339：封闭的 `TaskExecutionContextRef` 只提供身份字段，不能直接读取内部 `persistence`。
- Ubuntu HumanGate 分片与 Windows 的 H05/H08 遇到相同 Proxy 约束错误：在冻结的完整 drive 对象上，`get` 不能为不可配置且不可写的属性返回另一函数。
- Ubuntu 与 macOS 的 T19b 组合根守卫发现 HumanGate 新增一个 marker；判断来自运行时选择规则的 `human-gate-task-host-binding-not-composed`，没有对应的晚绑定 holder。

原失败及全部历史检视回执保留。未读取 Static scans 的原始日志；若该作业实际失败，按用户批准只做必要 CI 排障。

## 修改与原行为

显式上下文沿用 `taskHostExecutionWriteSelection.ts` 已有的同步解析方式：在原上下文中调用 `currentTaskExecutionContext()`，得到同一个内部完整实例；环境上下文继续按原 taskId 读取。公开的封闭引用、显式输入优先级、原校验和所有 SQL／事务输入保持，不添加类型断言或额外数据库检查。

绑定是否满足所选用途的判断移入已有的 application 选择层，以 `requireHumanGateTaskHostBinding` 返回原绑定或抛原错误。composition 计算原显式／环境绑定并调用该选择规则，然后完整创建用途视图；没有可晚补的槽。原错误码、条件、错误优先级和拒绝行为保持，T19b 规则与账本不改。

H05/H08 的夹具提供完整的三方法 drive：`load` 和 `updateWorkspaceProfile` 绑定原 receiver，`findStatus` 在原位置完成一次真实 manual question 后调用原方法。原对象继续冻结，全部 46 个 provider 案例、一个全局案例、既有断言与时间预算保持。

有限逆变换只更新 HumanGate 的已知 introduced 片段及 UTF-16 位置；九份原源码身份、37 项编辑及十个真实调用条目保持，逆变换仍恢复完整原字节。其他生产文件和生命周期用例保持。

## 验证和发布边界

本机仅进行 owned 格式／lint、纯 AST／JSON／完整字节对照。原 T19b 纯声明只在这一份源码文本上求值，修复后的 marker／prose／holder 为 0／0／0；没有执行完整守卫、AW tests、typecheck、build、service 或 E2E。纯对照证明原测试全文可由唯一夹具替换恢复，注册名称、断言参数与预算保持；静态人口仍只代表预期。

新源码功能门、基于已提交基底的唯一原 census、配套功能门、精确路径发布及新 SHA 全部主 CI／默认完整 Windows 分别验收。架构配套的实际变化由原生成器确定，不预填高水位、不更改规则。共享清单正有并行输出，等待其正常提交后再生成本片配套，保留所有并行内容。

HumanGate 预期 187 次与原生命周期预期 211 次仍须新 SHA 实际执行，总计 398 次；不以静态证明或部分作业成功代签。只有总绿后才继续下一批恢复／控制写入和其余 H7 接线。

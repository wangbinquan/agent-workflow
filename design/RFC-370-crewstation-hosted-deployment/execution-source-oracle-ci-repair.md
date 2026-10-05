# RFC-370 执行切面源码检查的 CI 修复

本片只修复 H4 切换到中立执行 submit 后仍定位旧调用的五份源码检查，不改生产代码、native 进程机制、分类器或 canonical 产物。仍在 A-T5；完整材料／取证／生命周期／执行／回执组合、全部真实装配根、脚本与执行权／恢复继续，A-G、CS adapter、M0 首次实际部署与 M1～M4 均未关闭。

## 原失败与修复范围

源码提交 `ad1da74c0463f2f77e0e93e2df127e5e3412b07a` 的 Windows `37268055262` 正式 failure：平台 271 pass／3 skip／1 fail，唯一失败为 subagent-live-capture-source 仍查找 runner 的 `await runAgentProcess({`。新增执行接口的全部 12 项用例（含五项真实 native）在该作业通过，只代表对应证据。主 CI `37268055252` 正式 cancelled，已返回的 46 个 jobs 为 13 success／30 cancelled／3 failure；Ubuntu 3/16 两条 PWD 源码断言失败，Ubuntu 8/16 native pages 的旧 revision 用例失败及 required 汇总失败保留各自归属，不报告全仓绿色。

- subagent-live-capture-source：定位实际 `await localExecution.effect.submit({`，原一次 poller、运行返回后停止、停止后 post-capture、BFS dedupe 与原故障标记断言全部保留。
- opencode-spawn-pwd-env：保留原 runtime `PWD = cwd` 与 managedProcess 单一 spawn 的检查；追加 Task 和 System 的惰性 workingDirectory／environment 绑定，追到同一 native adapter 的 cwd／env 转交和原 runAgentProcess。原 distiller 继承、scratch、环境基线与不重复 spawn 检查保留。
- scheduler-audit-s15：runner 的委托地址跟随实际 submit；原 POSIX／Windows 分支、TERM→KILL、宽限、reap、PID 与 bounded drain 检查不变。
- rfc371-span-runner-wiring：原 admission→baseline 与真实 startedAt→root 绑定跟随 beforeStart／onStarted；requireSpawnReceipt=true 仍检查实际 localExecution 的 native 构造参数。后续原双 root、reap／flush 和单次完整最终写入检查不变。
- rfc328-architecture-guards：只有 runNode 精确 act 名称与原缺登记负例跟随实际 submit；callName、namedCallable、taskEffectBoundaryViolations、rfc328GuardViolations 原完整函数 AST 不变，其余完整文件可逆恢复。

## 验证边界

五份原文件共 101 项 expect 全部保留或仅映射到实际 API 地址；额外九项补齐 native cwd／env 与 receipt 构造检查，原用例名与预算不变。纯 AST／字节证明检查原 predicate 不变、actual submit 与 native receipt 构造、admission 与 poller 顺序。原生产语料／13 份 canonical／Windows workflow 不变，测试文件不进入原 production sourceDigest；不重复运行原 census。

有限独立功能门与新 exact-SHA hosted CI 分别留证。仅对本片运行格式／lint 和纯静态证明，无本机 AW tests、typecheck、build 或服务。旧 source11／META16、growth retirement 门及所有原失败／取消回执保持；本片不替代完整 A-G 或实际部署验收。

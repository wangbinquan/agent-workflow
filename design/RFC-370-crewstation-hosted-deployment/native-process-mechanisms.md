# H4／H5 本机进程机制归位

状态：有限源码与 Windows 覆盖检视通过，正式发布／CI 待验收；尚未完成中立材料、执行、取证端口或 A-T5／A-G。

三份实际机制 `agentProcess.ts`、`managedProcess.ts`、`managedProcessLauncher.ts` 迁入 `packages/backend/src/platform/execution/local/`。完整文件字节与迁移前相同，保留 Task gated 与 system/smoke direct、原回调政策、stdin、stream pump、timeout/cancel、TERM/KILL/reap 和 Windows spool。旧 Agent/managedProcess 路径分别显式转导原 4／8 项 API；旧 launcher 保留原 18 项 API 和 `import.meta.main` CLI 委托，不将其记为纯薄 facade。单二进制 embed 的入口同步指向实际新机制。

原四份 source oracle 只迁地址：spawn 两处各 1、原完整 why、unattended void promise 4、PWD/cwd/env 与三处 ENOENT 判据及预算均保持。新增用例通过真实旧／新 launcher 文件接收完整 frame，核对 cwd、env、一次性 stdin、stderr、READY 和 Windows OUTPUT；POSIX 读取原继承管道，Windows 读取原 spool。两个入口均验证 EOF 返回 125 且 target 不执行。用例只由 hosted CI 运行。

H4/H5 设计首两轮 FAIL 与纠正后的第三轮有限 PASS 保留：原辅助取证失败保持业务结果；terminal 写拒绝保持原 complete/incomplete 意图重试；原 gated/direct 启动形态保持。源码首轮 POSIX 输出用例 FAIL 与纠正后的 R2 PASS 同样保留。

| 有限门              | 指纹                                                               |
| ------------------- | ------------------------------------------------------------------ |
| H4/H5 设计 R3       | `be48b13cc70e8c8ec57ab3ea76c1f30d67243aaf37257c4c4e4c297595314bb3` |
| NATIVE-PROCESS12-R2 | `24583e7f84a855bf5c9ac4872c76c61e42e873e4d8639cbf63bc0549ab94dc37` |
| WINDOWS-COVERAGE1   | `71bffe5befc4fbacff7c097e2286fce512243bc47cdb3142effb2c2d94197c49` |

原四规则在完整 committed `8f294c0c357a5e621b680a712d73025138a55801` 加冻结 12 TS 上只执行一次，13 份产物先存私有快照并通过原完整 JSON validator。并行 RFC-371 已提交内容作为基线保留，其余在制内容排除。sourceDigest 为 `sha256:3a1df07ad4bbedc70aba97cbda8b2ebe0e2e14068c12ff328c85b1f78fbe05d3`；实际只增加 3 个 native 文件 owner（26565→26568），原 55 个符号迁位。mutation、background、import、exception、public 数量均未增加；两份旧服务成为 thin facade，launcher CLI 继续为 legacy implementation。原 129 行库存及完整 why 保持，匹配发布的许可随后正常退役。

这一步只归位本机机制。三个 Agent 入口仍使用原物理材料和 RuntimeDriver；后续必须按[执行与材料实施设计](./execution-material-implementation.md)完成完整快照、opaque material/execution 引用、全部取证能力、effect/receipt 与真根接线，再继续脚本、专用命令及恢复。全部阶段 A 验收后编写各 owner 内的 CS adapter，按 M0 先部署、M1～M4 逐项接入；当前没有 AW-in-CS 部署。

## 发布前原 source oracle 补正

原 SOURCE12 和 META20 有限 PASS 保留。发布前另发现三份旧 source test 仍读取已转导的 managedProcess 地址，以及 C2 严格薄 facade 数组漏了两个实际新项。追加有限 SOURCE4 只将五次读取指向完整原体实际 owner，并在原精确数组增加 agentProcess、managedProcess 两项；launcher 保持 legacy，所有其它原字节、断言、fixture 与预算不变。

guard 只跟随 C2 实际行数 897→899，原扫描/机制/负例/阈值及其它所有行完整保持，provenance 由原 helper 更新。本批 production sourceDigest 和全部原计数仍保持；不重跑已成功 census。正式新 CI、Windows、完整材料/执行及 RFC/部署仍待验收。

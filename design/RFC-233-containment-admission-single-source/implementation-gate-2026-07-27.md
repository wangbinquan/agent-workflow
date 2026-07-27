# RFC-233 实现门（2026-07-27）

结论：**APPROVED（0 open P0/P1/P2；exact-SHA 远端门禁是提交后的发布证据）**。

当前 Codex 会话逐项复核 RFC-233 三件套与生产 wiring，没有委派 agent。审查覆盖 coordinator
线性化、built-in provider exact qualification、OpenCode outer/child/FFF、business runner、
Runtime Test、memory distiller、task preflight、config 热更新、status/UI/CLI、manifest codec、
failure taxonomy、source inventory 与平台集成。

## Findings

| 级别 | 问题                                                                                                                                  | 处理                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| P1   | `SpawnPlan` 仍允许 driver 回填 `sandboxTopology`，runner/smoke/distiller 若信任该字段，就可能覆盖 coordinator 已提交的原子 topology。 | 三条执行路径只消费 `preparedContainment.spawnTopology`；新增 source guard，禁止 driver 成为 topology authority。已关闭。 |
| P2   | RFC-224 的 source reachability 锁仍要求 verified core 自行重新发现/资格化 bwrap，与新单源合同相反。                                   | 更新锁定面为 prepared admission，并继续证明 business/system 只走共同 verified builder。已关闭。                          |

最终未关闭：**0 P0 / 0 P1 / 0 P2**。

## 架构不变量核验

- daemon 只创建一个 `ContainmentCoordinator`，通过显式依赖注入进入 route、scheduler、
  runner、Runtime Test 与 distiller；production 不再有 module-global provider getter/setter。
- 每次 spawn 只提交一份不可变 receipt；mode generation race 在 coordinator 内线性化。
  admission 永远 fresh exact qualification，status 仅使用有界 observability snapshot。
- `warn` exact-red 原子选择 outer+child `none` 并告警；`enforce` 在 runtime 私有文件和 spawn
  前失败关闭；`off` 不 qualification、不 render、不告警。
- Linux provider 同时拥有 qualification 与 renderer，outer/child 使用同一个 canonical、
  root-owned、完整 ancestor-safe bwrap；filesystem 与 OpenCode full profile 独立证明。
- macOS provider 冻结 child-only 单层 topology，避免嵌套 Seatbelt；真实 deny/allow 集成已通过。
- OpenCode core、FFF 与 hidden manifest 只校验/消费 prepared evidence，不重新决定
  mode/provider/topology；receipt 不进入 persistent session identity。
- Settings PUT 先持久化，再在响应前更新 effective mode；status/UI 显示
  configured/effective generation 与 mismatch。
- legacy `execution-identity-sandbox-required` 仅保留读取兼容；新生产 admission 写
  `execution-identity-containment-required`。

## 验证证据

| 门禁                        | 结果                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RFC-233 + 相邻 backend 定向 | 49 pass / 0 fail；另有 coordinator、manifest、runner、CLI、doctor、source guard 等批次均绿                                                                |
| Shared 完整                 | 1,441 pass / 0 fail                                                                                                                                       |
| Frontend 完整               | 5,291 pass / 0 fail；RFC-205/runtime 定向 34 pass                                                                                                         |
| Backend 完整                | 7,414 pass / 25 gated skip；受限宿主产生 46 fail + 1 error，12 个受影响文件在正常权限下精确复跑 114 pass / 0 fail；另外 2 个旧 source lock 修正后定向全绿 |
| 静态门禁                    | typecheck、lint、format check、diff check、depcheck（1,473 modules / 4,555 dependencies）全绿                                                             |
| 真实平台                    | macOS sandbox integration 6 pass；Seatbelt provider 1 pass；Linux strict bwrap/FFF/cancellation 由 push 触发的 `integration-opencode` Ubuntu 门禁执行     |
| 交付物                      | production binary build 成功，`version` 与 CLI help smoke 通过                                                                                            |

全量 backend 的受限宿主红项没有作为“重跑即过”处理：失败集合全部归因到随机端口
`Bun.serve` 与进程身份/`ps` 能力，随后对同一批文件在正常权限下精确复跑并取得 114/114，
与产品代码回归分离。Linux real bwrap 无法在本机 macOS 上伪造；仓库现有
`integration-opencode` push workflow 会安装 root-owned bubblewrap 并运行真实 topology、
FFF 与 cancellation/orphan proof，最终提交必须等待该 exact-SHA workflow terminal success。

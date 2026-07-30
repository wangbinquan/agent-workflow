# RFC-236 实现门（2026-07-30）

结论：**APPROVED（RFC-236 scope；0 open P0/P1/P2）**。

当前 Codex 会话在用户批准后逐项复核三件套、生产 wiring、测试与真实 UI，没有委派 agent。
本门结论只覆盖本地实现。用户随后明确授权“提交上库”；提交 SHA、远端祖先关系与 CI 由发布
流程在本门之后独立核验。

## Findings

最终未关闭：**0 P0 / 0 P1 / 0 P2**。

实现复审没有发现需要修改的 RFC-236 scope finding。验证期间发现一处既有
`rfc199-workflow-validation-targets` 精确计数锁需要纳入本 RFC 新增的 validator code，已将
预期 102 更新为 103，并以 7/7 定向测试关闭。

## 对抗不变量核验

| 边界 | 源码与回归结论 |
| --- | --- |
| 向后兼容 | shared reader 对缺失返回 false；旧定义继续 `exhausted`、task failed、下游不执行 |
| 严格配置 | 只有 boolean true 开启；validator 与 runtime 共用 reader，畸形 snapshot 在 wrapper row、iso 和 inner dispatch 前失败 |
| 迭代上界 | 主循环仍为 `i < maxIter`，继续分支交付 `maxIter - 1`，没有第 N+1 轮 |
| 错误边界 | inner canceled/failed/awaiting 在 exit/policy 判断前返回；开关不是 continue-on-error |
| 成功收尾 | 提前满足与上限继续共用 `completeLoopWrapperIteration`，共同提升 content/kind/archive、merge wrapper iso、写 done 并广播 |
| merge 失败族 | conflict 继续 park 为 awaiting_human；merge failure 继续写 failed；二者都不会落到 done |
| 下游与恢复 | 继续路径只产出标准 done row，generic frontier/downstream 与 done/fresh resume 无需识别新策略 |
| 竞态诊断 | `markWrapperTerminal(done)` 被其他终态抢先时会抛 superseded signal；结构化 continued warning 只在 done 与广播成功后执行 |
| 持久化与 UI | 可选字段沿 node passthrough/YAML/storage/snapshot 保留；sync diff 可见；Switch 紧跟 maxIterations 并使用 atomic history |

## 验证证据

| 门禁 | 结果 |
| --- | --- |
| RFC-236 定向 | shared policy/contract 49 pass；validator 38 pass；scheduler 6 pass；frontend inspector/target/copy 24 pass；RFC-199 source lock 7 pass |
| Shared 完整 | 1,482 pass / 0 fail |
| Frontend 完整 | 656 files、5,326 tests，0 fail |
| Backend 完整 | `bun run test:backend`：7,586 pass / 26 skip / 1 fail，25,849 expects、924 files；RFC-236 validator/scheduler/真实 Git artifact 用例全部通过 |
| Backend 唯一红项复核 | `structural-diff-assemble.test.ts` 在全量期间看到并行 RFC-235 创建的根目录临时 `.codex-state-rfc235.patch`，触发测试自己的 cwd-leak guard；同文件在正常权限下隔离复跑 7 pass / 0 fail |
| 受限环境复核 | 受限 sandbox 的 root backend run 还出现本地监听端口与进程探针能力失败；同一受影响文件集在正常权限下逐文件复跑全部通过 |
| 静态门禁 | typecheck、lint、format check、diff check、depcheck（1,530 modules / 4,783 dependencies）通过 |
| 真实浏览器 | desktop light、desktop dark、390×844 均无横向溢出或 console error；开关顺序、点击写 true、reload 保留、undo/redo 通过；控件是 enabled/focusable 的原生 checkbox，label 含提示 |

完整 backend 的唯一失败没有被记为“全量全绿”：它发生在与 RFC-236 无关的 cwd-leak
结构守卫，失败时仓库中存在并行工作的临时 untracked 文件；同一测试文件的隔离 7/7 与
RFC-236 在完整运行中的全部通过将产品回归和共享工作区干扰分开。实现门据此批准 RFC-236
scope，但不把这次全量运行表述为 0 fail。

应用内浏览器的 Space 注入在该驱动环境中没有形成可靠切换证据，且本轮未运行 axe；因此门禁
不声称这两项已完成。实现继续使用仓库公共 `Switch` 的原生 `<input type="checkbox">`，
没有新增自定义 keyboard/ARIA 行为；实际完成的可访问性证据限于原生语义、可用/可聚焦状态和
完整 label/hint。

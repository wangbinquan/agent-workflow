# RFC-529 业务模块的周期定时器改走平台定时原语（RFC-294 S12 第十步）

- **状态**：In Progress（2026-11-21）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 5 项；design §14“后台作业”一行
  （直接定时器只出现在平台定时原语与有 owner / stop 的执行局部计时）。
- **前序**：[RFC-528](../RFC-528-standalone-maintenance-worker-effects/proposal.md)（S12 第九步）。

## 1. 背景

S12 第 5 项点名业务模块里 4 处直接 `setInterval`（integration 的 MR 终止控制 worker、resource-catalog 两处 MCP 诊断 effect、task-execution 的子
任务预算告警）。按源码复核，业务模块里直接调全局 `setInterval` 的一共 8 处：除这 4 处，还有 4 处执行局部的计时——opencode 驱动的子会话实时
抓取、子调用节点的观测、执行看门与任务驱动的 owner 心跳。8 处都有各自的停止点（`clearInterval`），但没有共同的形状；已有的账本（架构报告的
“直接 `setInterval` 位置”与 `rfc376-structural-guards` 的 `KNOWN`）逐条列着它们，却只数 `setInterval`、不区分业务模块与平台。`platform/background` 的几处（维护服务、维护 ticker、维护 worker 运行时、备份调度）是平台的定时原语本身。

## 2. 目标

- **G1 平台定时原语**：`platform/background` 新增固定频率的定时原语 `startInterval({ owner, everyMs, tick })`，返回 `{ owner, stop(), unref() }`；
  语义与 `setInterval` / `clearInterval` 相同（固定频率、`stop` 幂等、`unref` 照旧）。
- **G2 8 处改走原语**：业务模块的 8 处改调原语，各带一个 owner 名，停止点改调 `stop()`；回调、周期、`unref` 与停止时机都不变。
- **G3 门**：新增 RFC-529 用例：生产代码里直接调全局 `setInterval` / `clearInterval` 的只剩平台定时原语与 `platform/background` 的既有几处（清单
  逐条相等）；每处 `startInterval` 的 owner 是字面量（带负对照）；已有账本（`rfc376-structural-guards` 的 `KNOWN` 与
  `direct-setinterval-sites`）按实测收紧。

## 3. 非目标

- `setTimeout` 一类的单次计时；`taskDriverLifecycle` 保存心跳句柄的模块级 `Map`（S12 第 4 项：模块级可变单例）；S12 第 3、4、6 项；任何行为、
  接口与界面变化。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：业务模块里没有直接的 `setInterval` / `clearInterval`；8 处都经平台定时原语、带 owner、停止点调 `stop()`。
- **AC-2**：每处的回调、周期、`unref` 与停止时机与此前相同；原语的语义与 `setInterval` 相同（固定频率、`stop` 幂等）。
- **AC-3**：直接全局定时器的清单只含平台定时原语与 `platform/background` 的既有几处，实测与清单逐条相等；计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

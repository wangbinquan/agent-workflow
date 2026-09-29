# RFC-371 / RFC-034 托管原生采集证明同步增量

状态：独立功能设计复核 PASS（2026-09-29）；尚未实现。属于两份已批准观测 RFC 的兼容补齐；本文件不解除 RFC-370 Phase A A–G 的生产装配门槛。CS 历史数字校正候选仍独立验证、发布，不能混入本批未实现内容。

## 问题与现有边界

CS 的原生采集摘要已经进入 `native_capture_history`，与用量和人民币估值共用持久水位；旧版公开观察只返回 usage / valuation。一个完整但无数值步骤的原生轮次因而只能同步空列表，AW 无法区分“确认未消耗”与“没有采集到”。历史修订已经通过 canonical usage 投影替换传播，本增量只补采集状态与证明，不重新计算或扣除原生恢复基线。

源码依据（2026-09-29 核对）：CS `modules/observability/adapters/persistence/usageSnapshot.ts:44` 的 `captureIncompleteAt` 与 `modules/observability/adapters/persistence/drizzleUsageLedger.ts:271` 的 `projectNativeCapture`；AW `packages/backend/src/modules/run-observability/domain/platformObservation.ts:164` 的 v1 页面合同、`packages/backend/src/modules/run-observability/application/platformObservationSync.ts:51` 的原子代次切换以及 `packages/backend/src/modules/run-observability/application/taskObservations.ts:255` 的托管归属匹配。

## 兼容协议

同一 `/v3/business-tasks/:taskId/observations` GET 路由使用显式媒体类型协商：新 AW 发送 `Accept: application/vnd.crewstation.execution-observations.v2+json`；新 CS 才返回 `schemaVersion: 2` / `executionObservationsV2`。未请求 v2 的现有客户端继续收到原样 v1；旧 CS 忽略新 Accept 时，新 AW 仍严格读取 v1，并将原生证明标为未支持或未观测。失败响应不自动当成旧版本，不用另一端点反复试探。

v2 的 usage、valuation 与 v1 完全相同。新增 `kind: capture`，有完整 execution identity、sourceId、recordId（capture ID）、revision（该摘要提交时的任务序号）、occurredAt=null、observedAt 与经过合同验证的 RuntimeNativeCapture 摘要。摘要只含现有计数、状态、缺口和 proof，不导出逐步历史基线。capture 不参与 Token 加法或估值匹配。

保留 v1 类型及输出，不将其 union 悄悄扩大。CS 新合同文件组合既有 usage / valuation 和 native summary，避免 contracts/nativeUsage 与 executionObservations 的运行时循环引用。AW 维护对应原始 JSON 夹具，逐值对拍；合同变更按仓库要求登记。

## 同一水位、分页与版本切换

- CS v2 增量将 usage_changes 与 native_capture_history 按同一任务 sequence 合并，统一限制每页 1–500 项；nextCursor 推进至最后一项，最后一页才推进 persistedThrough。不能分别取 500 后省略另一来源。
- v2 快照在固定 through 内分别取每个 meter / capture 的最后版本，以带 kind 的稳定键统一排序分页。旧快照不会读到后来修订；新增证明、修订撤销及只改证明的页均能被同步。v1 继续保持原有快照与游标语义；v2 快照和续页携带格式标识，混用返回明确错误。尽量沿用现有历史表与快照基础，不建第二套采集账本。
- AW 存储使用现有平台 records 的 kind 键和 JSON 文档；capture revision 只使用平台摘要序号。相同版本不同内容仍报冲突，旧版本不能覆盖新版本。
- 同步状态保存已协商版本（既有状态缺字段视为 v1）。v1→v2 或 v2→v1 必须从新快照开始；分页过程中响应版本变化，丢弃 staging 并重新建快照。新代次齐全前，旧数据保留但不得宣称新版本证明已完整；不可把 v1 游标直接续成 v2 导致遗漏历史 capture。
- 增量游标继续使用既有 usage-v1 前缀与任务 sequence，避免旧服务不能解析。只有已记录 expectedSchemaVersion=2 且携带 snapshotId 与 v2 snapshotCursor 的续页请求遇到400/422时，才按 snapshot-required 原子丢弃 staging；下一轮无游标重新请求快照，成功验证的 v1/v2 正文才决定协商版本。400/422 本身不算 v1，也不触发新快照首次请求的无限重启。404/409/410 沿用现有过期/失效恢复。
- 数值、证明、游标和版本状态仍在一个本地事务提交；平台离线不启用 AW 本地采集或本地人民币计价。快照过期、取消和响应丢失沿用现有恢复规则。

## 汇总与正式页面

AW 按已冻结安装/项目/任务/子任务/执行/代次匹配 capture，绝不按任务名称、原生根名或当前安装猜测归属。现有 canonical 数值仍直接替换；选取贡献与价格冻结语义不变。

只有匹配执行的实际完整证明、完整同步代次及未截断数据共同成立，才可把“完整空树”显示为已知 0 Token；没有 proof、pending、partial、unsupported、版本切换中、缺口和预算截断均保留未知或下限。任何非空 usage 必须进入原有选取与对账，空树证明不能覆盖冲突数值。人民币可见性、估值就绪与平台零消耗语义继续按既有规则；未定价数字不伪装为免费。

正式任务详情增加托管轮次摘要，沿用公共 Card / TableViewport / Dialog 与已有间距 token；每轮显示来源状态、观测时间、已接收步骤、待校正/已校正历史步骤和明确原因。旧本地 proof 结构继续使用，不把平台摘要伪装成本地原始证据；需要时新增独立的可选 DTO 字段。末行打开详情、Esc 回焦点、双语、390/1280px无整页横向溢出均保留。

## 必须验证

1. 新旧双方四种版本组合；默认 v1 字节形状不变，未知版本或错误正文不能被接受。
2. proof-only pending→complete、真正空树、数值迟到、原归属历史修订与撤销；不能双加 Token，也不能把未知变零。
3. usage/capture/valuation 混合超过一页、相同水位快照、续页期间修订、回滚、重复、同版冲突、响应丢失、过期与重启。
4. v1→v2 / v2→v1 和快照中途变版；专门验证 v2 首页面后旧 CS 返回422，丢弃 staging、无游标重启并接受已验证 v1 快照；已有 v1 cursor 必须重建历史证明，不丢数据或发布半代次。
5. 精确 execution identity、多个原生 turn、缺失原生 turn、未支持来源及预算上限。托管人民币继续由 CS 输出，AW 不访问本地价格表。
6. CS 真实 PG 回归和必要的一轮完整候选门禁；AW SQLite/PG 与界面回归全部交 hosted CI。独立功能实现门、精确路径发布、各自 exact-SHA CI 与 CS 本机部署分别留证。

这批不实现 RFC-370 生产启动根，不以协议/持久层通过冒称 AW 已在 CS 托管实机跑通；真实身份和资源验收仍使用已批准的具体范围。

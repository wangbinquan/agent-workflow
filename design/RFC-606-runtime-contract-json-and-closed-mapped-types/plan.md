# RFC-606 实施计划

依赖：RFC-604（指定的平台合同接口清单）、RFC-605。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-606-T1 平台 JSON 类型**：`S/platform/contracts/json.ts`，迁移转换改为转出（design §1）。
- **RFC-606-T2 检测规则**：指定清单加两项；映射类型的规则三（design §0、§1）。
- **RFC-606-T3 类型**：用量事件、探测回执视图、清扫失败原因与两处调用方（design §1）。
- **RFC-606-T4 账本、计数与门**：`PUBLIC_SURFACE_DEBT` 去掉 4 条，`public-surface-deviations` 16 → 12；新增 RFC-606 用例并登记；RFC 索引、`STATE.md`、RFC-294
  plan 的 S9 注记（design §2、§3）。
- **RFC-606-T5 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-606-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 四处类型如 design §1，`tsc` 通过，运行期行为不变
- [x] AC-2 检测器两条新判据各有正反用例
- [x] AC-3 `PUBLIC_SURFACE_DEBT` 去掉 4 条且逐条相等；计数降到 12
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

基于 `170f3e2cc`（RFC-605）；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：
  - 先改类型，按 `tsc` 列出的位置逐个调整：
    - 生产代码 1 处：探测回执的 `smoke` 段取值加 `?? null`。键已确认存在，JSON 里也没有 `undefined`，运行期不变。
    - 用例 3 个文件：替身的失败原因改为字符串；解析后的事件断言为 `JsonObject`；一处视图比较把实际值放宽为 `unknown`。
  - 之后 backend `tsc` 0 错；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**：在候选导出里，按改动路径与名字选出，再加上读 guard-manifest / 计数 / `STATE.md` / RFC 文档的用例与遍历 runtime-management、
  迁移与平台合同目录的扫描，共 658 个用例文件，只有 `rfc321` 红（要 git 历史，导出里照例红）。
- **变异**（候选导出里逐个施加、跑指定用例、复原；复原后导出无残留）：6 种都被认出。
  - 去掉规则三、规则三把 `string` 键当封闭、JSON 类型不再指定、探测回执视图改回 `unknown`、清扫失败原因改回 `unknown`：RFC-606 用例红，除第二种外
    preflight 也红。
  - 迁移转换重新定义自己的 `JsonValue`：RFC-606 用例红。
- **架构报告**（候选对照干净的 `170f3e2cc`）：
  - `public-surface-deviations` 16 → 12，正好少这 4 条。
  - 新增平台文件 `contracts/json.ts`；迁移规则对 `JsonValue` 的 import 改为解析到它（只记不门的 import 清单随之变化）。
  - 有门禁的计数除上述一项外都不变。

## CI（AC-4）

待推送。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **运行期不变**：只收紧类型。用量计照旧收解析后的 stdout 行，探测回执照旧只展示目标一致的 `smoke` 段，失败原因照旧是 opencode 给的字符串。
2. **规则不放过它不该放过的**：规则三只放行键集合封闭的映射类型；原始键、含原始键的联合、模板字面量、`PropertyKey` 照旧记债；值类型照旧检查。
3. **存量回执**：任何存量 JSON 都是 `JsonValue`，不需迁移；展示规则不变。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。

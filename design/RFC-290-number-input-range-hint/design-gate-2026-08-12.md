# RFC-290 设计门（2026-08-12）

## 结论

初版 **不通过**；4 条可复现 finding 已全部折入 `proposal.md` / `design.md` / `plan.md`，
修订后当前会话复核通过，可进入实现。用户本轮 `/goal …完整实现…提交上库` 已明确授权在设计
审视通过后直接实施，无需重复请求形式批准。

外部 `codex review --uncommitted` 已在 pin 到 `dacc8280b5237ac04f68578827fed7019978ce38`
的 detached worktree 中尝试；依赖安装及前端基线 `pagination.test.tsx` 5/5 通过，但 CLI 因会
把未提交 RFC 发往外部服务而被执行策略拒绝。未绕过该限制；以下由本次 Codex 会话逐项构造
失败输入并在隔离 worktree 做最小探针。

## Findings 与处置

### P1 — 换算算法与必测 oracle 互相矛盾

- 初版 `design.md §4.2` 写「从大到小取第一个能整除单位」，据此 `90000ms` 会跳过小时、
  分钟后命中秒，产出 `90 秒`。
- 同文 `§6.1` 又要求 `90000ms` 因为是 `1.5 分钟` 而退回纯数字；两者无法同时实现。
- 修订：按数值量级只选择第一个适用单位；该单位除不尽就返回 `null`，不继续降档。

### P1 — `aria-describedby` 会让包裹式 label 重复朗读范围

- 具体 DOM：`<label>Timeout <input aria-describedby="range"><span id="range">Range
1–10</span><span>Hint</span></label>`。
- Testing Library 的 AccName 探针实测 input 的 accessible name 为
  `Timeout Range 1–10 Hint`，description 又是 `Range 1–10`；范围进入名称后再作为说明，
  聚焦时会重复。
- 修订：可见 range span 加 `aria-hidden="true"`，显式 `aria-describedby` 仍读取它；同时
  合并而非覆盖调用方已有的 description id。探针验证修订形态的 name 不含 range、
  description 仍为 range。

### P1 — 边界防漂测试漏掉真实 PATCH 保存门

- `ConfigSchema.intentBuilderTurnTimeoutMs` 在 `config.ts:302` 定义一次，
  `ConfigPatchSchema.extend(...)` 又在 `config.ts:651` 重复定义 nullable 版本。
- 具体失败：base schema 与前端同时把 max 改到 7200000、patch schema 留在 3600000；初版
  只探 base schema 的测试全绿，但设置页保存 7200000 仍被 PATCH schema 拒绝。
- 修订：8 字段全部探 `ConfigSchema` 与 `ConfigPatchSchema`；源码同时锁 min/max。

### P2 — i18n / helper 契约不足以按文档直接落地

- 初版把 helper 写成 `formatUnitValue(n, unit)`，却要求它输出 i18next 复数文本，没有定义
  translator 从哪里来；直接 import 全局 i18n 会让所谓纯函数依赖进程状态。
- 初版称中文「只需 `_other`」，但本仓 `Resources` 要求 en/zh 键树 1:1，现有中文复数项也
  都同时提供 `_one/_other`；照写会 typecheck 失败或迫使新键变 optional。
- 修订：helper 显式注入 `TFunction`；中英文都提供两档键；转换 wrapper 改为通用
  `{{range}} + {{converted}}`，并分别使用英文半角、中文全角括号，覆盖 max-only 防御分支。

## 修订后门槛

- 实现必须保留上面四条的直接回归测试，不以快照替代。
- 完成代码后再跑实现门；若外部 CLI 仍因相同策略不可用，继续记录限制并采用同一套具体
  失败输入复核，不得把「未运行」写成 0 findings。

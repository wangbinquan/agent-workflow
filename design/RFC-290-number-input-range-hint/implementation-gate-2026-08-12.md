# RFC-290 实现门（2026-08-12）

## 结论

实现与修订后的设计一致。当前会话对生产路径、调用点、可访问性、边界双真值与真实浏览器
布局逐项复核后，发现 1 条 P2 测试覆盖缺口，已补齐；三组针对设计门关键 finding 的变异均能
稳定打红，恢复后定向测试全绿。

外部 `codex review` 未重试：设计门阶段同一命令已因会把未提交补丁发往外部服务而被执行策略
明确拒绝，本轮没有新增外发授权，故不绕过该限制，也不把外部实现门记作“0 findings”。以下
证据来自本次 Codex 会话在 detached worktree 中的对抗式复核。

## 隔离与归属

- 共享 `main` 在实现期间持续前进；对抗式实现门最初固定到
  `b922c29e0dddfe1071e69f7e14d12088e30ef018`。发布前又以最新远端
  `fddacadd05c7b4bc82d4b38fe56b2442a6cd8c3d` 重建最终 detached worktree，只叠加
  RFC-290 的 10 个实现/测试路径后执行标准完整门禁。
- 新文件在隔离 worktree 中用 `git add -N` 登记，确保 `git ls-files` 型源码守卫可见。
- 共享树全量前端测试曾只在并发 WIP `routes/intent.detail.tsx` /
  `tests/intent-detail-inline.test.tsx` 上失败；该 diff 是提交策略资源标签改造，不在 RFC-290
  路径内。最终判定只采隔离快照门禁，不把共享树瞬时红当作通过或产品缺陷。

## Finding 与处置

### P2 — 17 个有界调用点的验收只靠人工清单，缺少防退化锁

初版测试验证了 `NumberInput` 默认行为和 Pagination 单点 opt-out，但若以后第二个调用点也写
`rangeHint={false}`，组件测试仍会全绿，不能直接守住 proposal AC“17 处中 16 处显示”。

处置：`number-input-range.test.tsx` 递归扫描整个 frontend `src/**/*.tsx` 做源码 census，断言
17 个带 `max` 的调用点、16 个继承默认提示、唯一 opt-out 为 `components/Pagination.tsx`。新增有界
调用点时必须显式复核布局并更新计数，而不是因落在新文件中而逃出枚举面或静默扩大例外。

## 变异实证

| 破坏                                                                     | 预期与实测                                                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 换算 helper 改成“继续降档找能整除单位”                                   | `90000ms` 产出 `30 秒 – 90 秒`，对应测试 1/12 必红                |
| 删除 range span 的 `aria-hidden`                                         | accessible name 变成“超时 + 范围 + 用途说明”，a11y 测试 1/12 必红 |
| 只把 `ConfigPatchSchema.intentBuilderTurnTimeoutMs.max` 改成 `3_600_001` | base schema 仍绿，但 PATCH 上限断言 1/16 必红                     |

三处变异均用 `apply_patch` 原样恢复；恢复后对
`packages/shared/src/schemas/config.ts` 执行 `git diff --exit-code` 通过，RFC-290 定向套件
3 文件 34/34 通过。

## 额外验证

- 相关消费者回归：10 文件 129/129 通过（调度、runtime、workgroup、settings、网络、系统代理、
  commit/push、webhook pagination）。
- 前端 typecheck、lint 与 RFC-290 路径 prettier / `git diff --check` 通过。
- 真实浏览器在中文设置页逐项看到 8 个有界字段；单位换算分别为
  `0 – 256 KiB`、`30 秒 – 1 小时`、`1 天 – 10 年`。
- 390×844 视口下系统代理四个范围均未溢出，DOM 几何顺序为用途 hint → 范围；控制台无
  error / warning。

## 完整门禁

最终隔离快照执行 `bun run gate:local`，退出码 0，总耗时 7 分 44 秒：

- typecheck、ESLint、Prettier、依赖分层规则全部通过；依赖门核查 1368 个模块，40/40 条
  已接受存量违规均有纪律标记。
- shared：163 文件，1977/1977 通过。
- frontend：738 文件，6306/6306 通过。
- backend：4 个隔离分片合计 9588 pass、35 skip、0 fail；各分片分别为
  2181/2586/2502/2319 pass。

环境归因也已闭环：sandbox 内首次运行因本地 listener / 子进程权限出现 `EADDRINUSE` / `EPERM`；
改用正常本机权限后，曾与两套其他完整门禁并行，若干既有默认 5 秒用例被系统负载拖慢。
待其他后端分片全部退出后，用同一默认阈值复验唯一残留的
`rfc131-review-reject-aging-prior-output.test.ts`，从过载时 6.25 秒降为 2.33 秒并 1/1 通过；
随后上述最终完整门禁全绿。因此这些中间失败属于执行环境竞争，不是 RFC-290 产品回归。

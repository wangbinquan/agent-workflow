# RFC-236 · Codex 设计门记录（2026-07-30）

## 首轮结论

`NEEDS_REVISION`：P0=0，P1=1，P2=1。

## Findings 与折入结果

| 级别 | Finding | RFC 修订 |
| --- | --- | --- |
| P1 | 草案先写 `wrapper_progress_json.completionReason` 再做 wrapper terminal CAS；若用户取消、诊断修复或 orphan reconcile 抢先，row 最终是 canceled/interrupted，却会留下“max-iterations-continued”误导面包屑 | 删除 durable completion field 与 `wrapperProgress.ts` 改动；成功事实仍由 wrapper=`done` + outputs 表达。只有 `markWrapperTerminal(..., 'done')` 与 DB-first broadcast 成功后才写结构化 warning；superseded 路径在日志前退出 |
| P2 | durable breadcrumb 需要额外 schema、测试和恢复解释，但不向用户提供新的可操作能力，扩大了一个 Switch 的改动面 | 从 proposal/design/plan/预计文件清单移除 breadcrumb；不新增持久字段、event kind、errorMessage 或状态 |

## 第二轮复审

`APPROVED`：P0=0，P1=0，P2=0。

第二轮逐项核对：

- 缺失/false 保持现有 exhausted failure；只有 strict boolean true opt-in。
- `maxIterations=N` 仍只执行 N 轮；无 off-by-one 或第 N+1 轮。
- 继续路径与提前满足路径共用 output content/kind/archive、wrapper-private canonical merge、
  conflict/failure 与 done 收尾 helper。
- inner failed/canceled/awaiting 和 merge conflict/failure 均先于 policy 分支返回，开关不是
  continue-on-error。
- continue 写 done，generic scope/downstream 无需理解策略；`exhausted` 的全局 terminal-failure
  不变量保持。
- validator/runtime 共用 strict reader；畸形快照在 wrapper row/iso/inner side effect 前失败。
- frozen task snapshot、YAML/copy/clipboard/intent passthrough 和旧 schema 兼容边界已明确。
- UI 复用公共 Switch，DOM 顺序、atomic history、semantic validation target、中英文/a11y 与
  responsive 验证均有门禁。

RFC 已达到请求用户批准的设计门条件；用户批准前不改 `packages/**` 生产代码。

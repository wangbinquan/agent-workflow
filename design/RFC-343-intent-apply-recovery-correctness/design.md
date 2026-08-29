# RFC-343 技术设计 — Intent Apply 恢复正确性

## 1. Session lock

```text
previous = lockMap.get(sessionId) ?? resolved
chain = previous.catch(ignore).then(run)
lockMap.set(sessionId, chain)
finally:
  if lockMap.get(sessionId) === chain:
    lockMap.delete(sessionId)
```

cleanup 比较的是实际写进 map 的 `chain`，不是另一个由 `.finally()` 产生的 promise identity。这样旧请求不能删除已经排在其后的
tail，最后一个请求也不会永久留在 map。

## 2. Versioned journal artifact

```ts
type IntentJournalArtifactEnvelopeV1 = {
  version: 1
  artifacts: Array<
    | PluginStageArtifact
    | SkillCreateStageArtifact
    | {
        kind: 'skill-version-stage'
        staged: StagedSkillVersion
      }
  >
}
```

codec 位于 `services/intent/journalArtifacts.ts`，decode 先识别 V1，再只接受确定无损的 legacy 形态。完整
`StagedSkillVersion` 是 committed roll-forward 的输入；不能根据 mutable current skill row 猜 snapshot provenance。

## 3. Phase model

```text
prepare operation + durable artifact
  ├─ side effect 尚未 durable
  │    └─ compensate
  │         ├─ all success -> failed (terminal rollback receipt)
  │         └─ any failure -> prepared + error (retryable)
  └─ durable commit 已存在
       └─ roll forward missing publication only
            ├─ complete -> keep committed audit row + clear retryable error
            └─ decode/effect failure -> keep committed + retryable error
```

“业务 operation 失败”与“补偿是否完成”是两件事。只有 durable world 已回到可证明的 pre-apply 状态，journal 才能进入 terminal
failed。

## 4. Compensation oracle

converger 从 journal artifact 重建每项 operation 的补偿事实。进程内 map 只可作当前请求优化，不能决定 restart 后该删什么。
每项补偿独立捕获错误并累计；错误摘要写回 row，不能用 `finally` 无条件 terminalize。

## 5. Committed skill-version roll-forward

对完整 artifact：

1. 检查 artifact 对应的 exact operation 是否仍为 active `db-committed/fs-published`；
2. 只对尚未完成的 operation 执行 publish，`done` 的旧 audit artifact 直接跳过；
3. 使用 artifact 自带 version/hash/path，而非“当前最新 audit row”；
4. 成功后由 skill operation 进入 `done`，并清空 journal 上的 retryable error；journal 本身继续保留 `committed` 审计态；
5. 第二次 convergence 观察 exact operation 已 `done`，不再 unmark 或发布旧版本。

## 6. Corruption behavior

- invalid JSON、unknown envelope version、缺必需字段：decode error，row 保持 retryable；
- legacy empty/plugin/skill-create arrays：无损 decode；旧 plugin 若没有 generation path，显式解码为
  `legacy-plugin-install-untracked` 并保持既有 installer-GC 归宿，不伪造精确路径；
- legacy skill-version-stage 只有部分字段：拒绝，不能伪造缺失 provenance；
- corruption 不能被计为 converged，也不能触发基于猜测的 compensation/publish。

## 7. File map

- lock/recovery orchestration：`packages/backend/src/services/intent/applyChangeset.ts`
- artifact codec：`packages/backend/src/services/intent/journalArtifacts.ts`
- existing contract updates：`rfc234-apply-changeset.test.ts`、`rfc271-intent-skill-plugin-update.test.ts`
- focused mutation corpus：`rfc343-intent-apply-correctness.test.ts`

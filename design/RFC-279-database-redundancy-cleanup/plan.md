# RFC-279 · 实施计划

状态：In Progress；用户已批准 proposal §4，0146 已落库，实现与完整本地门禁已通过，等待发布 CI。

## T1 · RFC 与基线

- [x] 固定 P1 + P2 七列边界与非目标。
- [x] 核对 live 值域、生产调用点、当前 physical DDL、direct-upgrade 顺序。
- [x] 用户逐项确认能力影响清单。
- [x] 0146 提交后重读 HEAD/journal/status，确定下一 migration 号与 `when`。

## T2 · Migration + schema

- [x] 新 forward migration：四组 guard、legacy URL escrow、五个 DROP COLUMN、`skill_operations` rebuild + index restore。
- [x] `_journal.json` 连续追加；`upgrade-rolling` count N→N+1。
- [x] `schema.ts` 删除七列，保留并发 `repositoryUrlPrefixesJson` 变更。
- [x] migration happy/polarity/crash-resume tests。

## T3 · Skill / operation 代码收口

- [x] skill INSERT/query/filter 改 managed literal 派生。
- [x] `BeginOperationSpec` 与 identity recovery 删除 second-id 分支，保留单 ID lock。
- [x] 更新 skill/version/boot/operation/recovery 测试与源码守卫。

## T4 · Task questions 收口

- [x] 删除 dormant reopen DB 读取，wire 暂派生 `reopenCount:0`。
- [x] manual queue/prompt 统一读取 `questionTitle`，删除 `manualTitle` 写入。
- [x] 更新 service/dispatch/prompt/迁移回归测试。

## T5 · Cached repo 密封收口

- [x] boot sealing gate前移并支持 closed escrow prefix。
- [x] 新写只落 `url_enc/url_redacted`；删除 plaintext fallback。
- [x] list/repo-group/diagnostics/push/webhook/file re-key 改新契约。
- [x] 更新 RFC-204/205/257/248 与 cache service 测试。

## T6 · 验证与交付

- [x] 定向 migration + service suites。
- [x] backend typecheck、lint、format、depcheck、backend 全量。
- [x] `bun run gate:local`（7m14s；四个 backend 分片、shared 1972、frontend 6259，零失败）。
- [x] 精确 diff/path 复核，不覆盖并发 WIP；实现门复审无新增 finding。
- [ ] 用户已授权；等待 exact-path commit/push，并按 exact/containing SHA 报 CI。

## 拆分建议

该 RFC 的 schema 与 readers/writers 必须在一个可启动 commit 中闭合。允许测试先行小步，但最终 migration、schema、生产代码、journal count 不拆成可被共享 main 单独观察的中间提交。

# Purpose Windows 平台选项匹配修正

提交 `3afffac07455e86118390432359676707f2063c8` 的 Windows run `37550317792` 已 completed/failure，唯一失败用例为 RFC-254 平台执行检查的第一项。完整功能日志保存在 `/tmp/aw-rfc370-purpose-adapter-exchange-ci-functional-job-112563953348-r1.log`。原失败保留，不将 maintenance-soak 成功或后继提交当作此 SHA 已通过。

原 native `Bun.spawn` 仍调用 `platformSpawnOptionsForHost()`。Purpose 抽取后 cwd 表达式变长，使该调用落在既有检查的 140 字符窗口之外。本次仅将完整平台选项 spread 移到同一 spawn 对象开头；cmd/cwd/env/stdin/stdout/stderr/detached 的字段和值、子进程结束/超时/观察策略均保持。平台 helper 只生成 windowsHide，没有覆盖上述业务字段；移动该纯调用不引入异步效果。

现有失败用例就是此修正的回归 oracle。其完整源码、所有原规则/匹配窗口/断言/用例名/预算/allowance 均保持，不新增豁免、不放宽判据。本机仅做自有格式/lint、纯 AST/字节证明及该最终候选一次原 scoped 库存生成，不运行 AW tests/typecheck/build/service。修正发布后的确切 SHA hosted CI 另验。

旧提交 `865fc0458301a4532fb21f685f323eb9130ee069` 的主 CI `37545000878` 已 completed/failure，两项 backend 分片失败的唯一真实 failed case 是并行 RFC-371 等待预算（原 wait=5000、budget=5000）。该内容已由提交 `fca334493d1a664c794588404a21829ba8cc7b02` 正常向前修正，当前修正不改该并行源码或其历史；其后继精确 CI 独立记载。

本批只修已发布的 Purpose 平台检查，不关闭 H7、A-T7、A-G 或 RFC；执行权核心和实际入口接线继续，尚无 AW-in-CS 部署。

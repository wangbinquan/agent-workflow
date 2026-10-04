# 已提交 workspace／publication 的 CI 预期补正

2026-10-05，基准 `08553860e79b0ef8d19d88e7377fee9c02d4780e`。本批仅修两个测试预期与进度记录，没有生产变更或 canonical 重采，不关闭 A-G、CS adapter 或 M0～M4。

`6521ab0ffc20df0f5dbbb08ca92ebab451d614ac` 的 [CI 37220500802](https://github.com/wangbinquan/agent-workflow/actions/runs/37220500802) 已终态 cancelled：39 个作业成功、8 个失败、3 个取消；同 SHA [Windows 37220626642](https://github.com/wangbinquan/agent-workflow/actions/runs/37220626642) success。这不是整仓全绿。五个失败 backend shard 只涉及三种预期错误：logical effect receipt 的平铺形状、旧 EvidenceStore native 根源码锁、等待 candidate ACK 期间缺省状态不适用对象 matcher。前一种已在 `08553860` 修复；本批只修后两种。

- `rfc370-evidence-artifact-root-bindings.test.ts` 的一条完整字符串随已提交 CI-SOURCE6-R2 改为 `join(deps.appHome, 'evidence')`。native evidence root 独立于 opaque workspace factory；其余真实根接线、selected reader/writer、await 次数和全部检查保持。
- `rfc310-pr4-journey.test.ts` 的等待分支改用否定的 `toEqual(expect.objectContaining(...))`，完整保持“ACK 前不能发布 known/derived”判据，同时允许此时尚未创建 cell。原 `not.toMatchObject` 在 undefined 上抛 matcher 错误，未能执行判据。ACK 后仍核对 validated、derived、实际 treeOid、一次创建/关闭及零 legacy 读取；真实双 provider、Git 和所有预算保持。

另外两个失败 E2E shard 是 RFC-371 页面标题 `Usage by actual model` 与已提交 UI 的 `Actual model` 不一致。核对期间该 E2E 已出现并行修复，完整保留并排除本批；没有改该文件或其 UI，也没有发送跨 session 消息。聚合门仅汇总这些失败。原失败/取消记录保留；新 SHA 必须再取得正式 hosted CI 终态。

两个测试分别反向替换后整份原文逐字等价。目标格式/lint 和纯字节检查独立记录；没有本机 AW test/typecheck/build/service。执行/材料实施设计仍在独立设计门，尚无源实现或 CS 部署，其他完整 RFC 工作继续。

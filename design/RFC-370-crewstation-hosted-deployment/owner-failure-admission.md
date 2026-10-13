# RFC-370 owner 致命失败与原 grant 准入候选

2026-10-13；阶段 A 续推，生产和测试仅写入，尚未功能验证。

## 实际问题

原 polling/managed owner 的 run 或错误处理 ACK 拒绝后，其调度 promise 已终止，但 SO 执行权仍可能为 active、状态仍列出可用能力。MCP 原结算未确认时也可能关闭自身派发而没有同步根状态。继续接受新执行请求会使 UI 与实际 owner 状态不一致。

## 原 grant 的失败通道

grant context 新增失败反馈，由同一 SO controller 创建并捕获原 grant。当前 active owner 的致命失败立即沿原 authority-loss 通道使准入失效、readyGroups 清空、状态进入 draining；原 runtime/recovery/write 排空与退役仍由原对象负责。失败反馈不代签任何物理回收、结果或清理 ACK，也不关闭未完成的写入行。

反馈检查原 current/version。旧 grant 的迟到 callback 不影响新 grant；已进入普通 pause 的反馈不更改原 pause/取消政策。provider/普通 standalone 路径保留。polling owner、managed owner 和 MCP 原结算已转交该通道，callback/receiver 在原启动前捕获；Task lifetime 合同与根接线同步该字段。Memory 的致命原错误不会被日志 callback 抛错替换。

## 已编写、未执行的用例

- 双 provider 原 SO 写入行、原 polling handle 和实际 HTTP admission：fatal owner 立即拒绝新请求，未确认原工作不能关闭写入行。
- 普通 pause 后新 epoch 已 active：旧 context 的 failure report 不修改新实际行或准入。
- 原 pause 正在排空：迟到 report 不切换停止政策，不提前 ACK。
- MCP 原结算报告失败，仍重试原 callback；旧 frame 不反馈到新 frame。
- 原 managed worker 的 fatal promise 转交捕获的 reporter/receiver，原失败继续阻止 drain，不消费后续替换 callback。

这些控制合同不能代签完整三根、十九 owner 或 CS 现场流程。原状态 UI 读取的是同一 controller，当前没有执行浏览器/功能验收。

## 剩余验收范围

继续完成阶段 A 的未发领取恢复、未知物理执行恢复与恢复后继续运行、全调用者清单、整体装配用例和架构配套，再集中进入 A-G。所有 CS production adapters 仍待 AC00；之后先 M0 实际部署与登录/编辑/保存/重建回读，再 M1～M4。RFC 和 CS 部署均未完成。

十一份 TS 仅格式/语法/diff 静态自查，累计 136 份 TS/TSX 语法零错误不等于类型、功能、CI 或部署通过。本会话未执行本机 AW 测试/typecheck/build/服务/E2E/实现门，未发布生产候选，无跨 session 信息；共享主干和并发产出保留。

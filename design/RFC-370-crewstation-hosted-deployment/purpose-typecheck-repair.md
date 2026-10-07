# Purpose 类型检查修正

Windows run `37555994724`（确切 SHA `c3857ea5678fd6474ca3b61d6ca4ff473c2be840`）在 Typecheck 失败，尚未执行功能用例。完整作业日志保留为 `/tmp/aw-rfc370-h7-host-authority-core-ci-purpose-windows-job-112582243341-full.log`，不将先前平台选项修正视作已经通过 Windows 验收。

流水线 work item 在 Purpose 抽取后残留旧 `store` 名称。修正恢复既有惰性 native 内容接收者，并在存在所选 `evidenceArtifacts` 时直接调用该完整接收者的 `materializeBundle`，等待其 ACK；不在装配期间创建 native 文件存储。新增双 provider 实际 work-item 回归，覆盖所选 opaque bundle、方法接收者、物化 ACK、随后 staging close，以及未生成本机 evidence 目录。既有 RFC-323 原文件、所有用例、断言和预算保持不变。

三个 Purpose 测试类型错误分别通过保留原完整深相等断言的类型投影、给九个 legacy 调用提供共同的 `operation: never` 输入函数类型，以及显式确认异步 submit 已写入测试 receipt 修正。九个实际调用、错误身份、原结果内容、所有原断言与等待预算保留；没有放宽 envelope 或生产 API 类型。

前端 RFC-371 类型错误位于另一会话正在修改的文件，本批不提交该在制品。Task 配置接线、执行权入口接线、H7、A-T7、A-G 和 CS 首次部署仍在进行。本机只做自有格式/lint 与源码证明，执行验证以发布后的确切 SHA hosted CI 为准。

首轮独立回执原签 PASS，但新 fixture 直接返回 `EvidenceBundleRecord.entries` 的只读数组，不能赋给 `materializeBundle` 的原可变数组返回合同。根代理发现该遗漏后，复核方独占追加有效稳定 FAIL 更正回执，原 PASS 原件完整保留且不可用于发布；20 个正式原件及额外 1 个类型合同均完成首末 EOF 对拍。R2 仅将新 fixture 的返回值改为数组副本，并将原完整类型合同纳入控制原件；既有生产 API 和所有原测试 oracle 保持。

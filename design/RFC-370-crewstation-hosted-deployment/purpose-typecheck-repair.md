# Purpose 类型检查修正

Windows run `37555994724`（确切 SHA `c3857ea5678fd6474ca3b61d6ca4ff473c2be840`）平台功能测试已成功，随后 Typecheck 失败；后续构建和 doctor 步骤未执行。完整作业日志保留为 `/tmp/aw-rfc370-h7-host-authority-core-ci-purpose-windows-job-112582243341-full.log`，不将先前平台选项修正视作已经通过 Windows 验收。

流水线 work item 在 Purpose 抽取后残留旧 `store` 名称。修正恢复既有惰性 native 内容接收者，并在存在所选 `evidenceArtifacts` 时直接调用该完整接收者的 `materializeBundle`，等待其 ACK；不在装配期间创建 native 文件存储。新增双 provider 实际 work-item 回归，覆盖所选 opaque bundle、方法接收者、物化 ACK、随后 staging close，以及未生成本机 evidence 目录。既有 RFC-323 原文件、所有用例、断言和预算保持不变。

三个 Purpose 测试类型错误分别通过保留原完整深相等断言的类型投影、给九个 legacy 调用提供共同的 `operation: never` 输入函数类型，以及显式确认异步 submit 已写入测试 receipt 修正。九个实际调用、错误身份、原结果内容、所有原断言与等待预算保留；没有放宽 envelope 或生产 API 类型。

前端 RFC-371 类型错误位于另一会话正在修改的文件，本批不提交该在制品。Task 配置接线、执行权入口接线、H7、A-T7、A-G 和 CS 首次部署仍在进行。本机只做自有格式/lint 与源码证明，执行验证以发布后的确切 SHA hosted CI 为准。

首轮独立回执原签 PASS，但新 fixture 直接返回 `EvidenceBundleRecord.entries` 的只读数组，不能赋给 `materializeBundle` 的原可变数组返回合同。根代理发现该遗漏后，复核方独占追加有效稳定 FAIL 更正回执，原 PASS 原件完整保留且不可用于发布；20 个正式原件及额外 1 个类型合同均完成首末 EOF 对拍。R2 仅将新 fixture 的返回值改为数组副本，并将原完整类型合同纳入控制原件；既有生产 API 和所有原测试 oracle 保持。

### 旧 Windows 作业步骤记录更正

原 job112582243341 的步骤5（RFC-363恢复）、6（RFC-254平台）及原共享测试已success；步骤15 Typecheck failure，之后的build/doctor未执行。此前将整作业功能测试记为“尚未执行”不准确，本次只更正这句记录；完整原候选、误记、所有复核和正式failure证据保留。新增Purpose回归不在旧Windows原命令中，不能据旧平台步骤success宣称它已在Windows执行。

生产/测试修正与13匹配输出已通过有限SOURCE5-R2/MATCHING16-R2并精确21路径上库e4bd62318e12848d730b1c52f2dd29706e9da5e1；main/origin当时0/0、index空、全部Task/RFC371并行WIP保持。该SHA主CI37561996355与确切同SHA Windows37562206818已启动，终态待验；后者仅沿原平台列表运行，不包含新增Purpose测试。本文更正无生产/测试/架构规则/匹配变化，无新census或本机AW运行，不重签旧历史门，Stage A/H7/A-G及CS部署仍开放。

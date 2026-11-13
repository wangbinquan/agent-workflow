# RFC-494 开发自动化的员工类型包合同与编解码归 domain（RFC-294 S10 第一步）

- **状态**：In Progress（2026-11-13）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口；
  development-automation 一块规模最大、可单独立 RFC 先做）与 proposal D16、review-2026-11-09 R11 / F13；10-16 review F1 已点名
  `employeeTypePackage.ts`。
- **前序**：无硬前置。S10 与 S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 不碰 `taskImage*` / `crewstation*`。

## 1. 背景

development-automation 的 `composition/` 有 32 个文件、1.53 万行，是全仓 composition 最重的一处（`composition-control-flow-development-automation`
实测 660）。其中最大的 `employeeTypePackage.ts`（5,478 行）几乎全是开发员工类型包的合同：工具合同表与输入输出字段、执行合同登记、
包语义（描述符、工作范围解析与摘要、合同样例校验）、各上下文的 schema 与两个运行时编解码器。它不做 IO，也不装配任何东西，只有末尾
一段 `developmentEmployeeTypePackage` 把包语义包成 digital-employee 的 `EmployeeTypePackageRegistration`（JSON 进出），由 bootstrap 交给
digital-employee。

它依赖的三个文件同样是纯的：`composition/digitalEmployeeToolContractsV2.ts`（V2 工具合同的执行合同登记）、
`composition/legacyDevelopmentProgramUpgrade.ts`（把已退役的 v1 合同程序升级成兼容包装的源码文本）与
`application/digitalEmployeeToolContractProjectionV2.ts`（工具结果的投影与校验）。

## 2. 目标

- **G1 合同与编解码归 development-automation 的 domain**：`employeeTypePackage.ts` 除登记对象以外的全部内容原样迁入
  `domain/employeeTypePackage.ts`；它依赖的三个纯文件一起迁入 domain（工具合同登记改名
  `domain/digitalEmployeeToolContractRegistrationsV2.ts`，与已有的 `domain/digitalEmployeeToolContractsV2.ts` 区分）。
- **G2 composition 只留装配**：`composition/employeeTypePackage.ts` 只留 `developmentEmployeeTypePackage` 这个登记对象，从 domain 取包语义。
- **G3 原位置不留转出**：生产代码、用例与 e2e 改从新位置取迁出的名字；登记对象的使用方不变。
- **G4 账本与锁**：`composition-control-flow-development-automation` 按实测收紧；新增 RFC-494 用例。

## 3. 非目标

- development-automation `composition/` 的其余文件（工作项用例、工作区策略、mission / config 操作、交付桥等，S10 后继步骤）；其他模块的
  composition；S10 的全模块门。
- 拆分或改写迁出的合同与编解码；任何行为变化、接口、错误码与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在新的 domain 文件声明；`composition/employeeTypePackage.ts` 只交出登记对象，三个旧文件不再存在；生产
  代码、用例与 e2e 都不从旧位置取迁出的名字。
- **AC-2**：同样输入下包描述符、工作范围解析与摘要、合同样例校验、执行合同登记、上下文 schema、两个运行时编解码器与旧程序升级的结果
  与此前一致（迁移逐字，现有用例对拍）。
- **AC-3**：新的 domain 文件不取任何 infrastructure、application、composition、IO 包与进程全局；跨 context 边、public surface 不升；
  `composition-control-flow-development-automation` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

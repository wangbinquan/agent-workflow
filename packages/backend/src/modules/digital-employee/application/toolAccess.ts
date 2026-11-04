// RFC-330 D9 —— 平台目录工具没有 owner 行：投影为 builtin / public，可见但任何写都 403。
//
// RFC-436：判据原借 `services/systemResources.assertNotBuiltin('employee_tool', row)`。平台目录工具是
// digital-employee 自有的概念，判据随 HTTP 绑定归入本 context；错误码 `builtin-readonly` 是共享词汇
// （resource-catalog 对内置工作流也各自给出），文案与原输出逐字相同。

import { ForbiddenError } from '@/util/errors'

/** Platform-catalog tools have no owner row; every write is refused with the shared read-only code. */
export function assertEmployeeToolWritable(row: { readonly builtin: boolean }): void {
  if (row.builtin) {
    throw new ForbiddenError(
      'builtin-readonly',
      'this employee_tool is a built-in framework resource and is read-only',
    )
  }
}

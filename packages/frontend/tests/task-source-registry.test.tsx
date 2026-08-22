import { TASK_SOURCE_REGISTRATIONS } from '@agent-workflow/shared'
import { cleanup, render, screen } from '@testing-library/react'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import { TaskCreationResourcePicker } from '@/components/task-creation/TaskCreationResourcePicker'
import { TaskCreationContractFields } from '@/components/task-creation/TaskCreationContractFields'

const read = (relative: string) =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', relative), 'utf8')

describe('unified task-source frontend registry', () => {
  test('the shared contract renderer owns descriptions and read-only injected selects', () => {
    const onChange = vi.fn()
    render(
      <TaskCreationContractFields
        fields={[
          {
            fieldRef: 'repositoryId',
            label: 'Repository',
            description: 'The repository used by this task',
            inputKind: 'repository-picker',
            required: true,
            value: 'repo-fixed',
            onChange,
            options: [{ value: 'repo-fixed', label: 'team/service' }],
            disabled: true,
            testId: 'fixed-repository',
          },
        ]}
      />,
    )

    expect(screen.getByText('The repository used by this task')).toBeTruthy()
    const repository = screen.getByRole('combobox', { name: 'Repository' })
    expect((repository as HTMLButtonElement).disabled).toBe(true)
    expect(repository.textContent).toContain('team/service')
    expect(onChange).not.toHaveBeenCalled()
    cleanup()
  })

  test('the shared resource picker keeps async inventories unselected', () => {
    const onChange = vi.fn()
    const view = render(
      <TaskCreationResourcePicker
        label="Execution object"
        value=""
        onChange={onChange}
        options={[]}
        loading={false}
        error={null}
        onRetry={() => undefined}
        placeholder="Select…"
        emptyText="Nothing available"
        testId="resource-picker"
      />,
    )

    view.rerender(
      <TaskCreationResourcePicker
        label="Execution object"
        value=""
        onChange={onChange}
        options={[{ value: 'first', label: 'First object' }]}
        loading={false}
        error={null}
        onRetry={() => undefined}
        placeholder="Select…"
        emptyText="Nothing available"
        testId="resource-picker"
      />,
    )

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: 'Execution object' }).textContent).toContain(
      'Select…',
    )
    cleanup()
  })

  test('creation registrations contain only the declarative source contract', () => {
    for (const source of TASK_SOURCE_REGISTRATIONS) {
      expect(source.creation.steps).toEqual(['mode', 'space', 'content', 'confirm'])
      expect(source.creation.parameterContract.schemaId).not.toBe('')
      expect(Object.keys(source.creation).sort()).toEqual([
        'inventoryPath',
        'parameterContract',
        'requiredPermission',
        'resourceSearchKey',
        'steps',
        'supportsRelaunch',
        'supportsSchedule',
      ])
    }
  })

  test('list registrations contain only source permission and detail routing', () => {
    for (const source of TASK_SOURCE_REGISTRATIONS) {
      expect(Object.keys(source.list).sort()).toEqual(['detailPath', 'requiredPermission'])
      expect(source.list.detailPath).toMatch(/^\/tasks\//)
    }
  })

  test('shared UI boundaries contain no concrete task-source decisions or private page renderers', () => {
    const host = read('components/task-creation/TaskCreationWizardHost.tsx')
    const shell = read('components/task-creation/TaskCreationWizardShell.tsx')
    const picker = read('components/task-creation/TaskCreationKindPicker.tsx')
    const resourcePicker = read('components/task-creation/TaskCreationResourcePicker.tsx')
    const contractFields = read('components/task-creation/TaskCreationContractFields.tsx')
    const taskRoute = read('routes/tasks.tsx')
    const creationRoute = read('routes/tasks.new.tsx')
    const router = read('router.tsx')
    const subjectDescriptorContract = read(
      'components/task-creation/TaskCreationSubjectDescriptorContract.tsx',
    )
    const repositorySpace = read('components/task-creation/TaskCreationRepositorySpace.tsx')
    const taskPage = taskRoute.slice(
      taskRoute.indexOf('function TasksPage()'),
      taskRoute.indexOf('function RegisteredTasksSurface'),
    )
    const creationEntry = creationRoute.slice(
      creationRoute.indexOf('function TaskCreationEntryPage()'),
      creationRoute.indexOf('const STEP_MODE'),
    )

    expect(taskPage).toContain('TASK_SOURCE_REGISTRATIONS')
    expect(
      existsSync(
        resolve(import.meta.dirname, '..', 'src', 'components', 'tasks', 'TaskSourceRegistry.tsx'),
      ),
    ).toBe(false)

    expect(subjectDescriptorContract).toContain('<TaskCreationContractFrame')
    expect(subjectDescriptorContract).not.toContain("from '@/components/Stepper'")
    expect(subjectDescriptorContract).not.toContain('TaskCreationKindPicker')
    expect(subjectDescriptorContract).not.toContain('TaskCreationWizardShell')
    expect(subjectDescriptorContract).not.toContain('employee-case-create-grid')
    expect(creationRoute).toContain('<TaskCreationResourcePicker')
    expect(subjectDescriptorContract).toContain('<TaskCreationResourcePicker')
    expect(subjectDescriptorContract).toContain('<TaskCreationContractFields')
    expect(subjectDescriptorContract).toContain('<TaskCreationRepositorySpace')
    expect(repositorySpace).toContain('<RepoSourceList')
    expect(subjectDescriptorContract).not.toContain('<Select')
    expect(subjectDescriptorContract).not.toContain('availableEmployees[0]')
    expect(router).not.toContain('employee-cases.new')
    expect(
      existsSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'employee-cases.new.tsx')),
    ).toBe(false)

    const concreteValues = new Set(TASK_SOURCE_REGISTRATIONS.map((source) => source.id))
    for (const commonSource of [host, shell, picker, resourcePicker, contractFields]) {
      expect(commonSource).not.toMatch(/from ['"]@\/routes\//)
      for (const value of concreteValues) {
        expect(commonSource).not.toContain(`'${value}'`)
        expect(commonSource).not.toContain(`"${value}"`)
        expect(commonSource).not.toContain(`\`${value}\``)
      }
    }
    const styles = read('styles.css')
    expect(styles).not.toContain('employee-case-create-page')
    expect(styles).not.toContain('employee-case-create-grid')
    expect(styles).toMatch(/\.task-creation-kind-picker\s*{[^}]*repeat\(4,/s)
    expect(styles).toMatch(/\.task-wizard\s*{[^}]*max-width:\s*68rem/s)
    for (const source of TASK_SOURCE_REGISTRATIONS) {
      expect(taskPage).not.toContain(`=== '${source.id}'`)
      expect(creationEntry).not.toContain(`=== '${source.id}'`)
    }
  })

  test('one state machine and one host mount own every task-creation source', () => {
    const taskCreationDirectory = resolve(
      import.meta.dirname,
      '..',
      'src',
      'components',
      'task-creation',
    )
    const productionFiles = [
      resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.new.tsx'),
      ...readdirSync(taskCreationDirectory)
        .filter((name) => name.endsWith('.tsx'))
        .map((name) => resolve(taskCreationDirectory, name)),
    ]
    const sources = productionFiles.map((file) => ({ file, code: readFileSync(file, 'utf8') }))
    const hostMounts = sources.filter(({ code }) => code.includes('<TaskCreationWizardHost'))
    expect(hostMounts.map(({ file }) => basename(file))).toEqual(['TaskCreationContractFrame.tsx'])

    const stepOwners = sources.filter(({ code }) => code.includes('const [step, setStep]'))
    const frontierOwners = sources.filter(({ code }) =>
      code.includes('const [maxVisited, setMaxVisited]'),
    )
    expect(stepOwners.map(({ file }) => basename(file))).toEqual(['tasks.new.tsx'])
    expect(frontierOwners.map(({ file }) => basename(file))).toEqual(['tasks.new.tsx'])

    const sourceSpecificController =
      /(agent|workflow|workgroup|digitalemployee|employee).*taskcreation(flow|provider)/i
    expect(productionFiles.map((file) => basename(file))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(sourceSpecificController)]),
    )
  })
})

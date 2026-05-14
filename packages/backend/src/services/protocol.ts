// Build the `user prompt` sent to opencode for one node invocation.
//
// Composition (per design.md §7.2 + design/proposal.md §4.3):
//
//   1. Node-level prompt template with substitutions applied:
//        {{port_name}}       → resolved upstream port content
//        {{__repo_path__}}   → task.repo_path
//        {{__base_branch__}} → task.base_branch
//        {{__task_id__}}     → task.id
//
//   2. Sections for input ports the template did NOT reference, appended as
//        ## <portName>
//        <content>
//      so prompt-templating mistakes still surface the data.
//
//   3. English protocol block at the very end, instructing the agent to close
//      its reply with a <workflow-output> envelope listing the declared ports.

export interface RenderPromptInput {
  /** Node-level prompt template. May be undefined or empty. */
  promptTemplate?: string
  /** Resolved input ports — { portName -> concatenated content }. */
  inputs: Record<string, string>
  /** Built-in template variables. */
  meta: {
    repoPath: string
    baseBranch: string
    taskId: string
  }
  /** Declared outputs for the protocol block instructions. */
  agentOutputs: string[]
}

const TEMPLATE_RE = /\{\{(\w+)\}\}/g

const BUILTIN_VARS = new Set(['__repo_path__', '__base_branch__', '__task_id__'])

export function renderUserPrompt(input: RenderPromptInput): string {
  const tpl = input.promptTemplate ?? ''
  const referenced = new Set<string>()

  const body = tpl.replace(TEMPLATE_RE, (_match, name: string) => {
    referenced.add(name)
    if (BUILTIN_VARS.has(name)) {
      switch (name) {
        case '__repo_path__':
          return input.meta.repoPath
        case '__base_branch__':
          return input.meta.baseBranch
        case '__task_id__':
          return input.meta.taskId
      }
    }
    const v = input.inputs[name]
    return v ?? ''
  })

  // Sections for unreferenced input ports. Iteration order = Object.entries
  // preserves insertion order, which the caller (scheduler) controls.
  let sections = ''
  for (const [name, content] of Object.entries(input.inputs)) {
    if (referenced.has(name)) continue
    sections += `\n\n## ${name}\n${content}`
  }

  return body + sections + buildProtocolBlock(input.agentOutputs)
}

/**
 * The English protocol block. Always appended to user prompt, never to the
 * agent's system prompt (agent.md body is passed through verbatim).
 */
export function buildProtocolBlock(agentOutputs: string[]): string {
  let s = '\n\n---\nYou MUST end your reply with a `<workflow-output>` block listing these ports:\n'
  for (const port of agentOutputs) {
    s += `  - ${port}\n`
  }
  s += '\nFormat:\n<workflow-output>\n'
  for (const port of agentOutputs) {
    s += `  <port name="${port}">...</port>\n`
  }
  s += '</workflow-output>'
  return s
}

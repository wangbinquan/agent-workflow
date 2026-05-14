// P-5-03 stage 1: en-US placeholder bundle.
// Mirrors zh-CN keys so a future en-US release just edits strings, not keys.

import type { Resources } from './zh-CN'

export const enUS: Resources = {
  nav: {
    agents: 'Agents',
    skills: 'Skills',
    workflows: 'Workflows',
    tasks: 'Tasks',
    settings: 'Settings',
    brand: 'Agent Workflow',
  },
  auth: {
    title: 'Connect to daemon',
    hint: 'Run ',
    hintCmd: 'agent-workflow start',
    hintAfter: '; copy the token it prints on stdout and paste below.',
    daemonUrl: 'Daemon URL',
    token: 'Token',
    tokenPlaceholder: '64-char hex',
    verifying: 'Verifying…',
    connect: 'Connect',
  },
  settings: {
    title: 'Settings',
    hintBacked: 'Backed by ',
    hintPatched: '. Patches via ',
    hintRestart: '. Fields marked restart only apply on the next daemon start.',
    tabRuntime: 'Runtime',
    tabLimits: 'Limits',
    tabGc: 'GC',
    tabNetwork: 'Network',
    tabConnection: 'Connection',
    tabAppearance: 'Appearance',
    loading: 'Loading…',
    saving: 'Saving…',
    saved: 'Saved',
    save: 'Save',
    backupTitle: 'Export backup',
    backupHint:
      'Bundles db.sqlite + config.json + skills/ + workflows YAML into a tarball under ~/.agent-workflow/backups/. Excludes worktrees, runs, logs, token.',
    backupCreate: 'Create backup',
    backupRunning: 'Creating backup…',
    backupSavedAs: 'Saved ',
    themeLabel: 'Theme',
    themeHint: 'System: follow the OS light/dark preference.',
    themeSystem: 'Follow system',
    themeLight: 'Light',
    themeDark: 'Dark',
    restartRequiredTitle: 'Daemon restart required',
    restartRequiredHint:
      'The new value was written to config.json, but bind host / bind port only apply on the next agent-workflow start. Run `agent-workflow stop` and then `agent-workflow start` in your terminal.',
  },
  errors: {
    'http-401': 'Unauthorized — please sign in again.',
    'http-404': 'Not found.',
    'http-409': 'Conflict — refresh and retry.',
    'route-not-found': 'Route not found.',
    'task-not-cancelable': 'Task is already finished and cannot be canceled.',
    'task-not-resumable': 'Task is still running or has not failed; cannot resume.',
    'task-still-running': 'Task is still running; cancel it first.',
    'workflow-import-conflict': 'Import conflict: a workflow with the same id already exists.',
    'config-invalid': 'Invalid config.',
    'task-invalid': 'Invalid task payload.',
    fallback: 'Request failed',
  },
}

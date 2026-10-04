// RFC-370: retain both import compatibility and the existing direct CLI entry.
import { runManagedProcessLauncher } from '@/platform/execution/local/managedProcessLauncher'

export {
  MANAGED_PROCESS_LAUNCHER_SUBCOMMAND,
  MANAGED_PROCESS_LAUNCH_NONCE_FLAG,
  MANAGED_PROCESS_LAUNCH_NONCE_ENV,
  MANAGED_PROCESS_WINDOWS_STDOUT_FLAG,
  MANAGED_PROCESS_WINDOWS_STDERR_FLAG,
  MANAGED_PROCESS_WINDOWS_CONTROL_FLAG,
  MANAGED_PROCESS_TARGET_SEPARATOR,
  MANAGED_PROCESS_LAUNCH_ERROR_PREFIX,
  MANAGED_PROCESS_LAUNCH_READY_PREFIX,
  MANAGED_PROCESS_LAUNCH_OUTPUT_PREFIX,
  cleanupWindowsOutputSpool,
  createWindowsOutputSpool,
  managedProcessLauncherArgv,
  managedProcessLauncherEnvironment,
  runManagedProcessLauncher,
  type WindowsManagedProcessOutputPaths,
  type ManagedProcessActivationFrame,
  type WindowsOutputSpool,
} from '@/platform/execution/local/managedProcessLauncher'

if (import.meta.main) {
  process.exit(await runManagedProcessLauncher(Bun.argv))
}

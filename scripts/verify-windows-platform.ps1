# RFC-254 — Windows platform verification, runnable directly on a Windows host.
#
# WHY THIS EXISTS
# ---------------
# Three of this RFC's claims cannot be checked anywhere but a real Windows
# kernel. Windows containers need a Windows host, so Docker on a macOS/Linux dev
# box is not a substitute, and Wine emulates Job Object / kernel32 semantics too
# incompletely to be evidence for a process-LIFETIME boundary.
#
# The CI job (.github/workflows/windows-platform.yml) covers the same ground on
# every push. This script exists for the faster loop: a Parallels/Hyper-V VM or
# a developer's own machine, where the repository is already checked out (or
# reachable through a Parallels share at \\Mac\Home\...).
#
# USAGE (from the repo root, in PowerShell):
#   bun install
#   ./scripts/verify-windows-platform.ps1
#
# It prints evidence, not just pass/fail: the resolved toolchain paths are as
# interesting as the assertions, because the interpreter-resolution and
# controlled-PATH designs were written against assumptions about where things
# live on Windows.

$ErrorActionPreference = 'Stop'

function Section($name) {
  Write-Host ''
  Write-Host "=== $name ===" -ForegroundColor Cyan
}

Section 'Host facts (evidence for the RFC-254 design assumptions)'
Write-Host "OS         : $([System.Environment]::OSVersion.VersionString)"
Write-Host "Arch       : $env:PROCESSOR_ARCHITECTURE"
Write-Host "SystemRoot : $env:SystemRoot"
Write-Host "USERPROFILE: $env:USERPROFILE"
Write-Host "HOME       : $(if ($env:HOME) { $env:HOME } else { '<unset — this is why T11b reads USERPROFILE>' })"

Section 'git and the Git Bash derivation (T22 / design gate P0-A)'
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if ($git) {
  Write-Host "git        : $git"
  # The platform derives bash as <root>\bin\bash.exe from <root>\cmd\git.exe.
  $gitRoot = Split-Path (Split-Path $git -Parent) -Parent
  $derived = Join-Path (Join-Path $gitRoot 'bin') 'bash.exe'
  Write-Host "derived bash: $derived  (exists: $(Test-Path $derived))"
} else {
  Write-Host 'git        : NOT FOUND — agent git calls and bash script nodes will fail' -ForegroundColor Yellow
}
# The trap this design avoids: System32\bash.exe is the WSL launcher. Finding it
# by name would run a script inside a DIFFERENT operating system.
$bareBash = (Get-Command bash -ErrorAction SilentlyContinue).Source
Write-Host "bare 'bash' resolves to: $(if ($bareBash) { $bareBash } else { '<none>' })"
if ($bareBash -and $bareBash -like '*System32*') {
  Write-Host '  ^ exactly the WSL launcher the design refuses to use' -ForegroundColor Yellow
}

Section 'python candidate chain (T22: python3 -> python -> py)'
foreach ($name in @('python3', 'python', 'py')) {
  $p = (Get-Command $name -ErrorAction SilentlyContinue).Source
  if ($p) {
    # A Microsoft Store alias is not an interpreter: it exits non-zero and opens
    # the Store. The platform filters it with exactly this probe.
    $v = (& $name --version 2>&1 | Out-String).Trim()
    $ok = $LASTEXITCODE -eq 0
    Write-Host "$name -> $p  (--version ok: $ok) $v"
  } else {
    Write-Host "$name -> <none>"
  }
}

Section 'sqlite3 (expected ABSENT — RFC-254 D15)'
$sq = (Get-Command sqlite3 -ErrorAction SilentlyContinue).Source
Write-Host "sqlite3    : $(if ($sq) { $sq } else { '<absent, as expected — this is why e2e moved to bun:sqlite>' })"

Section 'RFC-254 platform suites on a real kernel'
bun test --isolate `
  packages/backend/tests/rfc254-platform-exec.test.ts `
  packages/backend/tests/rfc254-file-trust.test.ts `
  packages/backend/tests/rfc254-env-case-folding.test.ts `
  packages/backend/tests/rfc254-git-windows.test.ts `
  packages/backend/tests/rfc254-script-node-windows.test.ts `
  packages/backend/tests/rfc254-process-tree-ownership.test.ts `
  packages/backend/tests/rfc254-platform-surface-guard.test.ts
if ($LASTEXITCODE -ne 0) { throw 'RFC-254 platform suites failed' }

Section 'Job Object end-to-end (design gate P0-D — the claim that needs a kernel)'
# Spawns a tree, adopts it, kills the PARENT only, and checks the grandchild is
# gone. That is the property the store-reclaim decision depends on: without it,
# a surviving descendant still holds the runtime store while the platform has
# already declared the run reaped and handed the store to the next one.
bun run scripts/verify-windows-job-object.ts
if ($LASTEXITCODE -ne 0) { throw 'Job Object verification failed' }

Section 'Single binary'
bun run build:binary
if ($LASTEXITCODE -ne 0) { throw 'build:binary failed' }
Get-ChildItem dist | Format-Table Name, Length
$bin = (Get-ChildItem dist -Filter 'agent-workflow-windows-*' | Select-Object -First 1).FullName
if (-not $bin) { throw 'no windows artifact produced' }
Write-Host "artifact   : $bin"
& $bin version
# `doctor` also reports containment status, so on Windows it is the check that
# the platform says "no provider" honestly instead of claiming a boundary.
& $bin doctor

Write-Host ''
Write-Host 'All RFC-254 Windows checks passed.' -ForegroundColor Green

#!/bin/sh
# Workflow-draft launcher for stub-opencode-intent.sh. Its name deliberately
# stays outside the version-telemetry stub matrix because version handling is
# delegated byte-for-byte to the canonical intent stub.

set -eu

STUB_INTENT_VARIANT=workflow
export STUB_INTENT_VARIANT

exec "$(dirname "$0")/stub-opencode-intent.sh" "$@"

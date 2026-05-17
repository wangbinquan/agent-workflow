#!/usr/bin/env bash
# RFC-031 fake npm shim — minimal subset for installPlugin tests.
#
# Supported modes (selected via FAKE_NPM_MODE env var):
#   --version   → prints "9.0.0\n", exit 0
#   install --prefix <dir> <spec>:
#     success (default) → creates <dir>/node_modules/<pkgName>/package.json
#                          with version=2.4.1 (or FAKE_NPM_VERSION if set);
#                          pkgName derived from spec (strip @version / scope).
#     failure (FAKE_NPM_MODE=fail) → prints to stderr and exits 1.
#     timeout (FAKE_NPM_MODE=timeout) → sleeps forever.
# Other commands → silently exit 0.
set -e

MODE="${FAKE_NPM_MODE:-success}"

if [[ "$1" == "--version" ]]; then
  echo "9.0.0"
  exit 0
fi

if [[ "$1" == "install" ]]; then
  # find --prefix arg + last positional spec.
  PREFIX=""
  SPEC=""
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prefix) PREFIX="$2"; shift 2 ;;
      --no-audit|--no-fund|--no-save|--silent) shift ;;
      -*) shift ;;
      *) SPEC="$1"; shift ;;
    esac
  done

  if [[ "$MODE" == "fail" ]]; then
    echo "ERR! 404 Not Found - GET https://registry.example.com/fake/${SPEC}" >&2
    echo "ERR! 404 ${SPEC} is not in the npm registry." >&2
    exit 1
  fi

  if [[ "$MODE" == "timeout" ]]; then
    # Sleep longer than any reasonable test timeout.
    sleep 300
    exit 0
  fi

  if [[ "$MODE" == "leak-secret" ]]; then
    # Used to verify redactSensitiveString catches secrets in stderr.
    echo "ERR! Failed at https://x-token-auth:SUPER_SECRET_TOKEN_123@example.com/foo" >&2
    exit 1
  fi

  # Success path. Strip optional @version + scope prefix.
  PKG_NAME="${SPEC%@*}"
  # Handle scoped: keep the scope as a separate dir.
  case "$PKG_NAME" in
    @*)
      SCOPE="${PKG_NAME%%/*}"
      NAME="${PKG_NAME#*/}"
      INSTALL_DIR="${PREFIX}/node_modules/${SCOPE}/${NAME}"
      ;;
    *)
      INSTALL_DIR="${PREFIX}/node_modules/${PKG_NAME}"
      ;;
  esac
  mkdir -p "$INSTALL_DIR"
  VERSION="${FAKE_NPM_VERSION:-2.4.1}"
  cat > "$INSTALL_DIR/package.json" <<EOF
{
  "name": "${PKG_NAME}",
  "version": "${VERSION}",
  "main": "index.js"
}
EOF
  cat > "$INSTALL_DIR/index.js" <<'EOF'
export default { id: 'fake' }
EOF
  exit 0
fi

exit 0

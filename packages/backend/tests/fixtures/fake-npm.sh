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
  if [[ -n "${FAKE_NPM_COUNTER_FILE:-}" ]]; then
    printf 'install\n' >> "$FAKE_NPM_COUNTER_FILE"
  fi
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

  if [[ "$MODE" == "pause" ]]; then
    : "${FAKE_NPM_PAUSE_STARTED:?FAKE_NPM_PAUSE_STARTED is required in pause mode}"
    : "${FAKE_NPM_PAUSE_RELEASE:?FAKE_NPM_PAUSE_RELEASE is required in pause mode}"
    touch "$FAKE_NPM_PAUSE_STARTED"
    while [[ ! -f "$FAKE_NPM_PAUSE_RELEASE" ]]; do sleep 0.01; done
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
  VERSION="${FAKE_NPM_VERSION:-2.4.1}"

  # Mimic real `npm install` behaviour: drop transitive deps into node_modules/
  # with DIFFERENT (misleading) versions, so any code that picks "the installed
  # package" by walking node_modules blindly will resolve the wrong
  # package.json. Decoys are created BEFORE the requested package so on
  # creation-ordered filesystems readdir returns a decoy first (this is how
  # the production bug manifested — readdir returned `zod` ahead of the
  # actually-requested package). See tests/services/pluginInstaller.test.ts
  # "picks requested package by host package.json, not readdir order".
  for DECOY in aaa-decoy-transitive zzz-decoy-transitive; do
    DECOY_DIR="${PREFIX}/node_modules/${DECOY}"
    mkdir -p "$DECOY_DIR"
    cat > "$DECOY_DIR/package.json" <<EOF
{
  "name": "${DECOY}",
  "version": "9.9.9",
  "main": "index.js"
}
EOF
  done

  mkdir -p "$INSTALL_DIR"
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

  # Mimic real `npm install`'s default --save behaviour: record the requested
  # package under the host package.json's dependencies, so the installer has a
  # reliable signal for *which* node_modules entry the user actually asked for.
  HOST_PKG="${PREFIX}/package.json"
  if [[ -f "$HOST_PKG" ]]; then
    # Naive rewrite — fixture host package.json is always seeded with a literal
    # "dependencies": {} line by installPluginInner; we just substitute it.
    TMP="${HOST_PKG}.tmp"
    awk -v pkg="$PKG_NAME" -v ver="$VERSION" '
      {
        if ($0 ~ /"dependencies":[[:space:]]*\{\}/) {
          sub(/"dependencies":[[:space:]]*\{\}/, "\"dependencies\": { \"" pkg "\": \"^" ver "\" }")
        }
        print
      }
    ' "$HOST_PKG" > "$TMP" && mv "$TMP" "$HOST_PKG"
  fi

  # RFC-201 immutable-generation identity fixture. Real npm writes this lock
  # entry; the installer requires resolved+integrity for npm and a final
  # commit SHA for git instead of trusting package.json.version display text.
  case "$SPEC" in
    git+*|github:*|gitlab:*|bitbucket:*)
      COMMIT="${FAKE_NPM_COMMIT:-0123456789abcdef0123456789abcdef01234567}"
      RESOLVED="git+https://example.test/${PKG_NAME}.git#${COMMIT}"
      GIT_HEAD_VALUE="\"${COMMIT}\""
      ;;
    *)
      RESOLVED="https://registry.example.test/${PKG_NAME}/-/${PKG_NAME##*/}-${VERSION}.tgz"
      GIT_HEAD_VALUE="null"
      ;;
  esac
  cat > "${PREFIX}/package-lock.json" <<EOF
{
  "name": "aw-plugin-host",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/${PKG_NAME}": {
      "version": "${VERSION}",
      "resolved": "${RESOLVED}",
      "integrity": "sha512-fake-${VERSION}",
      "gitHead": ${GIT_HEAD_VALUE}
    }
  }
}
EOF
  exit 0
fi

exit 0

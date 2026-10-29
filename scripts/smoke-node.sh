#!/usr/bin/env bash
# Install a packed mdmem tarball into a temporary prefix and run it under Node
# alone: no bun on PATH. Usage: scripts/smoke-node.sh <mdmem-*.tgz>
set -euo pipefail

tarball=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
version=$(tar -xzOf "$tarball" package/package.json | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A PATH holding node and npm alone, wherever they are installed, and never bun.
mkdir -p "$work/nodebin" "$work/home" "$work/prefix" "$work/project"
real_node=$(command -v node)
npm_cli="$(npm root -g)/npm/bin/npm-cli.js"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$real_node" >"$work/nodebin/node"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$real_node" "$npm_cli" >"$work/nodebin/npm"
chmod +x "$work/nodebin/node" "$work/nodebin/npm"
export HOME="$work/home"
export PATH="$work/prefix/bin:$work/nodebin:/usr/bin:/bin"

if command -v bun >/dev/null; then
  echo "bun is on PATH ($(command -v bun)): the smoke must run on Node alone" >&2
  exit 1
fi
npm install -g --prefix "$work/prefix" "$tarball" >/dev/null

fail() { echo "smoke: $1" >&2; exit 1; }
expect_contains() { # <label> <haystack> <needle>
  case "$2" in *"$3"*) ;; *) fail "$1: expected '$3' in:
$2" ;; esac
}

cd "$work/project"
expect_contains "--version" "$(mdmem --version)" "mdmem $version"
mdmem help >/dev/null
added=$(mdmem add --type feedback --name from-flag --description "Body from --body" --body "Flag body.")
expect_contains "add --body" "$added" "Saved from-flag.md"
piped=$(printf 'Piped body.\n' | mdmem add --type feedback --name from-stdin --description "Body from stdin")
expect_contains "add from stdin" "$piped" "Saved from-stdin.md"
expect_contains "read" "$(mdmem read from-stdin)" "Piped body."
expect_contains "status" "$(mdmem status)" "Store: home"
mdmem doctor >/dev/null
payload='{"session_id":"smoke","hook_event_name":"SessionStart","source":"startup","cwd":"'"$PWD"'"}'
expect_contains "hook index" "$(printf '%s\n' "$payload" | mdmem hook claude-code index)" "from-stdin.md"
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
answer=$(printf '%s\n' "$init" | mdmem mcp 2>/dev/null)
expect_contains "mcp initialize" "$answer" "\"serverInfo\":{\"name\":\"mdmem\",\"version\":\"$version\"}"
echo "smoke: mdmem $version runs on $(node --version) from $tarball"

#!/usr/bin/env bash
# Run from a nonlogin shell. Installs the checked-in lockfile without lifecycle scripts.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd -- "${1:-$script_dir/../..}"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 11)) throw new Error("Node >=24.11 is required"); console.log("Node", process.version)'
pnpm_version=$(pnpm --version)
test "$pnpm_version" = "10.32.1" || { printf 'Expected pnpm 10.32.1, found %s\n' "$pnpm_version" >&2; exit 1; }
pnpm install --frozen-lockfile --ignore-scripts

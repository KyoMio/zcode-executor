#!/usr/bin/env bash
# Checks the published root package against DSH; does not build the plugin.
set -euo pipefail

cd "$(dirname "$0")/.."
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
assert.deepEqual(read('package.json').peerDependencies, read('dsh-plugin/package.json').peerDependencies);
NODE

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
npm pack --pack-destination "$work"
tarballs=("$work"/*.tgz)

# 0.2.2-alpha.0 is unpublished; alpha.2 is its first published successor.
for version in 0.1.7-rc.2 0.2.0-rc.1 0.2.1-alpha.1 0.2.2-alpha.2 0.2.3-alpha.1; do
  echo "=== DSH $version ==="
  mkdir "$work/$version"
  (
    cd "$work/$version"
    npm init -y
    npm install "${tarballs[0]}" "@deepseek-ai/dsh@$version"
  )
  echo "=== DSH $version: success ==="
done

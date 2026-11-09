#!/usr/bin/env bash
# Builds the release zip locally: dist/shardy-v<version>.zip with the extension in a shardy/ folder.
# The folder name stays the same across versions so an update unzips over the old one and keeps the user's data.
# Usage: ./scripts/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."

node tests/shared.test.js
node tests/accounts.test.js
for f in extension/*.js; do node --check "$f"; done

version=$(node -p "require('./extension/manifest.json').version")
name="shardy-v${version}"
stage="dist/stage"
rm -rf "$stage" "dist/${name}.zip"
mkdir -p "$stage/shardy"
cp -R extension/. "$stage/shardy/"
find "$stage" -name '.DS_Store' -delete
(cd "$stage" && zip -qrX "../${name}.zip" shardy)
rm -rf "$stage"

echo "built dist/${name}.zip"
shasum -a 256 "dist/${name}.zip"

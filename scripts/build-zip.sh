#!/usr/bin/env bash
set -euo pipefail
out="propertyos-line-importer.zip"
rm -f "$out"
zip -r "$out" manifest.json popup.html src -x '*.test.js' >/dev/null
echo "built $out"

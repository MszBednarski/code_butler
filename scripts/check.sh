#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for package in app platform project-worker; do
  npm --prefix "$package" ci --no-audit --no-fund
done
npm --prefix app run typecheck
npm --prefix app run build
npm --prefix app test
npm --prefix platform test
npm --prefix project-worker test

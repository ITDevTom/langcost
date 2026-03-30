#!/bin/bash
set -e

# Publish all langcost packages to npm in dependency order.
# Replaces workspace:* with actual versions before publishing.
# Usage: ./scripts/publish.sh [--dry-run]

DRY_RUN=""
OTP=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="--dry-run"; echo "=== DRY RUN ===" ;;
    --otp=*) OTP="--otp=${arg#--otp=}" ;;
  esac
done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT/packages/core/package.json').version")

PACKAGES=(
  "packages/core"
  "packages/db"
  "packages/analyzers"
  "packages/adapter-openclaw"
  "packages/cli"
)

# Replace workspace:* with real version in all package.json files
for pkg in "${PACKAGES[@]}"; do
  sed -i.bak "s/\"workspace:\\*\"/\"^$VERSION\"/g" "$ROOT/$pkg/package.json"
done

# Publish each package
for pkg in "${PACKAGES[@]}"; do
  NAME=$(node -p "require('$ROOT/$pkg/package.json').name")
  PKG_VERSION=$(node -p "require('$ROOT/$pkg/package.json').version")
  echo ""
  echo "--- Publishing $NAME@$PKG_VERSION ---"

  # Copy root README so npm page shows it
  cp "$ROOT/README.md" "$ROOT/$pkg/README.md"

  cd "$ROOT/$pkg"
  npm publish $DRY_RUN $OTP
  cd "$ROOT"

  # Clean up copied README
  rm "$ROOT/$pkg/README.md"
done

# Restore original package.json files
for pkg in "${PACKAGES[@]}"; do
  mv "$ROOT/$pkg/package.json.bak" "$ROOT/$pkg/package.json"
done

echo ""
echo "=== Done ==="

#!/usr/bin/env bash
#
# Build the per-platform Claude Agent SDK tarballs that a *built* Celiador editor
# downloads at runtime (see product.json `agentSdks.claude`).
#
# Why this exists
# ---------------
# The agent host loads @anthropic-ai/claude-agent-sdk from a cache dir it fills by
# downloading `product.agentSdks.claude.urlTemplate` with `{sdkTarget}` substituted
# (src/vs/platform/agentHost/node/agentSdkDownloader.ts). The SDK is NOT bundled in
# the app. Each tarball must extract to a tree whose root contains:
#
#     node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
#
# (the exact entry claudeAgentSdkService.ts:289 imports), plus the matching
# platform-native package (@anthropic-ai/claude-agent-sdk-<sdkTarget>), which is an
# optionalDependency keyed by os/cpu/libc. We let npm pick the right native package
# per target via --os/--cpu/--libc, so this runs on any one host (e.g. a mac) and
# still produces every platform's tarball.
#
# Usage:   scripts/build-claude-sdk-tarballs.sh [version] [outDir]
#   version  SDK version (default: read from node_modules, else 0.3.258)
#   outDir   output root (default: .build/claude-sdk)
#
# Output:  <outDir>/<version>/<sdkTarget>.tgz   — mirrors the URL path, so hosting
#          is a plain sync to whatever serves https://celiador.ai/sdk/claude/.
#
# After building, host the files so this resolves for each target:
#   https://celiador.ai/sdk/claude/<version>/<sdkTarget>.tgz
# (see scripts/claude-sdk-hosting.md).

set -euo pipefail

PKG="@anthropic-ai/claude-agent-sdk"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve version: arg → installed SDK → fallback.
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
	INSTALLED="$REPO_ROOT/node_modules/$PKG/package.json"
	if [ -f "$INSTALLED" ]; then
		VERSION="$(node -p "require('$INSTALLED').version")"
	else
		VERSION="0.3.258"
	fi
fi

OUT_DIR="${2:-$REPO_ROOT/.build/claude-sdk}/$VERSION"
mkdir -p "$OUT_DIR"

# sdkTarget → npm platform flags. Mirrors resolveSdkTarget() in agentSdkDownloader.ts
# (`${platform}-${arch}` with a `-musl` suffix only where the SDK ships a musl build).
TARGETS=(
	"darwin-arm64|--os=darwin --cpu=arm64"
	"darwin-x64|--os=darwin --cpu=x64"
	"linux-x64|--os=linux --cpu=x64 --libc=glibc"
	"linux-arm64|--os=linux --cpu=arm64 --libc=glibc"
	"linux-x64-musl|--os=linux --cpu=x64 --libc=musl"
	"linux-arm64-musl|--os=linux --cpu=arm64 --libc=musl"
	"win32-x64|--os=win32 --cpu=x64"
	"win32-arm64|--os=win32 --cpu=arm64"
)

echo "Building $PKG@$VERSION tarballs → $OUT_DIR"

for entry in "${TARGETS[@]}"; do
	sdkTarget="${entry%%|*}"
	flags="${entry#*|}"
	scratch="$(mktemp -d)"
	echo ""
	echo "==> $sdkTarget  ($flags)"

	# Install the main SDK + the one matching native optional dep into scratch/node_modules.
	# shellcheck disable=SC2086
	npm install "$PKG@$VERSION" \
		--prefix "$scratch" \
		--omit=dev --no-save --no-package-lock --no-audit --no-fund \
		$flags

	entryFile="$scratch/node_modules/$PKG/sdk.mjs"
	if [ ! -f "$entryFile" ]; then
		echo "ERROR: $entryFile missing after install for $sdkTarget" >&2
		rm -rf "$scratch"
		exit 1
	fi
	# Warn (don't fail) if the native package for this target didn't land — some
	# targets may be unavailable for a given SDK release.
	if [ ! -d "$scratch/node_modules/$PKG-$sdkTarget" ]; then
		echo "WARN: native package $PKG-$sdkTarget not installed (os/cpu filter?)" >&2
	fi

	tar -czf "$OUT_DIR/$sdkTarget.tgz" -C "$scratch" node_modules
	echo "    wrote $OUT_DIR/$sdkTarget.tgz"
	rm -rf "$scratch"
done

echo ""
echo "Done. Host these under https://celiador.ai/sdk/claude/$VERSION/ so each"
echo "{sdkTarget}.tgz resolves. See scripts/claude-sdk-hosting.md."

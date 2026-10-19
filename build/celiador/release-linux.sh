#!/usr/bin/env bash
# Celiador: turn the CI's Linux packages into a published release — manifest entry
# [+ publish]. The Linux counterpart of release-macos.sh, minus signing: Linux
# packages ship unsigned in v1 (.deb/.rpm GPG signing is a follow-up).
#
# Input is the "Collect packages" output of the Celiador Build / Release (Linux)
# workflow for one architecture:
#   Celiador-linux-<arch>-<version>.tar.gz   the app folder (VSCode-linux-<arch>/)
#   Celiador-linux-<arch>-<version>.deb
#   Celiador-linux-<arch>-<version>.rpm
#
# Produces, in --out (default .build/celiador-release-linux):
#   Celiador-linux-<arch>-<version>-<commit7>.{tar.gz,deb,rpm}   renamed to carry the commit
#   release-<commit7>.json                                        this build's manifest entry
#   manifest.json                                                 the daemon's manifest with this build merged in
#
# The manifest entry's `archive` is the tar.gz; `.deb`/`.rpm` ride `assets`. The
# daemon's update feed answers a Linux editor with the download page (there is no
# in-place updater on Linux), so a newer entry here is what makes "Update
# available" appear in installed copies.
#
# --publish rsyncs the files FIRST and manifest.json LAST into the daemon's
# releases dir on the box, like the macOS script. Run from a machine with ssh to
# the box (the self-hosted Mac runner does, in the Release (Linux) workflow).
#
# Usage: build/celiador/release-linux.sh --packages <dir> [options]
#   --packages <dir>        where the three packages are (required)
#   --arch <arch>           default x64
#   --out <dir>             default .build/celiador-release-linux
#   --notes <markdown>      release notes for the manifest entry (or --notes-file <path>)
#   --publish               rsync to $CELIADOR_RELEASE_HOST:$CELIADOR_RELEASE_DIR
#                           (default cliefden.com:daemon/releases)
#   --manifest-url <url>    current manifest, merged before writing (default https://celiador.ai/api/releases)
#
# Needs: bash, tar, node, curl, rsync, and shasum or sha256sum.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGES=""
ARCH="x64"
OUT="$ROOT/.build/celiador-release-linux"
NOTES=""
PUBLISH=0
MANIFEST_URL="${CELIADOR_MANIFEST_URL:-https://celiador.ai/api/releases}"
RELEASE_HOST="${CELIADOR_RELEASE_HOST:-cliefden.com}"
RELEASE_DIR="${CELIADOR_RELEASE_DIR:-daemon/releases}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --packages) PACKAGES="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    --notes-file) NOTES="$(cat "$2")"; shift 2 ;;
    --publish) PUBLISH=1; shift ;;
    --manifest-url) MANIFEST_URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,36p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "error: unknown option $1" >&2; exit 2 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }
sha256() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

[[ -n "$PACKAGES" && -d "$PACKAGES" ]] || die "--packages <dir> is required (the CI's Collect packages output)"
for tool in tar node curl rsync; do
  command -v "$tool" >/dev/null || die "$tool not found"
done
command -v shasum >/dev/null || command -v sha256sum >/dev/null || die "shasum or sha256sum not found"

PLATFORM="linux-$ARCH"
TGZ="$(ls "$PACKAGES"/Celiador-linux-"$ARCH"-*.tar.gz 2>/dev/null | head -1 || true)"
DEB="$(ls "$PACKAGES"/Celiador-linux-"$ARCH"-*.deb 2>/dev/null | head -1 || true)"
RPM="$(ls "$PACKAGES"/Celiador-linux-"$ARCH"-*.rpm 2>/dev/null | head -1 || true)"
[[ -f "$TGZ" ]] || die "no Celiador-linux-$ARCH-*.tar.gz in $PACKAGES"
[[ -f "$DEB" ]] || die "no Celiador-linux-$ARCH-*.deb in $PACKAGES"
[[ -f "$RPM" ]] || die "no Celiador-linux-$ARCH-*.rpm in $PACKAGES"

# ── What we're releasing: the app's own product.json is the source of truth ────
APP_DIR="VSCode-linux-$ARCH"
PRODUCT_JSON="$(tar -xzOf "$TGZ" "$APP_DIR/resources/app/product.json" 2>/dev/null || true)"
[[ -n "$PRODUCT_JSON" ]] || die "$TGZ has no $APP_DIR/resources/app/product.json (not a gulp -min build?)"
read -r COMMIT VERSION QUALITY BUILD_TS BUILD_NO < <(PRODUCT_JSON="$PRODUCT_JSON" node -e '
  const p = JSON.parse(process.env.PRODUCT_JSON);
  const ts = Date.parse(p.date || "") || Date.now();
  console.log(p.commit, p.version, p.quality || "stable", ts, p.celiadorBuild || "-");
')
PRODUCT_VERSION="$VERSION"
[[ "$BUILD_NO" != "-" ]] && PRODUCT_VERSION="$VERSION (build $BUILD_NO)"
if [[ "$BUILD_NO" != "-" && "$BUILD_NO" -lt 1000 ]]; then
  die "build number $BUILD_NO is implausibly small — the app was built from a shallow checkout (fetch-depth: 0, then rebuild)"
fi
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "product.json has no commit (is this a gulp -min build?)"
# Same guard as macOS: never ship an editor with no AI layer.
tar -tzf "$TGZ" "$APP_DIR/resources/app/extensions/celiador-ai/out/extension.js" >/dev/null 2>&1 \
  || die "the package has no compiled celiador-ai extension — the build must compile it first"
SHORT="${COMMIT:0:7}"
NAME="Celiador-$PLATFORM-$VERSION-$SHORT"
log "Releasing Celiador $PRODUCT_VERSION ($SHORT, $QUALITY) for $PLATFORM"
echo "    packages: $PACKAGES"
echo "    out:      $OUT"

# ── Stage: rename the packages to carry the commit, hash them ────────────────
mkdir -p "$OUT"
rm -f "$OUT/$NAME.tar.gz" "$OUT/$NAME.deb" "$OUT/$NAME.rpm"
cp "$TGZ" "$OUT/$NAME.tar.gz"
cp "$DEB" "$OUT/$NAME.deb"
cp "$RPM" "$OUT/$NAME.rpm"
TGZ_SHA="$(sha256 "$OUT/$NAME.tar.gz")"
DEB_SHA="$(sha256 "$OUT/$NAME.deb")"
RPM_SHA="$(sha256 "$OUT/$NAME.rpm")"
echo "    $NAME.tar.gz  $TGZ_SHA"
echo "    $NAME.deb     $DEB_SHA"
echo "    $NAME.rpm     $RPM_SHA"

# ── Manifest: this build's entry, merged into the current published manifest ─
log "Writing manifest"
CURRENT="$(curl -fsS --max-time 20 "$MANIFEST_URL" 2>/dev/null || echo '{"releases":[]}')"
CURRENT="$CURRENT" NOTES="$NOTES" node - "$OUT" "$NAME" "$PLATFORM" "$QUALITY" "$COMMIT" "$PRODUCT_VERSION" "$BUILD_TS" "$TGZ_SHA" "$DEB_SHA" "$RPM_SHA" "$SHORT" <<'JS'
const fs = require("fs");
const [out, name, platform, quality, version, productVersion, ts, tgzSha, debSha, rpmSha, short] = process.argv.slice(2);
const entry = {
  platform, quality, version, productVersion, timestamp: Number(ts),
  archive: `${name}.tar.gz`, archiveSha256: tgzSha,
  assets: { deb: { file: `${name}.deb`, sha256: debSha }, rpm: { file: `${name}.rpm`, sha256: rpmSha } },
  ...(process.env.NOTES ? { notes: process.env.NOTES } : {}),
};
let current = [];
try { current = JSON.parse(process.env.CURRENT || "{}").releases || []; } catch { current = []; }
// The site's listing adds absolute URLs; the manifest on disk stores names only.
const strip = ({ archiveUrl, dmgUrl, assetUrls, ...rest }) => rest;
const releases = [entry, ...current.map(strip).filter(e => !(e.platform === platform && e.quality === quality && e.version === version))]
  .sort((a, b) => b.timestamp - a.timestamp);
fs.writeFileSync(`${out}/release-${short}.json`, JSON.stringify(entry, null, 2) + "\n");
fs.writeFileSync(`${out}/manifest.json`, JSON.stringify({ releases }, null, 2) + "\n");
const mine = releases.filter(e => e.platform === platform);
console.log(`    manifest.json: ${releases.length} release(s), ${mine.length} for ${platform}, newest ${mine[0].productVersion} (${mine[0].version.slice(0, 7)})`);
JS

# ── Publish ────────────────────────────────────────────────────────────────
if [[ $PUBLISH -eq 1 ]]; then
  log "Publishing to $RELEASE_HOST:$RELEASE_DIR"
  ssh "$RELEASE_HOST" "mkdir -p '$RELEASE_DIR'"
  rsync -a "$OUT/$NAME.tar.gz" "$OUT/$NAME.deb" "$OUT/$NAME.rpm" "$RELEASE_HOST:$RELEASE_DIR/"
  # Manifest last: until it lands, nobody is offered an artifact that isn't uploaded.
  rsync -a "$OUT/manifest.json" "$RELEASE_HOST:$RELEASE_DIR/manifest.json"
  echo "    live: $MANIFEST_URL/latest/$PLATFORM/$QUALITY"
fi

log "Done: $OUT"
ls -la "$OUT"

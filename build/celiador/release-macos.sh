#!/usr/bin/env bash
# Celiador: sign → notarize → staple → package → manifest [→ publish] the packaged macOS app.
#
# Input is the gulp output (`npm run gulp vscode-darwin-arm64-min` writes
# ../VSCode-darwin-arm64/Celiador.app). The app is COPIED into the output dir and
# signed there, so the build you run locally is never touched.
#
# Produces, in --out (default .build/celiador-release):
#   Celiador-darwin-arm64-<version>-<commit7>.zip  stapled app, zipped — the only payload
#                                                  Squirrel.Mac (the built-in updater) can apply
#   Celiador-darwin-arm64-<version>-<commit7>.dmg  what a person downloads from celiador.ai
#   release-<commit7>.json                         this build's manifest entry
#   manifest.json                                  the daemon's manifest with this build merged in
#
# --publish rsyncs the artifacts FIRST and manifest.json LAST into the daemon's
# releases dir on the box (daemon: CELIADOR_RELEASES_DIR), so the update feed
# never names a file that isn't there yet. See docs/RELEASING.md.
#
# Usage: build/celiador/release-macos.sh [options]
#   --app <Celiador.app>    default ../VSCode-darwin-arm64/Celiador.app
#   --identity <name>       default $CELIADOR_SIGN_IDENTITY, else the Developer ID Application identity
#   --out <dir>             default .build/celiador-release
#   --notes <markdown>      release notes for the manifest entry (or --notes-file <path>)
#   --skip-notarize         sign + package only — local checks with an Apple Development identity;
#                           Gatekeeper will NOT accept the result on another Mac
#   --publish               rsync to $CELIADOR_RELEASE_HOST:$CELIADOR_RELEASE_DIR
#                           (default cliefden.com:daemon/releases)
#   --manifest-url <url>    current manifest, merged before writing (default https://celiador.ai/api/releases)
#
# Needs: Xcode command line tools (codesign, ditto, hdiutil, stapler), node, rsync, and
# `asc` signed in (notarization goes through the App Store Connect API key: `asc auth status`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/../VSCode-darwin-arm64/Celiador.app"
IDENTITY="${CELIADOR_SIGN_IDENTITY:-Developer ID Application: Stefan Crafoord-Wiklund (XPNFDWPFAV)}"
OUT="$ROOT/.build/celiador-release"
NOTES=""
SKIP_NOTARIZE=0
PUBLISH=0
MANIFEST_URL="${CELIADOR_MANIFEST_URL:-https://celiador.ai/api/releases}"
RELEASE_HOST="${CELIADOR_RELEASE_HOST:-cliefden.com}"
RELEASE_DIR="${CELIADOR_RELEASE_DIR:-daemon/releases}"
PLATFORM="darwin-arm64"
ENT="$ROOT/build/azure-pipelines/darwin"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    --notes-file) NOTES="$(cat "$2")"; shift 2 ;;
    --skip-notarize) SKIP_NOTARIZE=1; shift ;;
    --publish) PUBLISH=1; shift ;;
    --manifest-url) MANIFEST_URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "error: unknown option $1" >&2; exit 2 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

[[ -d "$APP" ]] || die "no app at $APP (build it first: npm run gulp vscode-darwin-arm64-min)"
for tool in codesign ditto hdiutil node rsync; do
  command -v "$tool" >/dev/null || die "$tool not found"
done
if [[ $SKIP_NOTARIZE -eq 0 ]]; then
  command -v asc >/dev/null || die "asc not found (brew install asc); or pass --skip-notarize"
  command -v xcrun >/dev/null || die "xcrun not found (Xcode command line tools)"
fi
security find-identity -v -p codesigning | grep -qF "$IDENTITY" \
  || die "signing identity \"$IDENTITY\" is not in the keychain (security find-identity -v -p codesigning)"
if [[ $SKIP_NOTARIZE -eq 0 && "$IDENTITY" != "Developer ID Application:"* ]]; then
  die "notarization needs a Developer ID Application identity, got \"$IDENTITY\" (or pass --skip-notarize)"
fi

# ── What we're releasing: the app's own product.json is the source of truth ────
PRODUCT="$APP/Contents/Resources/app/product.json"
read -r COMMIT VERSION QUALITY BUILD_TS < <(node -e '
  const p = require(process.argv[1]);
  const ts = Date.parse(p.date || "") || Date.now();
  console.log(p.commit, p.version, p.quality || "stable", ts);
' "$PRODUCT")
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "product.json has no commit (is this a gulp -min build?)"
SHORT="${COMMIT:0:7}"
NAME="Celiador-$PLATFORM-$VERSION-$SHORT"
log "Releasing Celiador $VERSION ($SHORT, $QUALITY) from $APP"
echo "    identity: $IDENTITY"
echo "    out:      $OUT"

# ── Stage a copy; never sign the build in place ─────────────────────────────
STAGE="$OUT/stage"
STAGE_APP="$STAGE/Celiador.app"
rm -rf "$STAGE"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE_APP"
# Resource forks / Finder info make codesign refuse the bundle.
xattr -cr "$STAGE_APP"

# ── Sign, inner-out, hardened runtime, secure timestamp ────────────────────
# Never --deep: it is deprecated and applies the wrong entitlements to the
# helpers, which notarization rejects. Order matters — every nested piece is
# signed before the bundle that seals it.
sign() { # sign <path> [entitlements.plist]
  if [[ -n "${2:-}" ]]; then
    codesign --force --timestamp --options runtime --entitlements "$2" --sign "$IDENTITY" "$1"
  else
    codesign --force --timestamp --options runtime --sign "$IDENTITY" "$1"
  fi
}
is_macho() { file -b "$1" | grep -q "Mach-O"; }

log "Signing loose binaries under Contents/Resources"
# Native modules (.node), dylibs and standalone tools (ripgrep, node-pty's
# spawn-helper, …). Non-macOS binaries shipped in universal packages (linux rg,
# windows .node) are not Mach-O and are skipped.
COUNT=0
while IFS= read -r -d '' f; do
  if is_macho "$f"; then
    sign "$f"
    COUNT=$((COUNT + 1))
  fi
done < <(find "$STAGE_APP/Contents/Resources" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0)
echo "    signed $COUNT"

log "Signing frameworks"
FW="$STAGE_APP/Contents/Frameworks"
EF="$FW/Electron Framework.framework"
for f in "$EF/Versions/A/Libraries/"*.dylib; do sign "$f"; done
sign "$EF/Versions/A/Helpers/chrome_crashpad_handler"
sign "$EF"
for name in Mantle ReactiveObjC Squirrel; do
  # Squirrel ships ShipIt, the updater's installer — sign it before its framework seals it.
  if [[ -f "$FW/$name.framework/Versions/A/Resources/ShipIt" ]]; then
    sign "$FW/$name.framework/Versions/A/Resources/ShipIt"
  fi
  sign "$FW/$name.framework"
done

log "Signing helper apps"
for helper in "$FW"/*Helper*.app; do
  case "$(basename "$helper")" in
    *"(GPU)"*)      sign "$helper" "$ENT/helper-gpu-entitlements.plist" ;;
    *"(Plugin)"*)   sign "$helper" "$ENT/helper-plugin-entitlements.plist" ;;
    *"(Renderer)"*) sign "$helper" "$ENT/helper-renderer-entitlements.plist" ;;
    *)              sign "$helper" "$ENT/helper-entitlements.plist" ;;
  esac
done

log "Signing the app"
sign "$STAGE_APP" "$ENT/app-entitlements.plist"
codesign --verify --deep --strict --verbose=2 "$STAGE_APP"
codesign --display --verbose=2 "$STAGE_APP" 2>&1 | grep -E "^(Authority|TeamIdentifier|Timestamp|CodeDirectory)" | sed 's/^/    /' || true

# ── Notarize + staple the app ──────────────────────────────────────────────
notarize() { # notarize <zip|dmg> — submit, wait, fail unless Accepted
  local file="$1" result status id
  echo "    submitting $(basename "$file") ($(du -h "$file" | cut -f1 | tr -d ' '))"
  result="$(asc notarization submit --file "$file" --wait --timeout 1h --output json)"
  # Walk the JSON for `status` and `id` wherever asc puts them.
  read -r status id < <(node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const find = (o, k) => { if (!o || typeof o !== "object") return undefined;
      if (typeof o[k] === "string") return o[k];
      for (const v of Object.values(o)) { const f = find(v, k); if (f) return f; } };
    console.log(find(r, "status") || "unknown", find(r, "id") || "-");
  ' <<<"$result")
  echo "    submission $id: $status"
  # macOS ships bash 3.2: no ${var,,}.
  if [[ "$(printf '%s' "$status" | tr '[:upper:]' '[:lower:]')" != "accepted" ]]; then
    echo "$result" >&2
    [[ "$id" != "-" ]] && asc notarization log --id "$id" >&2 || true
    die "notarization of $(basename "$file") was not accepted"
  fi
}

mkdir -p "$OUT"
if [[ $SKIP_NOTARIZE -eq 1 ]]; then
  log "Skipping notarization (--skip-notarize)"
else
  log "Notarizing the app"
  ditto -c -k --keepParent "$STAGE_APP" "$STAGE/notarize.zip"
  notarize "$STAGE/notarize.zip"
  rm -f "$STAGE/notarize.zip"
  xcrun stapler staple "$STAGE_APP"
  xcrun stapler validate "$STAGE_APP"
fi

# ── Package: zip (updater payload) + DMG (download) ────────────────────────
log "Packaging $NAME"
rm -f "$OUT/$NAME.zip" "$OUT/$NAME.dmg"
ditto -c -k --sequesterRsrc --keepParent "$STAGE_APP" "$OUT/$NAME.zip"

DMG_ROOT="$STAGE/dmg-root"
rm -rf "$DMG_ROOT"
mkdir -p "$DMG_ROOT"
ditto "$STAGE_APP" "$DMG_ROOT/Celiador.app"
ln -s /Applications "$DMG_ROOT/Applications"
hdiutil create -volname "Celiador" -srcfolder "$DMG_ROOT" -ov -format ULFO -quiet "$OUT/$NAME.dmg"
codesign --force --timestamp --sign "$IDENTITY" "$OUT/$NAME.dmg"
if [[ $SKIP_NOTARIZE -eq 0 ]]; then
  log "Notarizing the DMG"
  notarize "$OUT/$NAME.dmg"
  xcrun stapler staple "$OUT/$NAME.dmg"
  log "Gatekeeper assessment"
  spctl --assess --type execute --verbose=2 "$STAGE_APP"
fi

ZIP_SHA="$(shasum -a 256 "$OUT/$NAME.zip" | cut -d' ' -f1)"
DMG_SHA="$(shasum -a 256 "$OUT/$NAME.dmg" | cut -d' ' -f1)"
echo "    $NAME.zip  $ZIP_SHA"
echo "    $NAME.dmg  $DMG_SHA"

# ── Manifest: this build's entry, merged into the current published manifest ─
log "Writing manifest"
CURRENT="$(curl -fsS --max-time 20 "$MANIFEST_URL" 2>/dev/null || echo '{"releases":[]}')"
CURRENT="$CURRENT" NOTES="$NOTES" node - "$OUT" "$NAME" "$PLATFORM" "$QUALITY" "$COMMIT" "$VERSION" "$BUILD_TS" "$ZIP_SHA" "$DMG_SHA" "$SHORT" <<'JS'
const fs = require("fs");
const [out, name, platform, quality, version, productVersion, ts, zipSha, dmgSha, short] = process.argv.slice(2);
const entry = {
  platform, quality, version, productVersion, timestamp: Number(ts),
  archive: `${name}.zip`, archiveSha256: zipSha, dmg: `${name}.dmg`, dmgSha256: dmgSha,
  ...(process.env.NOTES ? { notes: process.env.NOTES } : {}),
};
let current = [];
try { current = JSON.parse(process.env.CURRENT || "{}").releases || []; } catch { current = []; }
// The site's listing adds absolute URLs; the manifest on disk stores names only.
const strip = ({ archiveUrl, dmgUrl, ...rest }) => rest;
const releases = [entry, ...current.map(strip).filter(e => !(e.platform === platform && e.quality === quality && e.version === version))]
  .sort((a, b) => b.timestamp - a.timestamp);
fs.writeFileSync(`${out}/release-${short}.json`, JSON.stringify(entry, null, 2) + "\n");
fs.writeFileSync(`${out}/manifest.json`, JSON.stringify({ releases }, null, 2) + "\n");
console.log(`    manifest.json: ${releases.length} release(s), newest ${releases[0].productVersion} (${releases[0].version.slice(0, 7)})`);
JS

# ── Publish ────────────────────────────────────────────────────────────────
if [[ $PUBLISH -eq 1 ]]; then
  [[ $SKIP_NOTARIZE -eq 0 ]] || die "refusing to --publish a build that was not notarized"
  log "Publishing to $RELEASE_HOST:$RELEASE_DIR"
  ssh "$RELEASE_HOST" "mkdir -p '$RELEASE_DIR'"
  rsync -a "$OUT/$NAME.zip" "$OUT/$NAME.dmg" "$RELEASE_HOST:$RELEASE_DIR/"
  # Manifest last: until it lands, nobody is offered an artifact that isn't uploaded.
  rsync -a "$OUT/manifest.json" "$RELEASE_HOST:$RELEASE_DIR/manifest.json"
  echo "    live: $MANIFEST_URL/latest/$PLATFORM/$QUALITY"
fi

rm -rf "$STAGE"
log "Done: $OUT"
ls -la "$OUT"

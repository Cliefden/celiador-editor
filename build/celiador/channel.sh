#!/usr/bin/env bash
# Celiador: select the build channel before a gulp build (CHANNELS.md).
#
#   build/celiador/channel.sh dev  [label]  # product.json = committed prod values + product.dev.json;
#                                           # app icon stamped red with the label (default: the short commit)
#   build/celiador/channel.sh test [label]  # … + product.test.json; icon stamped green (default: the tag at
#                                           # HEAD, else the short commit)
#   build/celiador/channel.sh prod          # product.json and the icon restored from git
#
# A channel is defined entirely by product.json: app identity (name, bundle id,
# data folder, URL protocol), the daemon it talks to, and the update feed it
# polls. The overlays are shallow (top-level keys) and `celiadorChannel` names
# the channel so the release script publishes to the matching environment.
# The icon banner (build/celiador/icon-banner.swift, as Celindor's TestFlight
# icons) makes a dev or test build recognisable in the Dock. The committed
# product.json and resources/darwin/code.icns are always prod; never commit an
# overlaid or stamped one.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHANNEL="${1:-}"
LABEL="${2:-}"
ICNS="resources/darwin/code.icns"

restore() {
  git -C "$ROOT" checkout -- product.json "$ICNS"
}

stamp_icon() { # <#rrggbb> <label>
  local work
  work="$(mktemp -d)"
  iconutil -c iconset "$ROOT/$ICNS" -o "$work/icon.iconset"
  swift "$ROOT/build/celiador/icon-banner.swift" --keep-alpha "$1" "$2" "$work/icon.iconset"/*.png
  iconutil -c icns "$work/icon.iconset" -o "$ROOT/$ICNS"
  rm -rf "$work"
}

case "$CHANNEL" in
  prod)
    restore
    echo "product.json + icon: prod (committed values)"
    ;;
  dev|test)
    restore
    node -e '
      const fs = require("fs");
      const [file, overlayFile] = process.argv.slice(1);
      const product = JSON.parse(fs.readFileSync(file, "utf8"));
      const overlay = JSON.parse(fs.readFileSync(overlayFile, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...product, ...overlay }, null, "\t") + "\n");
      console.log(`product.json: ${overlay.celiadorChannel} (${overlay.nameLong}, ${overlay.celiadorDaemonUrl}, quality ${overlay.quality})`);
    ' "$ROOT/product.json" "$ROOT/build/celiador/product.$CHANNEL.json"
    if [[ -z "$LABEL" ]]; then
      LABEL="$(git -C "$ROOT" describe --tags --exact-match 2>/dev/null || git -C "$ROOT" rev-parse --short HEAD)"
    fi
    if [[ "$CHANNEL" == dev ]]; then colour="#c62828"; else colour="#2e7d32"; fi
    stamp_icon "$colour" "$LABEL"
    echo "icon: $LABEL on $colour"
    ;;
  *)
    echo "usage: $0 <dev|test|prod> [label]" >&2
    exit 2
    ;;
esac

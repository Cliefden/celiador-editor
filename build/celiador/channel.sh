#!/usr/bin/env bash
# Celiador: select the build channel before a gulp build (CHANNELS.md).
#
#   build/celiador/channel.sh dev     # product.json = committed prod values + product.dev.json
#   build/celiador/channel.sh test    # … + product.test.json
#   build/celiador/channel.sh prod    # product.json restored from git (the committed values)
#
# A channel is defined entirely by product.json: app identity (name, bundle id,
# data folder, URL protocol), the daemon it talks to, and the update feed it
# polls. The overlays are shallow (top-level keys) and `celiadorChannel` names
# the channel so the release script publishes to the matching environment.
# The committed product.json is always prod; never commit an overlaid one.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHANNEL="${1:-}"

case "$CHANNEL" in
  prod)
    git -C "$ROOT" checkout -- product.json
    echo "product.json: prod (committed values)"
    ;;
  dev|test)
    git -C "$ROOT" checkout -- product.json
    node -e '
      const fs = require("fs");
      const [file, overlayFile] = process.argv.slice(1);
      const product = JSON.parse(fs.readFileSync(file, "utf8"));
      const overlay = JSON.parse(fs.readFileSync(overlayFile, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...product, ...overlay }, null, "\t") + "\n");
      console.log(`product.json: ${overlay.celiadorChannel} (${overlay.nameLong}, ${overlay.celiadorDaemonUrl}, quality ${overlay.quality})`);
    ' "$ROOT/product.json" "$ROOT/build/celiador/product.$CHANNEL.json"
    ;;
  *)
    echo "usage: $0 <dev|test|prod>" >&2
    exit 2
    ;;
esac

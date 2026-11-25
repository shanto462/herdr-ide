#!/bin/sh
# Copies the live IDE layout from your Herdr home into this repo, made safe to share:
# personal launchers are replaced by an empty example, the layout points at Herdr's
# shipped sidebar mods instead of local clones, and nothing is kept unless scan.sh passes.
#
#   scripts/export.sh            # export + scan
#   HERDR_APP_HOME=... scripts/export.sh
set -eu

APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MODS="ide-branches ide-commands ide-home ide-editor ide-editor-menu ide-explorer ide-fileops ide-find ide-git ide-quickopen ide-status ide-tabs ide-titlebar ide-worktrees"

rm -rf "$REPO/mods" "$REPO/layouts"
mkdir -p "$REPO/mods" "$REPO/layouts"
for m in $MODS; do
  rsync -a --exclude '*.d.ts' --exclude 'jsconfig.json' --exclude '.DS_Store' --exclude '*.error' \
    "$APP/mods/$m/" "$REPO/mods/$m/"
done
cp "$REPO/scripts/config.example.js" "$REPO/mods/ide-tabs/config.js"
cp "$APP/layouts/ide.svg" "$REPO/layouts/ide.svg"

python3 - "$APP" "$REPO" <<'PY'
import json, sys
app, repo = sys.argv[1], sys.argv[2]
layout = json.load(open(f"{app}/layouts/ide.json"))
layout.pop("theme", None)          # the person's own theme decides the look
swap = {"trio-spaces": "spaces", "trio-pane": "pane"}
def walk(node):
    if isinstance(node, dict):
        content = node.get("content")
        if isinstance(content, dict) and content.get("mod") in swap:
            content["mod"] = swap[content["mod"]]
        for v in node.values():
            walk(v)
    elif isinstance(node, list):
        for v in node:
            walk(v)
walk(layout)
json.dump(layout, open(f"{repo}/layouts/ide.json", "w"), indent=2)
open(f"{repo}/layouts/ide.json", "a").write("\n")
keys = json.load(open(f"{app}/keys.json"))
json.dump({"layout:ide": keys.get("layout:ide", {})}, open(f"{repo}/keys.json", "w"), indent=2, ensure_ascii=False)
open(f"{repo}/keys.json", "a").write("\n")
PY

for m in $MODS; do herdr-app check "$REPO/mods/$m" >/dev/null 2>&1 || { echo "check failed: $m" >&2; exit 1; }; done
"$REPO/scripts/scan.sh"
echo "exported $(echo $MODS | wc -w | tr -d ' ') mods + layout"

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
MODS="ide-branches ide-commands ide-home ide-outline ide-problems ide-editor ide-editor-menu ide-explorer ide-fileops ide-find ide-git ide-quickopen ide-status ide-tabs ide-titlebar ide-worktrees"

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
layout["traffic_lights"] = [14, 13]  # centered at zoom 1; ide-titlebar re-centers for other zooms
swap = {"trio-spaces": "spaces", "trio-pane": "pane"}
def walk(node):
    if isinstance(node, dict):
        content = node.get("content")
        if node.get("id") == "sidebar":  # ship the default view and width, not this window's
            node.update(active="view-explorer", size={"px": 300})
        if isinstance(content, dict) and content.get("mod") in swap:
            content["mod"] = swap[content["mod"]]
        for v in node.values():
            walk(v)
    elif isinstance(node, list):
        for v in node:
            walk(v)
walk(layout)
# Herdr rewrites the file in its own key order; ship a stable, readable one.
ORDER = ["id", "type", "titlebar", "traffic_lights", "background", "terminal_padding", "preview", "link_handlers",
         "divider", "active", "size", "min", "max", "resizable", "window_drag", "content", "children"]
def tidy(node):
    if isinstance(node, list):
        return [tidy(v) for v in node]
    if not isinstance(node, dict):
        return node
    keys = sorted(node, key=lambda k: ORDER.index(k) if k in ORDER else len(ORDER))
    return {k: tidy(node[k]) for k in keys}
layout = tidy(layout)
json.dump(layout, open(f"{repo}/layouts/ide.json", "w"), indent=2)
open(f"{repo}/layouts/ide.json", "a").write("\n")
keys = json.load(open(f"{app}/keys.json"))
json.dump({"layout:ide": keys.get("layout:ide", {})}, open(f"{repo}/keys.json", "w"), indent=2, ensure_ascii=False)
open(f"{repo}/keys.json", "a").write("\n")
PY

for m in $MODS; do herdr-app check "$REPO/mods/$m" >/dev/null 2>&1 || { echo "check failed: $m" >&2; exit 1; }; done
"$REPO/scripts/scan.sh"
echo "exported $(echo $MODS | wc -w | tr -d ' ') mods + layout"

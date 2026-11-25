#!/bin/sh
# Refuses to pass if anything personal is about to be shared: home or volume paths,
# email addresses, phone numbers, tokens, and any pattern in your private list
# ($HERDR_IDE_PRIVATE, default ~/.config/herdr-ide-publish/private-patterns.txt,
# one case-insensitive regex per line; that file lives outside the repo on purpose).
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PRIVATE="${HERDR_IDE_PRIVATE:-$HOME/.config/herdr-ide-publish/private-patterns.txt}"
cd "$REPO"

FILES=$(git ls-files --cached --others --exclude-standard | grep -v '^scripts/scan.sh$' | grep -v '\.png$' || true)
[ -n "$FILES" ] || { echo "scan: no files"; exit 0; }

fail=0
check() {
  hits=$(echo "$FILES" | tr '\n' '\0' | xargs -0 grep -nIE -i -- "$1" 2>/dev/null || true)
  if [ -n "$hits" ]; then echo "scan: $2" >&2; echo "$hits" | head -20 >&2; fail=1; fi
}
check '/(Users|home|Volumes)/[A-Za-z0-9._-]+' "absolute personal path"
check '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "email address"
check '\+?[0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4,}' "phone-like number"
check '(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})' "token"
if [ -f "$PRIVATE" ]; then
  while IFS= read -r pattern; do
    [ -n "$pattern" ] && check "$pattern" "private pattern: $pattern"
  done < "$PRIVATE"
else
  echo "scan: note: no private pattern list at $PRIVATE" >&2
fi
[ "$fail" = 0 ] && echo "scan: clean ($(echo "$FILES" | wc -l | tr -d ' ') files)"
exit "$fail"

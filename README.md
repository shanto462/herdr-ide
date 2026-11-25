# herdr-ide

A Zed-style IDE layout for [Herdr](https://herdr.dev): one tab strip for terminals, agents **and** files; a file tree that never follows `cd`; and git first, with a branch diff, history and worktree switching that stays in your space.

![IDE](preview.png)

## Features

- **One tab strip.** Files open as Herdr tabs beside your terminal and agent tabs. Split a file next to Claude, and use ⌘W / ctrl-tab / ⌘1–9 the same way everywhere.
- **Fixed project folder per space.** The Explorer, Search, Git and Go to file stay put when you `cd`.
- **Editor pane:**
  - Save with conflict detection, drafts that survive restarts, and live reload while an agent edits.
  - Markdown preview, CSV as a table, images.
  - PDFs as pages, re-rendered on change (nice for LaTeX), and Quick Look for Office files.
- **Git panel:**
  - Stage, unstage, discard, commit and amend.
  - Fetch, pull and push.
  - **Branch diff vs a base branch.**
  - History with per-commit files.
  - Every diff opens as a tab.
  - **Hunk staging:** stage, unstage or discard single hunks, with an Unstaged/Staged switch on each file's diff.
  - Revert single hunks in branch and agent-turn diffs.
- **Branch picker** to switch, create, or compare against a branch.
- **Worktree picker** to switch, create or remove worktrees. It re-roots the IDE, not your space.
- **Agent-turn review.** When an agent finishes working, the Git panel lists the files that turn changed. You can open each change as a diff, or revert one file or the whole turn.
- **Home tab in every space.** Closing every other tab never closes the space, and a new space (⌘N) starts with nothing running.
- **Search and navigation:**
  - Search in files (ripgrep).
  - Go to file (⌘P) with recent files, plus `name:42` / `:42` for lines.
  - An IDE command palette (⌘⇧P).
  - ⌘-click on `path:line` in any terminal.
  - Ln/Col in the status bar.
- **Merge conflicts:** a bar with Accept current / incoming / both, then Save & mark resolved.
- **Blame:** the status bar shows who last changed the cursor's line, and when.
- **Project-wide replace** from the Search view. It skips files with unsaved edits and refuses files that changed meanwhile.
- **Explorer:** a virtualized tree (fast in big repos) with keyboard navigation (↑↓ ←→, Enter, Space, F2, ⌘⌫). Click a breadcrumb to reveal that folder.
- **Review comments for agents:** click any line in a diff to comment on it, then "Send to <agent>". All comments are pasted into that agent's prompt for you to send.
- **Problems** (⌘⇧M): runs the project's TypeScript / ESLint / Ruff / go vet / cargo check and lists the results by file; click one to jump there. It re-runs when you save.
- **Go to symbol** (⌘⇧O): an outline of the file, via universal-ctags when installed, else built-in patterns for JS/TS, Python, Go, Rust, Java/Kotlin/Swift/C#, Ruby, PHP, shell, Markdown and LaTeX.
- **Remote files are editable:** saves go through `hc file write --on <machine>`, with the same changed-on-disk check.
- **Find and replace in a file:**
  - ⌘F to find, ⌥⌘F to replace.
  - Match case, whole word and regex.
  - Replace all is a single undo step.

## Install

Requires Herdr (macOS is the tested platform). Optional tools: `rg`, and `pdftoppm` from poppler (`brew install ripgrep poppler`).

```sh
git clone https://github.com/shanto462/herdr-ide /tmp/herdr-ide
H=~/.config/herdr-app
# Move each mod in whole: a folder that appears without its mod.json gets auto-docked.
mkdir -p "$H/mods-incoming"
for m in /tmp/herdr-ide/mods/ide-*; do
  cp -R "$m" "$H/mods-incoming/" && mv "$H/mods-incoming/$(basename "$m")" "$H/mods/"
done
rmdir "$H/mods-incoming"
cp /tmp/herdr-ide/layouts/ide.json /tmp/herdr-ide/layouts/ide.svg "$H/layouts/"
for m in "$H"/mods/ide-*; do herdr-app check "$m"; done
herdr-app do layout.switch '{"name":"ide"}'
```

Then add the `layout:ide` section from [`keys.json`](keys.json) to your `~/.config/herdr-app/keys.json` (⌘P, ⌘S, ⌘⇧E/G/F). `ctrl-shift-l` cycles layouts, so your current one is one key away.

**Your launchers:** edit `mods/ide-tabs/config.js` to add buttons that start your agents (e.g. `claude`, `codex`) as named tabs. Keep that file when you update.

## Notes

- Mods can't import each other, so every mod carries the same `common.js`.
- The layout uses Herdr's shipped `spaces`, `agents` and `pane` mods.
- [`RECIPE.md`](RECIPE.md) is the full brief, detailed enough to rebuild it from scratch.

## License

MIT

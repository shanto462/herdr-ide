// The IDE's Explorer: the space's PROJECT FOLDER as a tree. It never follows `cd`.
// Single click opens a preview tab, double click keeps it; right click for file actions.
// Drag a file onto a terminal (Claude) to paste its path.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { exec, watchFolder, theme, shared, setShared, openOverlay, pickFolder, checking, run } from "herdr";
import { ACTIVE, activeSpace, project, ensureProject, setRoot, openInEditor, fileTint, relTo } from "./common.js";

const PER_FOLDER = 1000, TOTAL = 8000;
const HIDDEN = new Set([".git", ".DS_Store"]);

async function directory(path, on) {
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 1000 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Can't list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) if (!HIDDEN.has(fields[i + 1])) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

const storeKey = (root) => `open:${root}`;
const loadOpen = (root) => { try { return new Set(JSON.parse(localStorage.getItem(storeKey(root)) ?? "[]")); } catch { return new Set(); } };
const saveOpen = (root, set) => { try { localStorage.setItem(storeKey(root), JSON.stringify([...set])); } catch {} };

export default class Explorer extends View {
  init(_props, cx) {
    this.context = null;
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set();
    this.marks = {}; this.folderMarks = {}; this.ignored = new Set();
    this.scroll = ScrollHandle.new();
    this.afterAt = shared("ide.files.after")?.at;
    this.revealAt = shared("ide.reveal")?.at;
    this.activeKey = null;
    if (checking()) return;
    cx.timer.every(250, (cx) => this.tick(cx));
    cx.timer.every(15000, (cx) => this.refresh(cx));
  }

  // From a timer: work started while drawing never runs.
  tick(cx) {
    const space = activeSpace();
    if (space && !project(space)) { ensureProject(space); return; }
    const p = project();
    const key = p ? `${p.on ?? ""}|${p.path}` : null;
    if (key !== this.context?.key) this.switchTo(p, key, cx);
    this.takeAfter(cx);
    this.takeReveal(cx);
    // Follow the editor: highlight and reveal the file it shows.
    const a = space ? shared(ACTIVE)?.[space.id] : null;
    const activeKey = a?.path ?? null;
    if (activeKey !== this.activeKey) {
      this.activeKey = activeKey;
      if (activeKey && this.root && activeKey.startsWith(this.root + "/")) this.reveal(activeKey, cx, false);
      cx.notify();
    }
  }

  switchTo(p, key, cx) {
    this.watching?.cancel?.();
    this.watching = null;
    this.context = { key, id: Symbol() };
    this.root = p?.path ?? null; this.on = p?.on ?? null;
    this.entries = new Map(); this.pending = new Set();
    this.folders = this.root ? loadOpen(this.root) : new Set();
    this.marks = {}; this.folderMarks = {}; this.ignored = new Set(); this.error = null; this.limited = false; this.loading = false;
    this.refresh(cx);
    cx.notify();
  }

  current(context) { return this.context === context; }

  watch(cx) {
    if (this.on || this.watching || !this.root) return;
    const context = this.context, root = this.root;
    cx.spawn(async (cx) => {
      try {
        while (this.current(context)) {
          this.watching = watchFolder(root);
          const changed = await this.watching;
          this.watching = null;
          if (!this.current(context)) return;
          // .git churn alone (Claude committing, fetches) only changes marks.
          if (changed.length && changed.every((p) => p.includes("/.git/") || p.endsWith("/.git"))) { this.loadMarks(context, cx); continue; }
          this.refresh(cx);
        }
      } catch { this.watching = null; }
    });
  }

  async loadFolder(path, context) {
    const entries = await directory(path ? `${this.root}/${path}` : this.root, this.on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    if (!this.root || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          try { await this.loadFolder(path, context); }
          catch (e) { if (!path) throw e; this.folders.delete(path); this.entries.delete(path); }
        }
        this.error = null;
        this.watch(cx);
      } catch (e) { if (this.current(context)) this.error = String(e.message ?? e); }
      finally { if (this.current(context)) this.loading = false; cx.notify(); }
      this.loadMarks(context, cx);
    });
  }

  loadMarks(context, cx) {
    const cwd = this.root, on = this.on;
    cx.spawn(async (cx) => {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
      const marks = {}, folderMarks = {}, ignored = new Set();
      if (top?.code === 0) {
        const base = top.stdout.trim(), rank = { A: 1, M: 2, D: 2, U: 3 };
        const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
        const skipped = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=normal"], { cwd, on }).catch(() => null);
        for (const entry of (skipped?.code === 0 ? skipped.stdout.split("\0") : []).filter((e) => e.startsWith("!!")).slice(0, TOTAL)) ignored.add(`${base}/${entry.slice(3).replace(/\/$/, "")}`);
        for (const entry of (status?.code === 0 ? status.stdout.split("\0").filter(Boolean) : []).slice(0, TOTAL)) {
          const xy = entry.slice(0, 2), mark = xy === "??" ? "U" : xy.includes("A") ? "A" : xy.includes("U") ? "!" : xy.includes("D") ? "D" : "M";
          let at = `${base}/${entry.slice(3)}`;
          marks[at] = mark;
          while (at.length > base.length && at.includes("/")) {
            at = at.slice(0, at.lastIndexOf("/"));
            const now = folderMarks[at], next = mark === "D" ? "M" : mark;
            if (!now || (rank[next] ?? 1) > (rank[now] ?? 1)) folderMarks[at] = next;
          }
        }
      }
      if (!this.current(context)) return;
      this.marks = marks; this.folderMarks = folderMarks; this.ignored = ignored;
      cx.notify();
    });
  }

  setOpen(path, open, cx) {
    if (open) {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e.message ?? e); }
          finally { if (this.current(context)) this.pending.delete(path); cx.notify(); }
        });
      }
    } else {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) { this.folders.delete(folder); this.entries.delete(folder); }
    }
    saveOpen(this.root, this.folders);
    cx.notify();
  }

  collapseAll(cx) {
    this.folders = new Set();
    for (const k of [...this.entries.keys()]) if (k) this.entries.delete(k);
    saveOpen(this.root, this.folders);
    cx.notify();
  }

  // Opens the folders above a file and scrolls to it.
  reveal(abs, cx, scroll = true) {
    if (!this.root || !abs.startsWith(this.root + "/")) return;
    const parts = relTo(this.root, abs).split("/");
    parts.pop();
    let at = "";
    for (const part of parts) { at = at ? `${at}/${part}` : part; if (!this.folders.has(at)) this.setOpen(at, true, cx); }
    this.scrollTo = relTo(this.root, abs);
    this.scrollTries = scroll ? 8 : 4;
  }

  takeReveal(cx) {
    const r = shared("ide.reveal");
    if (!r || r.at === this.revealAt) return;
    this.revealAt = r.at;
    this.reveal(r.path, cx, true);
  }

  takeAfter(cx) {
    const after = shared("ide.files.after");
    if (!after || after.at === this.afterAt) return;
    this.afterAt = after.at;
    if (after.root !== this.root) return;
    if (after.moved) {
      const { from, to } = after.moved;
      this.folders = new Set([...this.folders].map((f) => (f === from || f.startsWith(`${from}/`) ? to + f.slice(from.length) : f)));
      this.entries = new Map([...this.entries].filter(([f]) => f !== from && !f.startsWith(`${from}/`)));
    }
    if (after.expand) after.expand.split("/").reduce((at, part) => { const next = at ? `${at}/${part}` : part; this.folders.add(next); return next; }, "");
    saveOpen(this.root, this.folders);
    this.loading = false;
    this.refresh(cx);
    if (after.send) this.sendToClaude(after.send, cx);
  }

  // The prompt fills in through a borrowed clipboard; nothing is submitted.
  sendToClaude({ tab, terminal, text }, cx) {
    const before = cx.read_from_clipboard();
    cx.write_to_clipboard(text);
    run("tab.select", { id: tab });
    run("pane.focus", { terminal });
    cx.timer.after(250, (cx) => {
      run("terminal.paste");
      cx.timer.after(700, (cx) => { if (before !== undefined) cx.write_to_clipboard(before); });
    });
  }

  menu(rel, dir) {
    openOverlay({ mod: "ide-fileops", kind: "popup", width: 230, props: { mode: "menu", root: this.root, on: this.on, rel, dir, space: activeSpace()?.id } });
  }

  dialog(action) {
    if (!this.root) return;
    openOverlay({ mod: "ide-fileops", kind: "dialog", width: 420, props: { mode: "name", action, root: this.root, on: this.on, rel: "", dir: true, space: activeSpace()?.id } });
  }

  openFolder(cx) {
    const space = activeSpace();
    if (!space) return;
    cx.spawn(async () => {
      const folder = await pickFolder({ prompt: "Open folder as this space's project" });
      if (folder) setRoot(space.id, folder, null);
    });
  }

  rows(prefix, depth, out, t, inIgnored = false) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), abs = `${this.root}/${path}`;
      const ignored = inIgnored || this.ignored.has(abs), mark = ignored ? null : entry.dir ? this.folderMarks[abs] : this.marks[abs];
      const color = ignored ? t.dim : mark === "U" || mark === "A" ? t.ansi2 : mark === "D" || mark === "!" ? t.ansi1 : mark ? t.blocked : null;
      const selected = !entry.dir && abs === this.activeKey;
      const loading = entry.dir && open && this.pending.has(path);
      out.push(h_flex().id(`f-${path}`).h(24).flex_none().pl(6 + depth * 14).pr(8).gap(5).items_center().cursor_pointer()
        .when(selected, (e) => e.bg(t.selected)).when(!selected, (e) => e.hover((s) => s.bg(t.hover)))
        .drag_paths([abs], { on: this.on })
        .on_click((e, cx) => {
          if (entry.dir) this.setOpen(path, !open, cx);
          else openInEditor({ path: abs, on: this.on, rel: path, preview: e.click_count < 2 });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(path, entry.dir); })
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim) : div().w(11).flex_none())
        .child(entry.dir
          ? svg("mods/files/folder.svg").size(14).flex_none().text_color(color ?? t.muted)
          : div().w(14).flex_none().flex().justify_center().child(div().size(7).rounded(2).bg(ignored ? t.dim : fileTint(entry.name, t))))
        .child(div().flex_1().min_w(0).truncate().text_color(color ?? (selected ? t.foreground : t.foreground)).child(entry.name))
        .when(loading, (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(10).spin(900).text_color(t.dim)))
        .when(Boolean(mark) && !entry.dir, (e) => e.child(div().w(12).flex_none().text_size(10.5).text_color(color).child(mark)))
        .when(Boolean(mark) && entry.dir, (e) => e.child(div().size(6).flex_none().rounded(3).bg(color))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t, ignored);
    }
    return out;
  }

  tool(id, tip, icon, action, t) {
    return div().id(id).p(4).rounded(5).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => action(cx)).child(svg(icon).size(13));
  }

  render(cx) {
    const t = theme(), p = project();
    const rows = this.root ? this.rows("", 0, [], t) : [];
    // Scroll requests run after layout; keep asking for a few frames while folders load.
    if (this.scrollTo) {
      const index = this.flatIndex(this.scrollTo);
      if (index >= 0) { this.scroll.scroll_to_item(index); this.scrollTo = null; }
      else if (--this.scrollTries <= 0) this.scrollTo = null;
    }
    return v_flex().id("ide-explorer").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.8)
      .child(h_flex().h(34).flex_none().pl(14).pr(8).gap(2).items_center()
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("EXPLORER"))
        .child(this.tool("ex-new-file", "New file", "mods/workspace-chrome/square-pen.svg", () => this.dialog("file"), t))
        .child(this.tool("ex-new-folder", "New folder", "mods/workspace-chrome/folder-plus.svg", () => this.dialog("folder"), t))
        .child(this.tool("ex-refresh", "Refresh", "mods/workspace-chrome/clock.svg", (cx) => { this.loading = false; this.refresh(cx); }, t))
        .child(this.tool("ex-collapse", "Collapse folders", "mods/workspace-chrome/minus.svg", (cx) => this.collapseAll(cx), t)))
      .child(h_flex().id("ex-project").h(26).flex_none().px(10).gap(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(p ? `${p.path}\nFixed project folder: it doesn't follow cd. Click to choose another.` : "Choose a folder")
        .on_click((_e, cx) => this.openFolder(cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (this.root) this.menu("", true); })
        .child(svg("mods/files/chevron-down.svg").size(11).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold().child((p?.name ?? "No folder").toUpperCase()))
        .when(Boolean(p?.on), (e) => e.child(div().text_size(10.5).text_color(t.accent).child(p.on))))
      .child(v_flex().id("ex-tree").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).pb(10)
        .on_mouse_down("right", () => { if (this.root) this.menu("", true); })
        .children(rows)
        .when(!p, (e) => e.child(v_flex().p(14).gap(10).text_color(t.dim)
          .child(div().child("This space has no project folder yet."))
          .child(div().id("ex-pick").h(28).px(12).flex().items_center().justify_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).cursor_pointer().on_click((_e, cx) => this.openFolder(cx)).child("Open Folder…"))))
        .when(Boolean(p) && (Boolean(this.error) || !this.entries.get("")?.length), (e) => e.child(div().p(12).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading…" : "Empty folder"))))
        .when(Boolean(this.limited), (e) => e.child(div().p(10).text_size(11).text_color(t.dim).child("Showing the first 1,000 entries per folder"))));
  }

  // The row index of a path in the flattened tree, or -1 while it isn't loaded yet.
  flatIndex(target) {
    let i = 0, found = -1;
    const walk = (prefix) => {
      for (const entry of this.entries.get(prefix) ?? []) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (path === target) { found = i; return true; }
        i++;
        if (entry.dir && this.folders.has(path) && walk(path)) return true;
      }
      return false;
    };
    walk("");
    return found;
  }
}

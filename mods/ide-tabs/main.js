import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, theme, window, layout, settings, exec, hc, notify, shared, setShared, setWindowTitle, setBadge, checking, nextCommand, pickFolder } from "herdr";
import { SHORTCUTS, SAVED, USAGE, ACCOUNT_LABEL } from "./config.js";
import { project, activeSpace, relTo, languageName, fileTint, closeTab, sh, setRoot, OPEN, ACTIVE, FILETABS, DIRTY, GOTO, RECENT, TURNS, paper, isGlass } from "./common.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const WARN_AT = 10; // percent left

// Usage reset times drift by a fraction of a second between reads, so they're rounded.
const windowInfo = (w) => {
  if (!w?.known) return null;
  const at = new Date(w.resets_at).getTime();
  return { left: Math.max(0, 100 - w.percent), resets: Math.round(at / 60000) * 60000, key: String(Math.round(at / 3600000)) };
};
function resetsIn(at) {
  const minutes = Math.max(0, Math.round((at - Date.now()) / 60000));
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${rest}m` : `${rest}m`;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.opened = shared("trio.open")?.at;
    // From a timer, not render: work started while drawing never runs.
    cx.timer.every(400, (cx) => this.takeRequest(cx));
    this.usage = {};
    this.loadUsage(cx);
    cx.timer.every(60000, (cx) => this.loadUsage(cx));
    // Files open as Herdr tabs (an ide-editor pane each), next to terminals and agents.
    this.lastOpen = shared(OPEN)?.at;
    this.hoverTab = null;
    cx.timer.every(150, (cx) => this.files(cx));
    this.agentState = {}; this.turnStarts = {}; this.homePending = new Set();
    this.launchAt = shared("ide.launch")?.at;
    if (!checking()) {
      cx.timer.every(1500, (cx) => this.ensureHomes(cx));
      cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); if (c === "new_space") this.newSpace(cx); cx.notify(); } });
    }
    if (!checking()) cx.timer.every(700, (cx) => this.trackTurns(cx));
  }

  // A fresh read every minute.
  loadUsage(cx) {
    cx.spawn(async cx => {
      try {
        if (!USAGE) return;
        const r = await exec(USAGE.cmd, USAGE.args);
        if (r.code !== 0) return;
        const next = {};
        for (const a of JSON.parse(r.stdout)) next[a.name] = { hour: windowInfo(a.limits?.five_hour), week: windowInfo(a.limits?.weekly) };
        this.warn(next);
        if (JSON.stringify(next) !== JSON.stringify(this.usage)) { this.usage = next; cx.notify(); }
      } catch {}
    });
  }

  // One toast per account and limit, per reset period, remembered across restarts.
  warn(usage) {
    const warned = { ...(shared("trio.usageWarned") ?? {}) };
    let changed = false;
    for (const [name, limits] of Object.entries(usage)) for (const [label, w] of [["5-hour", limits.hour], ["weekly", limits.week]]) {
      if (!w || w.left > WARN_AT) continue;
      const id = `${name}:${label}:${w.key}`;
      if (warned[id]) continue;
      warned[id] = true; changed = true;
      notify({ title: `${name} is almost out`, body: `${w.left}% of its ${label} limit left, resets in ${resetsIn(w.resets)}`, level: "warning" });
    }
    if (changed) setShared("trio.usageWarned", warned);
  }

  meter(name, t) {
    const u = this.usage[name];
    if (!u || (!u.hour && !u.week)) return null;
    const color = (left) => left > 25 ? t.done : left > WARN_AT ? t.blocked : t.ansi1;
    const bar = (w) => div().w(24).h(3).rounded(2).overflow_hidden().bg(t.border).when(Boolean(w), el => el.child(div().h_full().rounded(2).w(Math.max(1, Math.round(24 * w.left / 100))).bg(color(w.left))));
    const lowest = Math.min(u.hour?.left ?? 100, u.week?.left ?? 100);
    return h_flex().gap(4).items_center()
      .child(v_flex().gap(2).flex_none().child(bar(u.hour)).child(bar(u.week)))
      .when(lowest <= 25, el => el.child(div().text_size(10.5).text_color(color(lowest)).child(`${lowest}%`)));
  }

  usageText(name) {
    const u = this.usage[name];
    if (!u) return null;
    const line = (label, w) => `${label}: ${w ? `${w.left}% left, resets in ${resetsIn(w.resets)}` : "not started"}`;
    return `${line("5-hour", u.hour)} · ${line("Weekly", u.week)}`;
  }

  // Runs one app command and returns what it made.
  async doIt(name, args) {
    const r = await exec("herdr-app", ["do", name, JSON.stringify(args)]);
    if (r.code !== 0) throw new Error(r.stdout || r.stderr);
    return JSON.parse(r.stdout);
  }

  // Jumps to this tab, starting it only if the space doesn't have one yet.
  goTo(name, command, cx) {
    const space = spaces().find(p => p.active);
    if (!space || this.starting) return;
    const existing = space.tabs.find(t => t.name === name);
    if (existing) { run("tab.select", { id: existing.id }); return; }
    const folder = panes().find(p => p.focused)?.cwd ?? space.folder;
    this.starting = name;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const made = await this.doIt("tab.new", { name, space: space.id, folder, ...(command ? { argv: [command] } : {}) });
        if (command) await hc(["label", made.terminal, `${ACCOUNT_LABEL}=${name}`]);
        // Keeps the fixed order, so cmd-1..4 mean the same thing in every space.
        const earlier = SHORTCUTS.slice(0, SHORTCUTS.findIndex(s => s.name === name)).filter(s => space.tabs.some(t => t.name === s.name)).length;
        run("tab.move", { id: made.tab, index: earlier + 1 });
      } catch (e) { notify({ title: `Could not start ${name}`, body: String(e), level: "error" }); }
      finally { this.starting = null; cx.notify(); }
    });
  }

  // ---- Spaces start empty: just their Home tab, nothing running. ----
  homeOf(space) {
    const ids = new Set(space.tabs.map((t) => t.id));
    return panes().find((p) => p.mod === "ide-home" && ids.has(p.tab))?.tab ?? null;
  }

  // Every space keeps a Home tab, last in order: closing all other tabs never closes it.
  ensureHomes(cx) {
    if (this.starting) return; // a space being opened gets its Home from restore()
    for (const space of spaces()) {
      const ids = new Set(space.tabs.map((t) => t.id));
      const homes = [...new Set(panes().filter((p) => p.mod === "ide-home" && ids.has(p.tab)).map((p) => p.tab))];
      for (const extra of homes.slice(1)) run("tab.close", { id: extra, confirmed: true });
      const home = homes[0] ?? null;
      if (home) {
        const at = space.tabs.findIndex((t) => t.id === home);
        if (at !== space.tabs.length - 1) run("tab.move", { id: home, index: space.tabs.length });
        continue;
      }
      if (this.homePending.has(space.id)) continue;
      this.homePending.add(space.id);
      cx.spawn(async () => {
        try { await this.doIt("tab.new", { name: "Home", space: space.id, mod: "ide-home", focus: false }); }
        catch {} finally { this.homePending.delete(space.id); }
      });
    }
  }

  // A new space on a folder with only its Home tab (no shell, no agents).
  restore(folder, cx) {
    if (this.starting) return;
    this.starting = folder;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const made = await this.doIt("space.new", { folder, machine: "" });
        const home = await this.doIt("tab.new", { name: "Home", space: made.space, mod: "ide-home" });
        run("tab.close", { id: made.tab, confirmed: true });
        run("tab.select", { id: home.tab });
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder }).catch(() => null);
        setRoot(made.space, top?.code === 0 ? top.stdout.trim() : folder, null);
      } catch (e) { notify({ title: "Could not open the space", body: String(e), level: "error" }); }
      finally { this.starting = null; cx.notify(); }
    });
  }

  newSpace(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Open a folder as a new space" });
      if (!folder) return;
      const open = spaces().find((x) => x.folder === folder || shared("ide.roots")?.[x.id]?.path === folder);
      if (open) run("space.select", { id: open.id }); else this.restore(folder, cx);
    });
  }

  // Unsaved file tabs ask first (save / don't save / cancel); clean ones just close.
  closeFile(c, uid, e, isDirty) {
    if (!isDirty) { closeTab(c.id); return; }
    openOverlay({ mod: "ide-editor-menu", kind: "dialog", width: 400, props: { mode: "close", uid, tab: c.id, name: e.path.split("/").pop() } });
  }

  // ---- Agent turns: what each agent changed between starting and stopping work. ----
  // A snapshot is the working tree written to a throwaway index (the real index is
  // never touched): `git add -A` into a copy of it, then `git write-tree`.
  snapshot(cwd, on) {
    return sh('top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || exit 3; cd "$top" || exit 3; idx=$(mktemp); cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || rm -f "$idx"; GIT_INDEX_FILE="$idx" git add -A >/dev/null 2>&1; tree=$(GIT_INDEX_FILE="$idx" git write-tree) || exit 4; rm -f "$idx"; printf "%s\t%s" "$top" "$tree"', [cwd], { on, timeout: 60000 })
      .then((r) => (r.code === 0 ? { top: r.stdout.split("\t")[0], tree: r.stdout.split("\t")[1].trim() } : null)).catch(() => null);
  }

  trackTurns(cx) {
    for (const a of agents()) {
      const was = this.agentState[a.address];
      this.agentState[a.address] = a.status;
      if (was === undefined || was === a.status) continue;
      const pane = panes().find((p) => p.pane === a.pane), space = spaces().find((x) => x.id === a.space);
      if (!pane?.cwd || !space) continue;
      const on = space.machine ?? null;
      if (a.status === "working") {
        const started = { at: Date.now(), pending: this.snapshot(pane.cwd, on) };
        this.turnStarts[a.address] = started;
      } else if (was === "working") {
        const start = this.turnStarts[a.address];
        delete this.turnStarts[a.address];
        if (start) cx.spawn(async () => this.finishTurn(a, space, pane.cwd, on, start));
      }
    }
  }

  async finishTurn(a, space, cwd, on, start) {
    const before = await start.pending, after = await this.snapshot(cwd, on);
    if (!before || !after || before.tree === after.tree || before.top !== after.top) return;
    const git = (args) => exec("git", ["--no-optional-locks", ...args], { cwd: after.top, on });
    const [names, nums] = await Promise.all([
      git(["diff", "--name-status", "-z", "--no-renames", before.tree, after.tree]),
      git(["diff", "--numstat", "-z", "--no-renames", before.tree, after.tree]),
    ]);
    const stat = {};
    for (const entry of nums.stdout.split("\0")) { const [x, y, ...rest] = entry.split("\t"); if (rest.length) stat[rest.join("\t")] = { add: +x || 0, del: +y || 0 }; }
    const parts = names.stdout.split("\0"), files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) files.push({ path: parts[i + 1], mark: parts[i][0], ...(stat[parts[i + 1]] ?? {}) });
    if (!files.length) return;
    const who = a.program?.name ?? "Agent", where = a.tab_name;
    const turn = { id: `${a.address}-${start.at}`, agent: who, tab: where, terminal: a.address, top: after.top, on, before: before.tree, after: after.tree, files, at: Date.now(), started: start.at };
    setShared(TURNS, { ...(shared(TURNS) ?? {}), [space.id]: [turn, ...(shared(TURNS)?.[space.id] ?? [])].slice(0, 20) });
    notify({ title: `${who} changed ${files.length} file${files.length === 1 ? "" : "s"}`, body: `${where} · review them in the Git panel`, level: "info", timeout: 6000,
      action: { name: "layout.select", args: { stack: "sidebar", child: "view-git" } } });
  }

  // Opens what ide.open asks for: the file's tab if it has one, else a new tab, last
  // (so cmd-1..4 stay the accounts). A preview (single click) replaces the previous
  // clean preview tab in place.
  files(cx) {
    const reg = shared(FILETABS) ?? {}, dirty = shared(DIRTY) ?? {}, all = spaces();
    // Forget tabs that were closed; pin previews that got edited.
    if (all.length) {
      let next = null;
      for (const [uid, e] of Object.entries(reg)) {
        const sp = all.find((x) => x.id === e.space);
        if (!sp || !sp.tabs.some((t) => t.id === e.tab)) { next ??= { ...reg }; delete next[uid]; }
        else if (e.preview && dirty[uid]) { next ??= { ...reg }; next[uid] = { ...e, preview: false }; }
      }
      if (next) setShared(FILETABS, next);
    }
    this.syncActive();
    const launch = shared("ide.launch");
    if (launch && launch.at !== this.launchAt) { this.launchAt = launch.at; const sc = SHORTCUTS.find((x) => x.name === launch.name); if (sc) this.goTo(sc.name, sc.command, cx); }
    const sp = activeSpace();
    const launchers = SHORTCUTS.map((x) => ({ name: x.name, label: x.label, open: Boolean(sp?.tabs.some((t) => t.name === x.name)) }));
    if (JSON.stringify(launchers) !== JSON.stringify(shared("ide.launchers") ?? [])) setShared("ide.launchers", launchers);
    const req = shared(OPEN);
    if (!req || req.at === this.lastOpen || this.opening) return;
    this.lastOpen = req.at;
    const space = all.find((x) => x.id === req.space) ?? activeSpace();
    if (!space || !req.path) return;
    const kind = req.kind ?? "file", ref = kind === "diff" ? req.ref ?? "" : "", on = req.on ?? null;
    const hit = Object.entries(reg).find(([, e]) => e.space === space.id && space.tabs.some((t) => t.id === e.tab) && e.kind === kind && e.path === req.path && (e.ref ?? "") === ref && (e.on ?? null) === on);
    if (!space.active) run("space.select", { id: space.id });
    if (hit) {
      const [uid, e] = hit;
      if (!req.preview && e.preview) setShared(FILETABS, { ...reg, [uid]: { ...e, preview: false } });
      run("tab.select", { id: e.tab });
      if (req.line) setShared(GOTO, { uid, line: req.line, column: req.column ?? 1, at: `${Date.now()}-${Math.random()}` });
      return;
    }
    const prev = req.preview ? Object.entries(reg).find(([u, e]) => e.space === space.id && e.preview && !dirty[u] && space.tabs.some((t) => t.id === e.tab)) : null;
    const uid = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const name = req.path.split("/").pop();
    const label = kind !== "diff" ? name : ref.startsWith("commit:") ? `${name} @${ref.slice(7, 14)}` : ref.startsWith("base:") ? `${name} ↔ ${ref.slice(5)}` : ref.startsWith("turn:") ? `${name} (agent turn)` : `${name} (diff)`;
    const entry = { space: space.id, kind, path: req.path, on, rel: req.rel ?? null, root: req.root ?? null, ref, preview: Boolean(req.preview) };
    this.opening = true;
    cx.spawn(async (cx) => {
      try {
        const made = await this.doIt("tab.new", { name: label, space: space.id, mod: "ide-editor", props: { uid, ...entry, line: req.line ?? null, column: req.column ?? null } });
        setShared(FILETABS, { ...(shared(FILETABS) ?? {}), [uid]: { ...entry, tab: made.tab } });
        // Files always go after every other tab, so cmd-1..4 keep meaning the accounts.
        const tabsNow = spaces().find((x) => x.id === space.id)?.tabs ?? [];
        const index = prev ? tabsNow.findIndex((t) => t.id === prev[1].tab) : -1;
        if (prev) run("tab.close", { id: prev[1].tab, confirmed: true });
        run("tab.move", { id: made.tab, index: index >= 0 ? index + 1 : tabsNow.length });
        const home = this.homeOf(space);
        if (home) run("tab.move", { id: home, index: tabsNow.length - (prev ? 1 : 0) });
        run("tab.select", { id: made.tab });
      } catch (e) { notify({ title: `Could not open ${name}`, body: String(e.message ?? e), level: "error" }); }
      finally { this.opening = false; cx.notify(); }
    });
  }

  // What the shown tab's file is, for the title bar, status bar and Explorer.
  syncActive() {
    const space = activeSpace();
    if (!space) return;
    const tab = space.tabs.find((t) => t.active);
    const reg = shared(FILETABS) ?? {}, dirty = shared(DIRTY) ?? {};
    const hit = Object.entries(reg).find(([, e]) => e.tab === tab?.id);
    const value = hit ? { uid: hit[0], kind: hit[1].kind, path: hit[1].path, on: hit[1].on, rel: hit[1].rel ?? relTo(project()?.path, hit[1].path), language: hit[1].kind === "diff" ? "Diff" : languageName(hit[1].path.split("/").pop()), dirty: Boolean(dirty[hit[0]]) } : null;
    const was = shared(ACTIVE)?.[space.id] ?? null;
    if (JSON.stringify(was) !== JSON.stringify(value)) {
      setShared(ACTIVE, { ...(shared(ACTIVE) ?? {}), [space.id]: value });
      if (value?.kind === "file") {
        const list = (shared(RECENT)?.[space.id] ?? []).filter((r) => r.path !== value.path);
        setShared(RECENT, { ...(shared(RECENT) ?? {}), [space.id]: [{ path: value.path, on: value.on, rel: value.rel }, ...list].slice(0, 30) });
      }
    }
    // The OS window title follows the shown file; the Dock badge counts blocked agents.
    const title = value ? `${value.rel ?? value.path.split("/").pop()} — ${project()?.name ?? space.name}` : `${project()?.name ?? space.name} — Herdr`;
    if (title !== this.title) { this.title = title; setWindowTitle(title); }
    const blocked = agents().filter((a) => a.status === "blocked").length;
    if (blocked !== this.badge) { this.badge = blocked; setBadge(blocked ? String(blocked) : null); }
  }

  // The sidebar's + asks for a folder and leaves it in shared "trio.open".
  takeRequest(cx) {
    const request = shared("trio.open");
    if (!request || request.at === this.opened) return;
    this.opened = request.at;
    const open = spaces().find(p => p.folder === request.folder);
    if (open) run("space.select", { id: open.id });
    else this.restore(request.folder, cx);
  }

  // One tab strip for everything in this space: terminals, agents AND files. The same account
  // launchers from config.js (names, order, labels, usage meters), and
  // dock controls.
  render() {
    const t = theme(), glass = isGlass(t);
    const space = spaces().find(p => p.active);
    // Glass: tabs are floating pills; solid themes: a flat strip with an accent top line.
    const shape = (el) => glass ? el.h(26).rounded_full().border_1().border_color("#00000000") : el.h_full();
    const lit = (el) => glass ? el.bg(t.raised).border_color(t.border).shadow_sm().text_color(t.foreground) : el.bg(paper(t)).border_t_2().border_color(t.accent).text_color(t.foreground);
    const homeTab = space ? this.homeOf(space) : null;
    const shown = (space?.tabs ?? []).filter((c) => c.id !== homeTab);
    const homeActive = Boolean(homeTab && space.tabs.find((c) => c.id === homeTab)?.active);
    const stop = (_e, cx) => cx.stop_propagation();
    const icon = (id, path, tip, action, on = false) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(on ? t.foreground : t.dim).when(on, el => el.bg(t.selected)).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", stop).on_click(action).child(svg(path).size(13));
    const reg = shared(FILETABS) ?? {}, dirty = shared(DIRTY) ?? {};
    const fileOf = (tabId) => Object.entries(reg).find(([, e]) => e.tab === tabId) ?? null;
    const fileItem = (c, i, [uid, e]) => {
      const name = e.path.split("/").pop(), isDirty = Boolean(dirty[uid]), hovered = this.hoverTab === c.id;
      return h_flex().id(`tab-${c.id}`).pl(10).pr(5).gap(6).items_center().flex_none().text_size(12.3).map(shape)
        .when(c.active, lit)
        .when(!c.active, el => el.text_color(t.muted).hover(s => s.bg(t.hover)))
        .tooltip(e.path)
        .on_hover((h, cx) => { const next = h ? c.id : this.hoverTab === c.id ? null : this.hoverTab; if (next !== this.hoverTab) { this.hoverTab = next; cx.notify(); } })
        .on_mouse_down("left", (ev, cx) => { cx.stop_propagation(); this.pressed = i; if (ev.click_count === 2 && e.preview) setShared(FILETABS, { ...reg, [uid]: { ...e, preview: false } }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("middle", () => this.closeFile(c, uid, e, isDirty))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "ide-editor-menu", kind: "popup", width: 240, height: isDirty ? 412 : 356, props: { uid, tab: c.id, space: space.id, path: e.path, on: e.on, kind: e.kind, rel: e.rel ?? relTo(project()?.path, e.path), root: e.root, dirty: isDirty } }); })
        .child(e.kind === "diff" ? svg("mods/workspace-chrome/git-compare.svg").size(12).flex_none().text_color(t.blocked) : div().size(8).flex_none().rounded(2).bg(fileTint(name, t)))
        .child(div().max_w(200).truncate().when(Boolean(e.preview), el => el.italic()).child(c.name))
        .child(div().id(`close-${c.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(4).hover(s => s.bg(t.raised))
          .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); this.closeFile(c, uid, e, isDirty); })
          .child(isDirty && !hovered ? div().size(7).rounded(4).bg(c.active ? t.foreground : t.muted) : (c.active || hovered) ? svg("mods/pane/close.svg").size(10).text_color(t.dim) : div()));
    };
    const item = (c, i) => {
      const file = fileOf(c.id);
      if (file) return fileItem(c, i, file);
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).pl(10).pr(5).gap(6).items_center().flex_none().text_size(12.3).map(shape)
        .on_hover((h, cx) => { const next = h ? c.id : this.hoverTab === c.id ? null : this.hoverTab; if (next !== this.hoverTab) { this.hoverTab = next; cx.notify(); } })
        .when(c.active, lit)
        .when(!c.active, el => el.text_color(t.muted).hover(s => s.bg(t.hover)))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("middle", () => run("tab.close", { id: c.id }))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(13).text_color(t.muted) : image(program.icon).size(13)))
        .child(div().max_w(160).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .child(div().id(`close-${c.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(4).hover(s => s.bg(t.raised))
          .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); })
          .child(c.active || this.hoverTab === c.id ? svg("mods/pane/close.svg").size(10).text_color(t.dim) : div()));
    };
        const textButton = (id, label, on, action) => h_flex().id(id).h(24).px(7).gap(5).flex_none().items_center().rounded(5)
      .text_size(11.8).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop).on_click(action).child(label);
    const p = project();
    return h_flex().size_full().min_w(0).pr(6).gap(2).items_center().when(!glass, (e) => e.bg(t.chrome).border_b(1).border_color(t.border))
      .on_mouse_up("left", () => { this.pressed = null; })
      .when(Boolean(homeTab), (el) => el.child(div().id("tab-home").w(34).flex_none().flex().items_center().justify_center().map(shape).when(glass, (e) => e.ml(4))
        .when(homeActive, lit)
        .when(!homeActive, (e) => e.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .tooltip("Home").on_mouse_down("left", stop).on_click(() => run("tab.select", { id: homeTab }))
        .child(svg("mods/ide-explorer/icons/home.svg").size(14))))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().when(glass, (e) => e.gap(3).px(3)).overflow_x_scrollbar().children(shown.map(item))
        .child(div().id("tab-new").size(24).ml(4).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(p ? `New terminal in ${p.name}` : "New terminal").on_mouse_down("left", stop)
          .on_click(() => run("tab.new", p && !p.on ? { space: space?.id, folder: p.path } : {}))
          .child(svg("mods/workspace-chrome/plus.svg").size(13)))
        .child(div().id("tab-new-menu").size(24).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("New terminal or agent…").on_mouse_down("left", stop).on_click(() => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }))
          .child(svg("mods/files/chevron-down.svg").size(11))))
      .children(SAVED.filter(folder => !spaces().some(p => p.folder === folder)).map(folder =>
        textButton(`saved-${folder}`, this.starting === folder ? "Opening…" : `Open ${folder.split("/").pop()}`, false, (_e, cx) => this.restore(folder, cx))))
      .when(Boolean(space) && !space.machine, el => el.children(SHORTCUTS.map(({ name, label, command }) =>
        textButton(`go-${name}`, h_flex().gap(6).items_center().child(this.starting === name ? "Starting…" : label).when(Boolean(this.meter(name, t)), el => el.child(this.meter(name, t))), shown.some(c => c.active && c.name === name), (_e, cx) => this.goTo(name, command, cx))
          .when(Boolean(this.usageText(name)), el => el.tooltip(this.usageText(name))))))
      .child(div().w(1).h(16).mx(4).bg(t.border))
      .child(icon("split-r", "mods/pane/split-right.svg", "Split right", () => run("pane.split", { direction: "right" })))
      .child(icon("split-d", "mods/pane/split-down.svg", "Split down", () => run("pane.split", { direction: "down" })));
  }
}

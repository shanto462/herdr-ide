// Zed-style status bar. Left: the left dock's views (click to show, click again to
// hide), then branch and sync state. Right: the file the shown tab holds.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, layout, run, shared, setShared, agents, openOverlay, checking, nextCommand, exec } from "herdr";
import { activeSpace, project, findNode, SCM, ACTIVE, CURSOR } from "./common.js";

const VIEWS = [
  { child: "view-explorer", icon: "mods/workspace-chrome/files.svg", tip: "Project (⌘⇧E)" },
  { child: "view-git", icon: "mods/workspace-chrome/git-branch.svg", tip: "Git (⌘⇧G)" },
  { child: "view-search", icon: "mods/workspace-chrome/search.svg", tip: "Search (⌘⇧F)" },
  { child: "view-problems", icon: "mods/ide-explorer/icons/problems.svg", tip: "Problems (⌘⇧M)" },
  { child: "view-spaces", icon: "mods/workspace-chrome/layers.svg", tip: "Spaces" },
  { child: "view-agents", icon: "mods/ide-explorer/icons/bot.svg", tip: "Agents" },
];

export function showView(child, keep = false) {
  const root = layout(), sidebar = findNode(root, "sidebar");
  if (!keep && sidebar && !sidebar.hidden && sidebar.active === child) { run("layout.hide", { id: "sidebar" }); return; }
  run("layout.select", { stack: "sidebar", child });
  run("layout.show", { id: "sidebar" });
}

export default class Status extends View {
  init(_props, cx) {
    this.blame = null;
    if (checking()) return;
    cx.timer.every(700, (cx) => this.updateBlame(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "explorer") { showView("view-explorer", true); setShared("ide.explorer.focus", Date.now()); }
        else if (c === "git") showView("view-git", true);
        else if (c === "problems") showView("view-problems", true);
        else if (c === "goto_line") openOverlay({ mod: "ide-quickopen", kind: "popup", width: 680, height: 560, props: { line: true } });
        else if (c === "search") { showView("view-search", true); setShared("ide.find.focus", Date.now()); }
        cx.notify();
      }
    });
  }

  // Who last changed the cursor's line: "author, 3 days ago · subject".
  updateBlame(cx) {
    const space = activeSpace(), a = space ? shared(ACTIVE)?.[space.id] : null, cur = shared(CURSOR);
    const key = a?.kind === "file" && !a.on && cur?.uid === a.uid ? `${a.path}:${cur.line}:${a.dirty}` : null;
    if (key === this.blameKey) return;
    this.blameKey = key;
    if (!key || a.dirty) { if (this.blame) { this.blame = null; cx.notify(); } return; }
    const dir = a.path.slice(0, a.path.lastIndexOf("/"));
    cx.spawn(async (cx) => {
      const r = await exec("git", ["--no-optional-locks", "blame", "--porcelain", "-L", `${cur.line},${cur.line}`, "--", a.path], { cwd: dir }).catch(() => null);
      if (this.blameKey !== key) return;
      if (!r || r.code !== 0) { this.blame = null; cx.notify(); return; }
      const get = (k) => (new RegExp(`^${k} (.*)$`, "m").exec(r.stdout) ?? [])[1] ?? "";
      const sha = r.stdout.slice(0, 40);
      if (/^0{40}$/.test(sha)) this.blame = { text: "Not committed yet", tip: "" };
      else {
        const days = Math.round((Date.now() / 1000 - Number(get("author-time"))) / 86400);
        const when = days < 1 ? "today" : days === 1 ? "yesterday" : days < 60 ? `${days} days ago` : `${Math.round(days / 30)} months ago`;
        this.blame = { text: `${get("author")}, ${when}`, tip: `${sha.slice(0, 8)} · ${get("author")} · ${get("summary")}` };
      }
      cx.notify();
    });
  }

  render() {
    const t = theme(), root = layout(), sidebar = findNode(root, "sidebar");
    const space = activeSpace(), scm = space ? shared(SCM)?.[space.id] : null, active = space ? shared(ACTIVE)?.[space.id] : null, p = project();
    const all = agents(), blocked = all.filter((a) => a.status === "blocked").length;
    const stop = (_e, cx) => cx.stop_propagation();
    const btn = (id, child, tip, action, on = false) => h_flex().id(id).h(20).px(5).gap(4).flex_none().items_center().rounded(4).cursor_pointer()
      .text_color(on ? t.foreground : t.dim).when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", stop).on_click(action).child(child);
    const badge = (n, color) => div().px(4).rounded(6).bg(color).text_size(9.5).text_color(t.background).child(String(n));
    return h_flex().id("ide-status").size_full().min_w(0).px(6).gap(2).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5)
      .children(VIEWS.map((v) => {
        const on = sidebar && !sidebar.hidden && sidebar.active === v.child;
        const probs = space ? shared("ide.problems")?.[space.id] : null;
        const extra = v.child === "view-git" && scm?.count ? badge(scm.count, t.blocked) : v.child === "view-agents" && blocked ? badge(blocked, t.blocked)
          : v.child === "view-problems" && (probs?.errors || probs?.warnings) ? badge(probs.errors || probs.warnings, probs.errors ? t.ansi1 : t.blocked) : null;
        return btn(`sv-${v.child}`, h_flex().gap(3).items_center().child(svg(v.icon).size(13)).when(Boolean(extra), (e) => e.child(extra)), v.tip, () => showView(v.child), on);
      }))
      .child(div().w(1).h(12).mx(4).bg(t.border))
      .when(Boolean(scm?.branch), (e) => e.child(btn("s-branch", h_flex().gap(4).items_center()
        .child(svg("mods/workspace-chrome/git-branch.svg").size(12)).child(div().max_w(220).truncate().child(scm.branch))
        .when(Boolean(scm.ahead), (x) => x.child(div().child(`↑${scm.ahead}`))).when(Boolean(scm.behind), (x) => x.child(div().child(`↓${scm.behind}`))),
        "Switch branch", () => openOverlay({ mod: "ide-branches", kind: "popup", width: 460, height: 520, props: { mode: "switch" } }))))
      .when(Boolean(scm?.base), (e) => e.child(div().text_color(t.dim).text_size(11).child(`vs ${scm.base}`)))
      .when(Boolean(p?.on), (e) => e.child(div().px(5).text_color(t.accent).child(`⇄ ${p.on}`)))
      .child(div().flex_1())
      .when(Boolean(active), (e) => e
        .child(div().max_w(420).truncate().text_color(t.dim).child(active.rel ?? ""))
        .when(Boolean(active.dirty), (x) => x.child(div().text_color(t.blocked).child("● unsaved")))
        .when(Boolean(this.blame), (x) => x.child(div().id("s-blame").max_w(320).truncate().px(5).text_color(t.dim).tooltip(this.blame.tip || this.blame.text).child(this.blame.text)))
        .when(Boolean(active.uid) && shared(CURSOR)?.uid === active.uid, (x) => x.child(btn("s-cursor", div().child(`Ln ${shared(CURSOR).line}, Col ${shared(CURSOR).column}`), "Go to line (⌃G)", () => openOverlay({ mod: "ide-quickopen", kind: "popup", width: 680, height: 560, props: { line: true } }))))
        .child(div().px(6).text_color(t.muted).child(active.language ?? "")))
      .child(div().w(1).h(12).mx(4).bg(t.border))
      .child(btn("s-cmds", div().child("⌘⇧P"), "IDE commands", () => run("mod.open", { name: "ide-commands" })));
  }
}

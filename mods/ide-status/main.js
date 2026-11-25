// Zed-style status bar. Left: the left dock's views (click to show, click again to
// hide), then branch and sync state. Right: the file the shown tab holds.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, layout, run, shared, setShared, agents, openOverlay, checking, nextCommand } from "herdr";
import { activeSpace, project, findNode, SCM, ACTIVE } from "./common.js";

const VIEWS = [
  { child: "view-explorer", icon: "mods/workspace-chrome/files.svg", tip: "Project (⌘⇧E)" },
  { child: "view-git", icon: "mods/workspace-chrome/git-branch.svg", tip: "Git (⌘⇧G)" },
  { child: "view-search", icon: "mods/workspace-chrome/search.svg", tip: "Search (⌘⇧F)" },
  { child: "view-spaces", icon: "mods/workspace-chrome/layers.svg", tip: "Spaces" },
  { child: "view-agents", icon: "mods/workspace-chrome/monitor.svg", tip: "Agents" },
];

export function showView(child, keep = false) {
  const root = layout(), sidebar = findNode(root, "sidebar");
  if (!keep && sidebar && !sidebar.hidden && sidebar.active === child) { run("layout.hide", { id: "sidebar" }); return; }
  run("layout.select", { stack: "sidebar", child });
  run("layout.show", { id: "sidebar" });
}

export default class Status extends View {
  init(_props, cx) {
    if (checking()) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "explorer") showView("view-explorer", true);
        else if (c === "git") showView("view-git", true);
        else if (c === "search") { showView("view-search", true); setShared("ide.find.focus", Date.now()); }
        cx.notify();
      }
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
        const extra = v.child === "view-git" && scm?.count ? badge(scm.count, t.blocked) : v.child === "view-agents" && blocked ? badge(blocked, t.blocked) : null;
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
        .child(div().px(6).text_color(t.muted).child(active.language ?? "")))
      .child(div().w(1).h(12).mx(4).bg(t.border))
      .child(btn("s-cmds", div().child("⌘⇧P"), "Command palette", () => run("app.palette")));
  }
}

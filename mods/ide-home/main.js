// A space's Home tab. Every space keeps one (ide-tabs makes sure), so closing every
// terminal, agent and file tab never closes the space, and a new space starts with
// nothing running. Shows the project, quick actions, your launchers, agents in this
// space, recent agent changes and recent files.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, shared, setShared, agents, openOverlay, settings } from "herdr";
import { activeSpace, project, openInEditor, RECENT, TURNS, SCM, FIND_FOCUS } from "./common.js";

const view = (child) => { run("layout.select", { stack: "sidebar", child }); run("layout.show", { id: "sidebar" }); };

export default class Home extends View {
  card(title, children, t) {
    return v_flex().w_full().gap(6).p(14).rounded(10).border_1().border_color(t.border).bg(t.chrome)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(title))
      .children(children);
  }

  action(id, label, key, onClick, t) {
    return h_flex().id(id).h(30).px(10).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick)
      .child(div().flex_1().child(label))
      .when(Boolean(key), (e) => e.child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).font_family(settings().font_family ?? "JetBrains Mono").child(key)));
  }

  row(id, left, right, onClick, t) {
    return h_flex().id(id).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick)
      .child(div().flex_1().min_w(0).truncate().child(left))
      .when(Boolean(right), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(right)));
  }

  render() {
    const t = theme(), space = activeSpace(), p = project(), scm = space ? shared(SCM)?.[space.id] : null;
    const recent = space ? (shared(RECENT)?.[space.id] ?? []).slice(0, 10) : [];
    const turns = space ? (shared(TURNS)?.[space.id] ?? []).slice(0, 5) : [];
    const mine = agents().filter((a) => a.space === space?.id);
    const launchers = shared("ide.launchers") ?? [];
    const ago = (at) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
    const dot = (status) => div().size(7).flex_none().rounded(4).bg(t[status] ?? t.idle);

    return div().id("ide-home").size_full().overflow_y_scrollbar().bg(t.background).text_color(t.foreground).text_size(13)
      .child(v_flex().w_full().max_w(980).mx_auto().px(32).py(36).gap(18)
        .child(v_flex().gap(4)
          .child(div().text_size(26).font_semibold().child(p?.name ?? space?.name ?? "Home"))
          .child(h_flex().gap(10).text_size(12).text_color(t.dim)
            .child(div().truncate().child(p?.path ?? "No project folder yet"))
            .when(Boolean(scm?.branch), (e) => e.child(h_flex().gap(4).items_center().child(svg("mods/workspace-chrome/git-branch.svg").size(12)).child(div().child(scm.branch))))
            .when(Boolean(scm?.count), (e) => e.child(div().text_color(t.blocked).child(`${scm.count} changed`)))))
        .child(h_flex().w_full().gap(18).items_start()
          .child(v_flex().flex_1().gap(18)
            .child(this.card("START", [
              this.action("h-open", "Go to file", "⌘P", () => run("mod.open", { name: "ide-quickopen" }), t),
              this.action("h-search", "Search in files", "⌘⇧F", () => { view("view-search"); setShared(FIND_FOCUS, Date.now()); }, t),
              this.action("h-git", "Source control", "⌘⇧G", () => view("view-git"), t),
              this.action("h-cmds", "All commands", "⌘⇧P", () => run("mod.open", { name: "ide-commands" }), t),
              this.action("h-term", "New terminal here", "", () => run("tab.new", p && !p.on ? { space: space?.id, folder: p.path } : {}), t),
              this.action("h-branch", "Switch branch or worktree…", "", () => openOverlay({ mod: "ide-worktrees", kind: "popup", width: 520, height: 460 }), t),
            ], t))
            .when(launchers.length > 0, (e) => e.child(this.card("AGENTS & TERMINALS", [
              h_flex().flex_wrap().gap(8).children(launchers.map((l) => h_flex().id(`h-l-${l.name}`).h(30).px(12).gap(6).items_center().rounded(7).cursor_pointer()
                .border_1().border_color(l.open ? t.accent : t.border).bg(l.open ? t.selected : t.background).hover((s) => s.bg(t.hover))
                .on_click(() => setShared("ide.launch", { name: l.name, at: `${Date.now()}` }))
                .child(div().child(l.label)).when(l.open, (x) => x.child(div().text_size(10.5).text_color(t.dim).child("open"))))),
            ], t)))
            .when(mine.length > 0, (e) => e.child(this.card("RUNNING IN THIS SPACE", mine.map((a) =>
              this.row(`h-a-${a.address}`, h_flex().gap(8).items_center().child(dot(a.status)).child(div().child(`${a.program?.name ?? "Agent"} · ${a.tab_name}`)), a.status, () => run("agent.focus", { terminal: a.address }), t)), t))))
          .child(v_flex().flex_1().gap(18)
            .when(turns.length > 0, (e) => e.child(this.card("RECENT AGENT CHANGES", turns.map((x) =>
              this.row(`h-t-${x.id}`, `${x.agent} · ${x.tab}: ${x.files.length} file${x.files.length === 1 ? "" : "s"}`, ago(x.at), () => view("view-git"), t)), t)))
            .child(this.card("RECENT FILES", recent.length ? recent.map((r) =>
              this.row(`h-r-${r.path}`, r.rel ?? r.path.split("/").pop(), "", () => openInEditor({ path: r.path, on: r.on, rel: r.rel }), t))
              : [div().px(8).text_size(12).text_color(t.dim).child("Files you open show up here.")], t)))));
  }
}

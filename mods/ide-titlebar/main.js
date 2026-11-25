// Zed-style title bar: project ▾ · branch ▾ · worktree ▾ on the left, a command
// field in the middle, agent status and dock toggles on the right. Drag to move the window.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, window, layout, settings, run, openOverlay, shared, agents, checking } from "herdr";
import { project, activeSpace, findNode, SCM, ACTIVE, isGlass } from "./common.js";

// macOS draws its window buttons at fixed screen points (the layout's traffic_lights)
// while this bar scales with zoom, so keep them centered in the bar at every zoom.
const BUTTON_H = 14, BUTTON_SPAN = 64;

export default class Titlebar extends View {
  init(_props, cx) {
    if (checking()) return;
    cx.timer.after(300, () => this.placeLights());
    cx.timer.every(1000, () => this.placeLights());
  }

  placeLights() {
    const w = window(), root = layout(), bar = findNode(root, "titlebar");
    if (w?.platform !== "macos" || !root || bar?.content?.mod !== "ide-titlebar") return;
    const zoom = settings()?.zoom ?? 1, x = root.traffic_lights?.[0] ?? 14;
    const y = Math.max(3, Math.round(((bar.size?.px ?? 40) * zoom - BUTTON_H) / 2));
    if (root.traffic_lights?.[1] !== y) run("layout.set", { layout: { ...root, traffic_lights: [x, y] } });
  }

  render() {
    const t = theme(), w = window(), root = layout();
    const space = activeSpace(), p = project(), scm = space ? shared(SCM)?.[space.id] : null;
    const active = space ? shared(ACTIVE)?.[space.id] : null;
    const stop = (_e, cx) => cx.stop_propagation(), glass = isGlass(t);
    // Glass: related controls sit together in one floating capsule, like macOS toolbars.
    const group = (id, kids) => glass
      ? h_flex().id(id).h(32).px(3).gap(1).flex_none().items_center().rounded_full().bg(t.raised).border_1().border_color(t.border).shadow_sm().children(kids)
      : h_flex().id(id).gap(2).flex_none().items_center().children(kids);
    const lights = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen
      ? ((root?.traffic_lights?.[0] ?? 14) + BUTTON_SPAN) / (settings()?.zoom ?? 1) : 10;
    const chip = (id, children, tip, action, strong = false) => h_flex().id(id).h(26).px(8).gap(6).flex_none().items_center().map((e) => glass ? e.rounded_full() : e.rounded(6)).cursor_pointer()
      .text_color(strong ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", stop).on_click(action).children(children);
    const toggle = (id, icon, tip, nodeId) => {
      const node = findNode(root, nodeId), on = node && !node.hidden;
      return div().id(id).size(26).flex_none().flex().items_center().justify_center().map((e) => glass ? e.rounded_full() : e.rounded(6)).cursor_pointer()
        .text_color(on ? t.foreground : t.dim).hover((s) => s.bg(t.hover)).tooltip(tip)
        .on_mouse_down("left", stop).on_click(() => run("layout.toggle", { id: nodeId })).child(svg(icon).size(15));
    };
    const all = agents();
    const working = all.filter((a) => a.status === "working").length, blocked = all.filter((a) => a.status === "blocked").length, done = all.filter((a) => a.status === "done").length;
    return h_flex().id("ide-titlebar").size_full().min_w(0).pl(lights).pr(8).gap(2).items_center().text_size(12.8)
      .child(group("tb-left-group", [
        chip("tb-project", [div().font_semibold().max_w(220).truncate().child(p?.name ?? space?.name ?? "No project"), svg("mods/files/chevron-down.svg").size(10).text_color(t.dim)],
        p ? `${p.path}\nSwitch space` : "Switch space", () => openOverlay({ mod: "ide-spaces", kind: "popup", width: 500, height: 470 }), true),
        scm?.branch ? chip("tb-branch", [
        svg("mods/workspace-chrome/git-branch.svg").size(13).text_color(t.accent),
        div().max_w(260).truncate().child(scm.branch),
        scm.ahead ? div().text_size(11).text_color(t.dim).child(`↑${scm.ahead}`) : null,
        scm.behind ? div().text_size(11).text_color(t.dim).child(`↓${scm.behind}`) : null,
        svg("mods/files/chevron-down.svg").size(10).text_color(t.dim),
      ].filter(Boolean), "Switch branch", () => openOverlay({ mod: "ide-branches", kind: "popup", width: 460, height: 520, props: { mode: "switch" } })) : null,
        scm?.branch ? chip("tb-worktree", [svg("mods/ide-explorer/icons/worktree.svg").size(13), div().text_size(12).child("worktrees")],
        "Switch worktree (stays in this space)", () => openOverlay({ mod: "ide-worktrees", kind: "popup", width: 520, height: 460 })) : null,
      ].filter(Boolean)))
      .child(h_flex().flex_1().min_w(0).justify_center()
        .child(h_flex().id("tb-cmd").w(420).max_w_full().h(glass ? 30 : 26).px(12).gap(8).items_center().border_1().border_color(t.border).cursor_pointer()
          .map((e) => glass ? e.rounded_full().bg(t.raised).shadow_sm() : e.rounded(7).bg(t.background))
          .text_color(t.dim).hover((s) => s.border_color(t.input))
          .on_mouse_down("left", stop).on_click(() => run("mod.open", { name: "ide-quickopen" }))
          .child(svg("mods/workspace-chrome/search.svg").size(13))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(active?.rel ? `${p?.name ?? ""} — ${active.rel}` : `Search ${p?.name ?? "files"}…`))
          .child(div().text_size(11).child("⌘P"))))
      .child(group("tb-right-group", [
        working + blocked + done > 0 ? chip("tb-agents", [
        working ? h_flex().gap(4).items_center().child(svg("mods/workspace-chrome/spinner.svg").size(11).spin(900).text_color(t.working)).child(div().text_size(11.5).child(String(working))) : null,
        blocked ? h_flex().gap(4).items_center().child(div().size(7).rounded(4).bg(t.blocked)).child(div().text_size(11.5).child(String(blocked))) : null,
        done ? h_flex().gap(4).items_center().child(div().size(7).rounded(4).bg(t.done)).child(div().text_size(11.5).child(String(done))) : null,
      ].filter(Boolean), "Agents", () => { run("layout.select", { stack: "sidebar", child: "view-agents" }); run("layout.show", { id: "sidebar" }); }) : null,
        toggle("tb-left", "mods/workspace-chrome/panel-left.svg", "Toggle left dock (⌘B)", "sidebar"),
      ].filter(Boolean)))
      .when(Boolean(w?.buttons), (e) => e
        .child(div().id("w-min").size(26).flex().items_center().justify_center().rounded(6).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => run("window.minimize")).child("−"))
        .child(div().id("w-max").size(26).flex().items_center().justify_center().rounded(6).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => run("window.maximize")).child("□"))
        .child(div().id("w-close").size(26).flex().items_center().justify_center().rounded(6).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => run("window.close")).child(svg("mods/pane/close.svg").size(12))));
  }
}

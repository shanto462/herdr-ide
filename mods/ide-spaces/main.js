// Space switcher popup (the project button in the title bar). Picking a space switches
// to it; the sidebar keeps whatever view it was showing.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { props, closeOverlay, theme, run, spaces, shared, home } from "herdr";
import { ROOTS } from "./common.js";

// The sidebar's spaces list keeps each space's color in shared "space.colors"; reuse it.
const TINTS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
const tintOf = (s) => shared("space.colors")?.[s.id] ?? TINTS[[...s.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length];

export default class Spaces extends View {
  init(_props, cx) {
    this.query = "";
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Switch to space…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value().toLowerCase(); this.at = this.query ? 0 : Math.max(0, spaces().findIndex((s) => s.active)); cx.notify(); });
    this.input.on("submit", () => this.pick(this.list()[this.at ?? 0]));
    this.input.focus();
    cx.timer.after(150, () => this.input.focus());
    // The keyboard cursor starts on the current space.
    this.at = Math.max(0, spaces().findIndex((s) => s.active));
  }

  dismiss() { const o = props()?.overlay; if (o) closeOverlay(o); else run("mod.open", { name: "ide-spaces" }); }

  list() {
    const roots = shared(ROOTS) ?? {};
    const all = spaces().map((s) => ({ ...s, root: roots[s.id]?.path ?? s.folder ?? "" }));
    if (!this.query) return all;
    return all.filter((s) => `${s.name} ${s.branch ?? ""} ${s.root} ${s.machine ?? ""}`.toLowerCase().includes(this.query));
  }

  pick(s) {
    if (!s) return;
    if (!s.active) run("space.select", { id: s.id });
    this.dismiss();
  }

  newSpace() { this.dismiss(); run("ide-tabs.new_space"); }

  render() {
    const t = theme(), items = this.list(), stop = (_e, cx) => cx.stop_propagation();
    const at = Math.min(this.at ?? 0, Math.max(0, items.length - 1));
    return v_flex().id("ide-spaces").size_full().min_h(0).p(8).gap(6).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.dismiss();
        else if (e.key === "down") this.at = Math.min(items.length - 1, at + 1);
        else if (e.key === "up") this.at = Math.max(0, at - 1);
        else return;
        this.scroll.scroll_to_item(this.at ?? 0);
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().px(6).h(24).items_center().gap(6)
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(`SPACES · ${spaces().length}`))
        .child(div().id("sp-new").flex_none().px(7).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("New space from a folder (⌘N)")
          .on_mouse_down("left", stop).on_click(() => this.newSpace()).child("+ New space…"))
        .child(div().id("sp-close").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close (Esc)")
          .on_mouse_down("left", stop).on_click(() => this.dismiss()).child(svg("mods/pane/close.svg").size(11))))
      .child(h_flex().h(34).flex_none().px(10).gap(8).items_center().rounded(7).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(13).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(v_flex().id("sp-list").h(340).flex_none().overflow_y_scrollbar().track_scroll(this.scroll)
        .children(items.map((s, i) => {
          const tabs = s.tabs.filter((x) => !x.settled).length;
          // Keyboard cursor: selected fill. Current space: accent bar on the left.
          return h_flex().id(`sp-${s.id}`).h(46).flex_none().pl(7).pr(10).gap(10).items_center().rounded(7).cursor_pointer()
            .border_l_3().border_color(s.active ? t.accent : "#00000000")
            .when(i === at, (e) => e.bg(t.selected)).when(i !== at, (e) => e.hover((x) => x.bg(t.hover)))
            .on_click(() => this.pick(s))
            .child(div().size(24).flex_none().flex().items_center().justify_center().rounded(6).bg(t[tintOf(s)])
              .text_size(12).font_semibold().text_color(t.background).child((s.name[0] ?? "?").toUpperCase()))
            .child(v_flex().flex_1().min_w(0)
              .child(h_flex().gap(6).min_w(0).items_center()
                .child(div().min_w(0).truncate().font_medium().child(s.name))
                .when(s.active, (e) => e.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child("current")))
                .when(Boolean(s.machine), (e) => e.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(s.machine))))
              .child(div().truncate().text_size(10.5).text_color(t.dim).child(s.root ? s.root.replace(home(), "~") : "no folder")))
            .when(Boolean(s.branch), (e) => e.child(h_flex().flex_none().max_w(150).gap(4).items_center().text_size(11).text_color(t.muted)
              .child(svg("mods/workspace-chrome/git-branch.svg").size(11).text_color(t.accent))
              .child(div().truncate().child(s.branch))))
            .when(s.status === "working", (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)))
            .when(s.status === "blocked" || s.status === "done", (e) => e.child(div().size(7).flex_none().rounded(4).bg(t[s.status])))
            .child(div().flex_none().w(44).text_right().text_size(10.5).text_color(t.dim).child(`${tabs} tab${tabs === 1 ? "" : "s"}`))
            .when(i < 9, (e) => e.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(`⌃${i + 1}`)));
        }))
        .when(!items.length, (e) => e.child(div().p(10).text_color(t.dim).child("No matching space"))));
  }
}

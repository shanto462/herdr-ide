// Go to symbol in file (⌘⇧O in an editor). Props: { uid, name, items: [{ name, kind, line, depth }] }.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { props, closeOverlay, theme, setShared } from "herdr";
import { GOTO } from "./common.js";

const KIND = { function: "ƒ", method: "m", class: "C", type: "T", impl: "I", heading: "#", section: "§", subsection: "§", subsubsection: "§", chapter: "§", part: "§", paragraph: "¶", command: "\\" };

export default class Outline extends View {
  init(_props, cx) {
    this.query = ""; this.at = 0;
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: `Go to symbol in ${props()?.name ?? "file"}…` });
    this.input.on("change", (_e, cx) => { this.query = this.input.value().toLowerCase(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.go(this.list()[this.at]));
    this.input.focus();
    cx.timer.after(150, () => this.input.focus());
  }

  dismiss() { closeOverlay(props().overlay); }
  list() {
    const items = props()?.items ?? [];
    if (!this.query) return items;
    return items.filter((s) => { let at = 0; for (const ch of this.query) { at = s.name.toLowerCase().indexOf(ch, at); if (at < 0) return false; at++; } return true; });
  }
  go(s) {
    if (!s) return;
    setShared(GOTO, { uid: props().uid, line: s.line, column: 1, at: `${Date.now()}` });
    this.dismiss();
  }

  render() {
    const t = theme(), items = this.list();
    return v_flex().id("ide-outline").w_full().p(8).gap(6).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.dismiss();
        else if (e.key === "down") this.at = Math.min(items.length - 1, this.at + 1);
        else if (e.key === "up") this.at = Math.max(0, this.at - 1);
        else return;
        this.scroll.scroll_to_item(this.at);
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(34).flex_none().px(10).items_center().rounded(7).border_1().border_color(t.accent).bg(t.background)
        .child(div().w(18).text_color(t.dim).child("@"))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(v_flex().id("ol-list").h(440).flex_none().overflow_y_scrollbar().track_scroll(this.scroll)
        .children(items.map((s, i) => h_flex().id(`ol-${i}`).h(28).flex_none().pl(8 + (this.query ? 0 : s.depth * 16)).pr(10).gap(8).items_center().rounded(6).cursor_pointer()
          .when(i === this.at, (e) => e.bg(t.selected)).hover((x) => x.bg(t.hover))
          .on_click(() => this.go(s))
          .child(div().w(16).flex_none().text_center().text_size(11).font_semibold().text_color(s.kind === "class" || s.kind === "type" ? t.ansi3 : s.kind.includes("section") || s.kind === "heading" ? t.ansi4 : t.ansi5).child(KIND[s.kind] ?? "•"))
          .child(div().flex_1().min_w(0).truncate().child(s.name))
          .child(div().text_size(11).text_color(t.dim).child(`${s.kind} · ${s.line}`))))
        .when(!items.length, (e) => e.child(div().p(10).text_color(t.dim).child((props()?.items ?? []).length ? "No matching symbol" : "No symbols found in this file"))));
  }
}

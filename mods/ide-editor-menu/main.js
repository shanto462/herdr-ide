// File-tab menu, and the "unsaved changes" prompt.
// Props: { uid, tab, space, path, on, kind, rel, root, dirty, overlay } for the menu,
//        { mode: "close", uid, tab, name, overlay } for the prompt.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, openOverlay, theme, exec, shared, setShared, run } from "herdr";
import { editorCommand, openInEditor, project, closeTab, FILETABS, REVEAL } from "./common.js";

export default class EditorMenu extends View {
  init(_props, cx) { this.handle = cx.focus_handle(); this.handle.focus(); this.at = 0; }
  dismiss() { closeOverlay(props().overlay); }

  items() {
    const p = props() ?? {};
    const local = !p.on, page = p.kind === "changes"; // a Git page (compare, commit, history), not a file
    const fileTabs = () => Object.entries(shared(FILETABS) ?? {}).filter(([, e]) => e.space === p.space);
    return [
      ["Close", () => p.dirty ? openOverlay({ mod: "ide-editor-menu", kind: "dialog", width: 400, props: { mode: "close", uid: p.uid, tab: p.tab, name: p.path.split("/").pop() } }) : closeTab(p.tab), "⌘W"],
      ["Close other files", () => { for (const [, e] of fileTabs()) if (e.tab !== p.tab) closeTab(e.tab); }],
      ["Close all files", () => { for (const [, e] of fileTabs()) closeTab(e.tab); }],
      "-",
      !page && ["File history", () => openInEditor({ kind: "changes", path: p.root ?? project()?.path ?? p.path, on: p.on, ref: `log:${p.path}` })],
      page ? null : p.kind === "diff" ? ["Open file", () => openInEditor({ path: p.path, on: p.on, rel: p.rel })] : ["Open changes", () => openInEditor({ kind: "diff", path: p.path, on: p.on, root: p.root ?? project()?.path, rel: p.rel })],
      ["Split terminal below", () => { run("tab.select", { id: p.tab }); run("pane.split", { direction: "down" }); }],
      p.dirty && ["Save", () => editorCommand("save", p.uid), "⌘S"],
      p.dirty && ["Revert", () => editorCommand("revert", p.uid)],
      "-",
      !page && ["Copy path", (cx) => cx.write_to_clipboard(p.path)],
      !page && ["Copy relative path", (cx) => cx.write_to_clipboard(p.rel)],
      !page && ["Reveal in Explorer", () => { setShared(REVEAL, { path: p.path, at: Date.now() }); run("layout.select", { stack: "sidebar", child: "view-explorer" }); run("layout.show", { id: "sidebar" }); }],
      local && !page && ["Reveal in Finder", () => exec("open", ["-R", p.path])],
    ].filter(Boolean).filter((item, i, all) => item !== "-" || (i > 0 && all[i - 1] !== "-" && i < all.length - 1));
  }

  button(id, text, kind, action, t) {
    const primary = kind === "primary", danger = kind === "danger";
    return h_flex().id(id).h(30).px(14).items_center().rounded(7).border_1().border_color(primary ? t.solid : t.input).cursor_pointer().text_size(12.5)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground)
      .hover((s) => s.opacity(0.88)).on_click(() => { action(); this.dismiss(); }).child(text);
  }

  prompt(t) {
    const p = props();
    const save = () => editorCommand("save_close", p.uid), drop = () => editorCommand("discard_close", p.uid);
    return v_flex().id("ide-close-prompt").track_focus(this.handle).w_full().p(18).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.dismiss();
        else if (e.key === "enter") { save(); this.dismiss(); }
        else return;
        cx.stop_propagation();
      })
      .child(div().text_size(15).font_semibold().child(`Save changes to ${p.name}?`))
      .child(div().text_color(t.muted).child("Your changes will be lost if you don't save them."))
      .child(h_flex().gap(8).justify_end()
        .child(this.button("cp-drop", "Don't save", "danger", drop, t))
        .child(this.button("cp-cancel", "Cancel", "plain", () => {}, t))
        .child(this.button("cp-save", "Save  ⏎", "primary", save, t)));
  }

  render(cx) {
    const t = theme();
    if (props()?.mode === "close") return this.prompt(t);
    const items = this.items(), actionable = items.map((x, i) => (x === "-" ? -1 : i)).filter((i) => i >= 0);
    if (!actionable.includes(this.at)) this.at = actionable[0];
    const runItem = (item, cx) => { item[1](cx); this.dismiss(); };
    return v_flex().id("ide-editor-menu").track_focus(this.handle).w_full().p(5).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .on_key_down((e, cx) => {
        const k = actionable.indexOf(this.at);
        if (e.key === "escape") this.dismiss();
        else if (e.key === "down") this.at = actionable[(k + 1) % actionable.length];
        else if (e.key === "up") this.at = actionable[(k - 1 + actionable.length) % actionable.length];
        else if (e.key === "enter") runItem(items[this.at], cx);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .children(items.map((item, i) => item === "-"
        ? div().h(1).mx(4).my(4).flex_none().bg(t.border)
        : h_flex().id(`em-${i}`).h(28).px(9).flex_none().items_center().rounded(6).cursor_pointer()
          .when(i === this.at, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_hover((h, cx) => { if (h && this.at !== i) { this.at = i; cx.notify(); } })
          .on_click((_e, cx) => runItem(item, cx))
          .child(div().flex_1().truncate().child(item[0]))
          .when(Boolean(item[2]), (e) => e.child(div().text_size(11).text_color(t.dim).child(item[2])))));
  }
}

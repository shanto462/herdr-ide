// Right-click menu for a file tab. Props: { uid, tab, space, path, on, kind, rel, root, dirty, overlay }.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, exec, shared, setShared, run } from "herdr";
import { editorCommand, openInEditor, project, FILETABS } from "./common.js";

export default class EditorMenu extends View {
  init(_props, cx) { this.handle = cx.focus_handle(); this.handle.focus(); }
  close() { closeOverlay(props().overlay); }

  items() {
    const p = props() ?? {};
    const local = !p.on;
    const fileTabs = () => Object.entries(shared(FILETABS) ?? {}).filter(([, e]) => e.space === p.space);
    return [
      ["Close", () => run("tab.close", { id: p.tab, confirmed: true })],
      ["Close other files", () => { for (const [, e] of fileTabs()) if (e.tab !== p.tab) run("tab.close", { id: e.tab, confirmed: true }); }],
      ["Close all files", () => { for (const [, e] of fileTabs()) run("tab.close", { id: e.tab, confirmed: true }); }],
      "-",
      p.kind === "diff" ? ["Open file", () => openInEditor({ path: p.path, on: p.on, rel: p.rel })] : ["Open changes", () => openInEditor({ kind: "diff", path: p.path, on: p.on, root: project()?.path, rel: p.rel })],
      ["Split terminal below", () => { run("tab.select", { id: p.tab }); run("pane.split", { direction: "down" }); }],
      p.dirty && ["Save", () => editorCommand("save", p.uid)],
      p.dirty && ["Revert", () => editorCommand("revert", p.uid)],
      "-",
      ["Copy path", (cx) => cx.write_to_clipboard(p.path)],
      ["Copy relative path", (cx) => cx.write_to_clipboard(p.rel)],
      ["Reveal in Explorer", () => { setShared("ide.reveal", { path: p.path, at: Date.now() }); run("layout.select", { stack: "sidebar", child: "view-explorer" }); run("layout.show", { id: "sidebar" }); }],
      local && ["Reveal in Finder", () => exec("open", ["-R", p.path])],
    ].filter(Boolean).filter((item, i, all) => item !== "-" || (i > 0 && all[i - 1] !== "-" && i < all.length - 1));
  }

  render() {
    const t = theme();
    return v_flex().id("ide-editor-menu").track_focus(this.handle).w_full().p(5).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .children(this.items().map((item, i) => item === "-"
        ? div().h(1).mx(4).my(4).flex_none().bg(t.border)
        : h_flex().id(`em-${i}`).h(28).px(9).flex_none().items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.selected)).on_click((_e, cx) => { item[1](cx); this.close(); }).child(div().truncate().child(item[0]))));
  }
}

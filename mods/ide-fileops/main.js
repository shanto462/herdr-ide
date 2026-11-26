// The Files panel's actions. Props: { mode: "menu" | "name" | "trash", root, on,
// rel ("" = the root folder), dir, action ("file" | "folder" | "rename"), space }.
// Tells the Explorer what to do next through shared "ide.files.after"; tells the editor
// about moves and deletes through shared "ide.fs".
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, openOverlay, theme, exec, shared, setShared, notify, run, panes, spaces, terminals } from "herdr";
import { parent, join, checkName, newFile, newFolder, move, copyInto, trash, discard } from "./ops.js";
import { FS, openInEditor, setRoot } from "./common.js";

const CLIP = "ide.files.clipboard";

export default class FileOps extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (p.mode === "name") {
      const value = p.action === "rename" ? p.rel.split("/").pop() : "";
      this.input = InputState.new({ value });
      const dot = value.lastIndexOf(".");
      if (value) this.input.set_selected_range({ start: 0, end: !p.dir && dot > 0 ? dot : value.length });
      this.input.on("submit", (_e, cx) => this.submit(cx));
      this.input.focus();
      cx.timer.after(200, () => this.input.focus());
    }
  }

  abs(rel) { const { root } = props(); return rel ? `${root}/${rel}` : root; }
  close() { closeOverlay(props().overlay); }
  after(what) { setShared("ide.files.after", { ...what, root: props().root, at: Date.now() }); }

  // The folder that new things and pastes go into.
  inside() { const p = props(); return p.dir ? p.rel : parent(p.rel); }

  dialog(mode, action) {
    const { overlay: _o, ...p } = props();
    this.close();
    openOverlay({ mod: "ide-fileops", kind: "dialog", width: 420, props: { ...p, mode, action } });
  }

  // Runs one action from the menu, keeping the popup alive until it has finished.
  work(cx, action) {
    cx.spawn(async () => {
      try { await action(); }
      catch (e) { notify({ title: "File action failed", body: String(e.message ?? e), level: "error" }); }
      finally { this.close(); }
    });
  }

  copyText(cx, text) { cx.write_to_clipboard(text); this.close(); }

  paste(cx) {
    const { on } = props(), clip = shared(CLIP), into = this.inside();
    this.work(cx, async () => {
      if (clip.cut) {
        const dest = `${this.abs(into)}/${clip.name}`;
        await move(exec, clip.path, dest, on);
        this.repoint(clip.path, dest);
        setShared(CLIP, null);
      } else await copyInto(exec, clip.path, this.abs(into), on);
      this.after({ expand: into });
    });
  }

  items() {
    const p = props() ?? {}, target = Boolean(p.rel), local = !p.on, abs = p.root ? this.abs(p.rel) : "", clip = shared(CLIP);
    const canPaste = clip && (clip.on ?? null) === (p.on ?? null);
    return [
      target && !p.dir && ["Open", () => { openInEditor({ path: abs, on: p.on ?? null, rel: p.rel }); this.close(); }],
      target && !p.dir && ["Open changes", () => { openInEditor({ kind: "diff", path: abs, on: p.on ?? null, root: p.root, rel: p.rel }); this.close(); }],
      target && !p.dir && ["File history", () => { openInEditor({ kind: "changes", path: p.root, on: p.on ?? null, root: p.root, ref: `log:${abs}` }); this.close(); }],
      target && p.dir && ["Set as project root", () => { setRoot(p.space, abs, p.on ?? null); this.close(); }],
      ...this.accounts().map(([name, tab, terminal]) => [`Send to ${name}`, () => { this.after({ send: { tab, terminal, text: this.mention(terminal) } }); this.close(); }]),
      "-",
      ["New file…", () => this.dialog("name", "file")],
      ["New folder…", () => this.dialog("name", "folder")],
      "-",
      target && ["Rename…", () => this.dialog("name", "rename")],
      target && ["Duplicate", (cx) => this.work(cx, async () => { await copyInto(exec, abs, this.abs(parent(p.rel)), p.on); this.after({}); })],
      target && ["Cut", () => { setShared(CLIP, { path: abs, name: p.rel.split("/").pop(), on: p.on ?? null, cut: true }); this.close(); }],
      target && ["Copy", () => { setShared(CLIP, { path: abs, name: p.rel.split("/").pop(), on: p.on ?? null, cut: false }); this.close(); }],
      canPaste && [`Paste ${clip.name}`, (cx) => this.paste(cx)],
      target && "-",
      ["Copy path", (cx) => this.copyText(cx, abs)],
      target && ["Copy relative path", (cx) => this.copyText(cx, p.rel)],
      local && ["Reveal in Finder", (cx) => this.work(cx, () => exec("open", ["-R", abs]))],
      ["Open terminal here", () => { run("tab.new", { space: p.space, folder: this.abs(this.inside()) }); this.close(); }],
      ["Refresh", () => { this.after({}); this.close(); }],
      target && local && "-",
      target && local && ["Move to Trash", () => this.dialog("trash"), true],
    ].filter(Boolean).filter((item, i, all) => item !== "-" || (i > 0 && all[i - 1] !== "-"));
  }

  // The agents running in this space, as [name, tab, terminal].
  accounts() {
    const p = props() ?? {};
    if (!p.rel) return [];
    const tabs = spaces().find((s) => s.id === p.space)?.tabs ?? [];
    return panes().filter((x) => tabs.some((c) => c.id === x.tab) && x.terminal).flatMap((x) => {
      // A launcher's account label when there is one, else any agent's program name.
      const name = terminals().find((t) => t.address === x.terminal)?.labels?.["ccam.account"] ?? (x.program?.agent ? x.program.name : null);
      return name ? [[name, x.tab, x.terminal]] : [];
    });
  }

  // How Claude should see this path: @-mentioned, or quoted when @ would stop at a space.
  mention(terminal) {
    const p = props(), cwd = terminals().find((t) => t.address === terminal)?.cwd;
    const path = cwd === p.root ? p.rel : this.abs(p.rel);
    return /\s/.test(path) ? `"${path}" ` : `@${path} `;
  }

  // A renamed file keeps its editor tab, and any unsaved edits in it.
  repoint(from, to) { setShared(FS, { kind: "moved", from, to, at: `${Date.now()}-${Math.random()}` }); }

  submit(cx) {
    const p = props(), name = this.input.value().trim(), rename = p.action === "rename";
    this.error = checkName(name, rename);
    if (this.error || this.busy) { cx.notify(); return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        if (rename) {
          const to = join(parent(p.rel), name), from = this.abs(p.rel);
          await move(exec, from, this.abs(to), p.on);
          this.repoint(from, this.abs(to));
          this.after({ moved: { from: p.rel, to } });
        } else {
          const rel = join(this.inside(), name);
          await (p.action === "file" ? newFile : newFolder)(exec, this.abs(rel), p.on);
          this.after(p.action === "file" ? { expand: parent(rel) } : { expand: rel });
          if (p.action === "file") openInEditor({ path: this.abs(rel), on: p.on ?? null, rel });
        }
        this.close();
      } catch (e) { this.busy = false; this.error = String(e.message ?? e); cx.notify(); }
    });
  }

  // Editor tabs of something that is gone close (unless they hold unsaved edits).
  closeViewers(path) { setShared(FS, { kind: "removed", path, at: `${Date.now()}-${Math.random()}` }); }

  remove(cx) {
    if (this.busy) return;
    this.busy = true;
    const path = this.abs(props().rel);
    cx.spawn(async (cx) => {
      try { await trash(exec, path, props().on ?? null); this.closeViewers(path); this.after({}); this.close(); }
      catch (e) { this.busy = false; this.error = String(e.message ?? e); cx.notify(); }
    });
  }

  discardFile(cx) {
    if (this.busy) return;
    this.busy = true;
    const p = props();
    cx.spawn(async (cx) => {
      try {
        await discard(exec, p.root, p.rel, p.isNew, p.hasHead, p.on);
        if (p.isNew) this.closeViewers(this.abs(p.rel));
        this.after({});
        this.close();
      } catch (e) { this.busy = false; this.error = String(e.message ?? e); cx.notify(); }
    });
  }

  button(id, text, primary, action) {
    const t = theme();
    return h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(primary ? t.solid : t.input)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
  }

  form(title, body, confirm, action) {
    const t = theme();
    return v_flex().id("fileops").track_focus(this.handle).w_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "enter" && props().mode === "trash") this.remove(cx);
        else if (e.key === "enter" && props().mode === "discard") this.discardFile(cx);
        else return;
        cx.stop_propagation();
      })
      .child(div().text_size(15).font_semibold().child(title))
      .child(body)
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(8).justify_end()
        .child(this.button("cancel", "Cancel", false, () => this.close()))
        .child(this.button("ok", this.busy ? "Working…" : confirm, true, action)));
  }

  render() {
    const t = theme(), p = props() ?? {}, name = p.rel?.split("/").pop();
    if (p.mode === "trash") return this.form(`Move ${name} to the Trash?`, div().text_color(t.muted).child(p.dir ? "This folder and everything in it can be restored from Finder's Trash." : "You can restore it from Finder's Trash."), "Move to Trash", (_e, cx) => this.remove(cx));
    if (p.mode === "discard") return this.form(`Discard changes to ${name}?`, div().text_color(t.muted).child(p.isNew ? "This file is new and has never been committed. It will go to Finder's Trash." : "Your uncommitted changes will be lost. This cannot be undone."), p.isNew ? "Move to Trash" : "Discard", (_e, cx) => this.discardFile(cx));
    if (p.mode === "name") {
      const title = p.action === "rename" ? `Rename ${name}` : p.action === "file" ? "New file" : "New folder";
      const where = p.action === "rename" ? null : (this.inside() || p.root.split("/").pop());
      return this.form(title, v_flex().gap(6)
        .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
        .when(Boolean(where), (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(`In ${where}`))), p.action === "rename" ? "Rename" : "Create", (_e, cx) => this.submit(cx));
    }
    return v_flex().id("fileops").track_focus(this.handle).w_full().p(5).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .children(this.items().map((item, i) => item === "-"
        ? div().h(1).mx(4).my(4).flex_none().bg(t.border)
        : h_flex().id(`op-${i}`).h(28).px(9).flex_none().items_center().rounded(6).cursor_pointer().text_color(item[2] ? t.ansi1 : t.foreground)
          .hover((s) => s.bg(t.selected)).on_click((_e, cx) => item[1](cx)).child(div().truncate().child(item[0]))));
  }
}

// IDE command palette (⌘⇧P): the IDE's own commands with their keys, filtered as you
// type. Herdr's palette is one entry away ("Herdr commands…").
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { props, closeOverlay, openOverlay, theme, run, exec, shared, setShared, notify, pickFolder, focused, panes } from "herdr";
import { activeSpace, project, setRoot, openInEditor, editorCommand, closeTab, ACTIVE, REVEAL, FIND_FOCUS } from "./common.js";

const view = (child) => () => { run("layout.select", { stack: "sidebar", child }); run("layout.show", { id: "sidebar" }); };
const popup = (mod, width, height, p) => () => openOverlay({ mod, kind: "popup", width, height, props: p });

// Git commands run at the project's repo top and report with a toast.
async function git(label, args) {
  const p = project();
  if (!p) return;
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: p.path, on: p.on });
  if (top.code !== 0) { notify({ title: `${label}: not a git repository`, level: "warning" }); return; }
  const r = await exec("git", args, { cwd: top.stdout.trim(), on: p.on, timeout: 120000 });
  notify(r.code === 0 ? { title: `${label} done`, level: "success", timeout: 2000 } : { title: `${label} failed`, body: (r.stderr || r.stdout).trim().split("\n").slice(-3).join("\n"), level: "error" });
}

function commands() {
  const space = activeSpace(), p = project(), a = space ? shared(ACTIVE)?.[space.id] : null;
  const file = a?.kind === "file" ? a : null;
  return [
    ["Go to file…", "⌘P", () => run("mod.open", { name: "ide-quickopen" })],
    ["Go to line…", "⌃G", popup("ide-quickopen", 680, 560, { line: true }), !file],
    ["Search in files", "⌘⇧F", () => { view("view-search")(); setShared(FIND_FOCUS, Date.now()); }],
    ["Show Explorer", "⌘⇧E", view("view-explorer")],
    ["Show Git", "⌘⇧G", view("view-git")],
    ["Show Spaces", "", view("view-spaces")],
    ["Show Agents", "", view("view-agents")],
    ["Toggle sidebar", "⌘B", () => run("layout.toggle", { id: "sidebar" })],
    ["Find in file", "⌘F", () => editorCommand("find", a.uid), !file],
    ["Replace in file", "⌥⌘F", () => editorCommand("find_replace", a.uid), !file],
    ["Save file", "⌘S", () => editorCommand("save", a.uid), !a?.dirty],
    ["Revert file", "", () => editorCommand("revert", a.uid), !a?.dirty],
    ["Toggle Markdown preview", "", () => editorCommand("preview", a.uid), !/\.(md|markdown)$/i.test(file?.path ?? "")],
    ["Close tab", "⌘W", () => { const tab = space?.tabs.find((t) => t.active); if (tab) closeTab(tab.id); }],
    ["Open changes of this file", "", () => openInEditor({ kind: "diff", path: file.path, on: file.on, root: p?.path, rel: file.rel }), !file],
    ["Reveal file in Explorer", "", () => { setShared(REVEAL, { path: a.path, at: Date.now() }); view("view-explorer")(); }, !a],
    ["Reveal file in Finder", "", () => exec("open", ["-R", a.path]), !a || a.on],
    ["Copy file path", "", (cx) => cx.write_to_clipboard(a.path), !a],
    ["Copy relative path", "", (cx) => cx.write_to_clipboard(a.rel ?? a.path), !a],
    ["Git: switch or create branch…", "", popup("ide-branches", 460, 520, { mode: "switch" })],
    ["Git: compare against branch…", "", popup("ide-branches", 460, 520, { mode: "base" })],
    ["Git: switch worktree…", "", popup("ide-worktrees", 520, 460)],
    ["Git: fetch", "", () => git("Fetch", ["fetch", "--all", "--prune"])],
    ["Git: pull (fast-forward)", "", () => git("Pull", ["pull", "--ff-only"])],
    ["Git: push", "", () => git("Push", ["push"])],
    ["New terminal in project", "", () => run("tab.new", p && !p.on ? { space: space?.id, folder: p.path } : {})],
    ["Split right", "⌘D", () => run("pane.split", { direction: "right" })],
    ["Split down", "⌘⇧D", () => run("pane.split", { direction: "down" })],
    ["Open folder as project…", "", (cx) => cx.spawn(async () => { const f = await pickFolder({ prompt: "Open folder as this space's project" }); if (f && space) setRoot(space.id, f, null); }), Boolean(space?.machine)],
    ["Use focused terminal's repo as project", "", (cx) => cx.spawn(async () => {
      const pane = panes().find((x) => x.pane === focused()?.pane), cwd = pane?.cwd ?? focused()?.cwd;
      if (!cwd || !space) return;
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on: space.machine ?? null });
      setRoot(space.id, top.code === 0 ? top.stdout.trim() : cwd, space.machine ?? null);
    })],
    ["Switch layout", "⌘⇧L", () => run("layout.switch")],
    ["Settings", "⌘,", () => run("app.settings")],
    ["Herdr commands…", "", () => run("app.palette")],
  ].filter((c) => !c[3]);
}

function match(query, label) {
  const q = query.toLowerCase().replace(/\s+/g, ""), l = label.toLowerCase();
  if (!q) return 1;
  let at = 0, score = 0, prev = -2;
  for (const ch of q) {
    const i = l.indexOf(ch, at);
    if (i < 0) return 0;
    score += 1 + (i === prev + 1 ? 3 : 0) + (i === 0 || l[i - 1] === " " || l[i - 1] === ":" ? 4 : 0);
    prev = i; at = i + 1;
  }
  return score;
}

export default class Commands extends View {
  init(_props, cx) {
    this.query = ""; this.at = 0;
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Type a command…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.runAt(cx));
    this.input.focus();
    cx.timer.after(150, () => this.input.focus());
  }

  dismiss() { const o = props()?.overlay; if (o) closeOverlay(o); else run("mod.open", { name: "ide-commands" }); }
  list() { return commands().map((c) => [c, match(this.query, c[0])]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([c]) => c); }
  runAt(cx) { const c = this.list()[this.at]; if (!c) return; this.dismiss(); c[2](cx); }

  render() {
    const t = theme(), items = this.list();
    return v_flex().id("ide-commands").w_full().p(8).gap(6).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.dismiss();
        else if (e.key === "down") this.at = Math.min(items.length - 1, this.at + 1);
        else if (e.key === "up") this.at = Math.max(0, this.at - 1);
        else return;
        this.scroll.scroll_to_item(this.at);
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(34).flex_none().px(10).gap(8).items_center().rounded(7).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/ide-explorer/icons/command.svg").size(14).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(v_flex().id("cmd-list").h(420).flex_none().overflow_y_scrollbar().track_scroll(this.scroll)
        .children(items.map((c, i) => h_flex().id(`cmd-${i}`).h(30).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
          .when(i === this.at, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.at = i; this.runAt(cx); })
          .child(div().flex_1().truncate().child(c[0]))
          .when(Boolean(c[1]), (e) => e.child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(c[1])))))
        .when(!items.length, (e) => e.child(div().p(10).text_color(t.dim).child("No matching command"))));
  }
}

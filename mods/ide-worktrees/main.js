// Worktree switcher. Switching re-roots this space's IDE (Explorer, Git, Search,
// Quick Open) to another worktree of the same repo. It never switches spaces and
// leaves running terminals alone. New worktrees go to settings' worktrees.directory
// (default ~/.herdr/worktrees)/<repo>/<branch>.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, exec, settings, notify, run, checking, home } from "herdr";
import { project, activeSpace, setRoot } from "./common.js";

export default class Worktrees extends View {
  init(_props, cx) {
    this.list = []; this.status = "Loading worktrees…"; this.confirm = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "New worktree: branch name (new or existing)…" });
    this.input.on("submit", (_e, cx) => this.create(cx));
    this.handle.focus();
    if (checking()) return;
    this.load(cx);
  }

  git(args, cwd) { const p = project(); return exec("git", args, { cwd: cwd ?? p.path, on: p.on, timeout: 120000 }); }
  close() { closeOverlay(props().overlay); }

  load(cx) {
    if (!project()) { this.status = "No project folder"; return; }
    cx.spawn(async (cx) => {
      const [wt, top, common] = await Promise.all([
        this.git(["--no-optional-locks", "worktree", "list", "--porcelain"]),
        this.git(["rev-parse", "--show-toplevel"]),
        this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      ]);
      if (wt.code !== 0) { this.status = (wt.stderr || "Not a git repository").trim(); cx.notify(); return; }
      this.top = top.stdout.trim();
      this.repo = common.stdout.trim().replace(/\/\.git\/?$/, "").split("/").pop();
      const list = [];
      let cur = null;
      for (const line of wt.stdout.split("\n")) {
        if (line.startsWith("worktree ")) { cur = { path: line.slice(9), branch: null, head: "", main: !list.length }; list.push(cur); }
        else if (cur && line.startsWith("branch refs/heads/")) cur.branch = line.slice(18);
        else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5, 12);
        else if (cur && line === "detached") cur.detached = true;
        else if (cur && line.startsWith("prunable")) cur.prunable = true;
      }
      // How dirty each one is, so you know where work is waiting.
      await Promise.all(list.map(async (w) => {
        if (w.prunable) return;
        const s = await this.git(["--no-optional-locks", "status", "--porcelain=v1"], w.path).catch(() => null);
        w.dirty = s?.code === 0 ? s.stdout.split("\n").filter(Boolean).length : null;
      }));
      this.list = list;
      this.status = null;
      cx.notify();
    });
  }

  pick(w) {
    if (w.prunable) return;
    setRoot(activeSpace().id, w.path, project().on);
    this.close();
  }

  create(cx) {
    const branch = this.input.value().trim();
    if (!branch || this.busy) return;
    const dirSetting = settings()?.worktrees?.directory ?? "~/.herdr/worktrees";
    const baseDir = dirSetting.replace(/^~(?=\/|$)/, home());
    const path = `${baseDir}/${this.repo}/${branch.replace(/\//g, "-")}`;
    this.busy = true; this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const exists = await this.git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
        const remote = exists.code === 0 ? null : await this.git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`]);
        const args = exists.code === 0 ? ["worktree", "add", path, branch]
          : remote?.code === 0 ? ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`]
          : ["worktree", "add", "-b", branch, path];
        const r = await this.git(args);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        setRoot(activeSpace().id, path, project().on);
        notify({ title: `Worktree ${branch} ready`, body: path, level: "success", timeout: 3000 });
        this.close();
      } catch (e) { this.busy = false; this.error = String(e.message ?? e); cx.notify(); }
    });
  }

  remove(w, cx) {
    if (this.confirm !== w.path) { this.confirm = w.path; cx.notify(); return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      const r = await this.git(["worktree", "remove", w.path]);
      this.busy = false; this.confirm = null;
      if (r.code !== 0) this.error = (r.stderr || r.stdout).trim() + (w.dirty ? " (it has uncommitted changes)" : "");
      else { if (w.path === this.top) setRoot(activeSpace().id, this.list[0].path, project().on); this.load(cx); }
      cx.notify();
    });
  }

  terminal(w) {
    run("tab.new", { space: activeSpace().id, folder: w.path, name: w.branch ?? w.path.split("/").pop() });
    this.close();
  }

  small(id, text, tip, action, t, danger = false) {
    return div().id(id).flex_none().px(6).py(2).rounded(4).text_size(10.5).text_color(danger ? t.ansi1 : t.dim).hover((s) => s.bg(t.raised).text_color(danger ? t.ansi1 : t.foreground))
      .tooltip(tip).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(text);
  }

  render() {
    const t = theme();
    return v_flex().id("ide-worktrees").track_focus(this.handle).size_full().min_h(0).p(8).gap(6).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .child(h_flex().px(6).h(24).items_center().gap(6)
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(`WORKTREES${this.repo ? ` · ${this.repo}` : ""}`))
        .child(div().text_size(10.5).text_color(t.dim).child("switching keeps this space"))
        .child(div().id("wt-close").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close (Esc)").on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => this.close()).child(svg("mods/pane/close.svg").size(11))))
      .child(v_flex().id("wt-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(this.list.map((w) => {
          const current = w.path === this.top;
          return h_flex().id(`wt-${w.path}`).h(44).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
            .when(current, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click(() => this.pick(w))
            .child(svg("mods/workspace-chrome/git-branch.svg").size(14).flex_none().text_color(current ? t.accent : t.muted))
            .child(v_flex().flex_1().min_w(0)
              .child(h_flex().gap(6).min_w(0)
                .child(div().min_w(0).truncate().font_medium().child(w.branch ?? (w.detached ? `detached @ ${w.head}` : w.head)))
                .when(w.main, (e) => e.child(div().flex_none().px(4).rounded(3).bg(t.raised).text_size(10).text_color(t.muted).child("main")))
                .when(Boolean(w.dirty), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.blocked).child(`${w.dirty} changed`)))
                .when(Boolean(w.prunable), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi1).child("missing"))))
              .child(div().truncate().text_size(10.5).text_color(t.dim).child(w.path.replace(home(), "~"))))
            .child(this.small(`wtt-${w.path}`, "terminal", "Open a terminal tab here (this space)", () => this.terminal(w), t))
            .when(!w.main, (e) => e.child(this.small(`wtr-${w.path}`, this.confirm === w.path ? "confirm remove" : "remove", "Remove this worktree (git worktree remove)", (cx) => this.remove(w, cx), t, true)));
        }))
        .when(!this.list.length, (e) => e.child(div().p(10).text_color(t.dim).child(this.status ?? "No worktrees"))))
      .when(Boolean(this.error), (e) => e.child(div().px(8).text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(h_flex().h(34).flex_none().px(10).gap(8).items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
        .child(svg("mods/workspace-chrome/plus.svg").size(13).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground))
        .child(div().text_size(10.5).text_color(t.dim).child(this.busy ? "Creating…" : "↵ create")));
  }
}

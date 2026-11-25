// Branch picker. Props: { mode: "switch" | "base", overlay }.
// switch: check out a branch (local or remote), or create one from what you typed.
//   A branch already checked out in another worktree offers to switch the IDE to
//   that worktree instead (same space, no space switch).
// base:  pick what the Git panel's BRANCH DIFF compares against.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, exec, shared, setShared, notify, checking } from "herdr";
import { project, activeSpace, setRoot } from "./common.js";

const BASES = "ide.git.base";
const READ = ["--no-optional-locks"];

export default class Branches extends View {
  init(_props, cx) {
    this.branches = []; this.query = ""; this.at = 0; this.status = "Loading branches…";
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: props()?.mode === "base" ? "Compare against branch…" : "Switch to branch, or type a new name…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value().trim(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.choose(this.items()[this.at], cx));
    this.input.focus();
    if (checking()) return;
    cx.timer.after(150, () => this.input.focus());
    this.load(cx);
  }

  git(args) { const p = project(); return exec("git", args, { cwd: p.path, on: p.on, timeout: 60000 }); }

  load(cx) {
    if (!project()) { this.status = "No project folder"; return; }
    cx.spawn(async (cx) => {
      const [refs, wt, top] = await Promise.all([
        this.git([...READ, "for-each-ref", "--sort=-committerdate", "--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(committerdate:relative)%1f%(subject)%1f%(upstream:track)", "refs/heads", "refs/remotes"]),
        this.git([...READ, "worktree", "list", "--porcelain"]),
        this.git(["rev-parse", "--show-toplevel"]),
      ]);
      if (refs.code !== 0) { this.status = (refs.stderr || "Not a git repository").trim(); cx.notify(); return; }
      this.top = top.stdout.trim();
      const worktrees = {};
      let path = null;
      for (const line of wt.stdout.split("\n")) {
        if (line.startsWith("worktree ")) path = line.slice(9);
        else if (line.startsWith("branch refs/heads/")) worktrees[line.slice(18)] = path;
      }
      const local = new Set();
      this.branches = refs.stdout.split("\n").filter(Boolean).map((l) => {
        const [ref, name, head, when, subject, track] = l.split("\x1f");
        const remote = ref.startsWith("refs/remotes/");
        if (!remote) local.add(name);
        return { name, remote, current: head === "*", when, subject, track, worktree: !remote ? worktrees[name] ?? null : null };
      }).filter((b) => !b.name.endsWith("/HEAD") && b.name !== "origin");
      // A remote branch with a local copy shows once, as the local one.
      this.branches = this.branches.filter((b) => !b.remote || !local.has(b.name.replace(/^[^/]+\//, "")));
      this.status = null;
      cx.notify();
    });
  }

  items() {
    const q = this.query.toLowerCase();
    const list = this.branches.filter((b) => !q || b.name.toLowerCase().includes(q));
    const out = list.map((b) => ({ type: "branch", b }));
    if (props()?.mode !== "base" && this.query && !this.branches.some((b) => b.name === this.query)) out.unshift({ type: "create", name: this.query });
    return out;
  }

  close() { closeOverlay(props().overlay); }

  choose(item, cx) {
    if (!item || this.busy) return;
    const mode = props()?.mode;
    if (mode === "base") {
      setShared(BASES, { ...(shared(BASES) ?? {}), [this.top]: item.b.name });
      this.close();
      return;
    }
    if (item.type === "branch" && item.b.current) { this.close(); return; }
    if (item.type === "branch" && item.b.worktree && item.b.worktree !== this.top) {
      setRoot(activeSpace().id, item.b.worktree, project().on);
      notify({ title: `Switched to worktree ${item.b.worktree.split("/").pop()}`, body: `${item.b.name} is checked out there. Terminals keep their folders.`, timeout: 3500 });
      this.close();
      return;
    }
    const args = item.type === "create" ? ["switch", "-c", item.name] : item.b.remote ? ["switch", "--track", item.b.name] : ["switch", item.b.name];
    this.busy = true; this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.git(args).catch((e) => ({ code: 1, stderr: String(e) }));
      this.busy = false;
      if (r.code === 0) { notify({ title: item.type === "create" ? `Created ${item.name}` : `Switched to ${item.b.name.replace(/^[^/]+\//, item.b.remote ? "" : "$&")}`, level: "success", timeout: 2000 }); this.close(); }
      else { this.error = (r.stderr || r.stdout).trim().split("\n").slice(0, 4).join("\n"); cx.notify(); }
    });
  }

  compare(b) {
    setShared(BASES, { ...(shared(BASES) ?? {}), [this.top]: b.name });
    notify({ title: `Branch diff now compares against ${b.name}`, timeout: 2000 });
    this.close();
  }

  render() {
    const t = theme(), items = this.items(), base = props()?.mode === "base";
    const currentBase = this.top ? shared(BASES)?.[this.top] : null;
    return v_flex().id("ide-branches").track_focus(this.handle).size_full().min_h(0).p(8).gap(6).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return this.close();
        if (e.key === "down") this.at = Math.min(items.length - 1, this.at + 1);
        else if (e.key === "up") this.at = Math.max(0, this.at - 1);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(34).flex_none().px(10).gap(8).items_center().rounded(7).border_1().border_color(t.accent).bg(t.background)
        .child(svg(base ? "mods/workspace-chrome/git-compare.svg" : "mods/workspace-chrome/git-branch.svg").size(14).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
        .child(div().id("br-close").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close (Esc)").on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => this.close()).child(svg("mods/pane/close.svg").size(11))))
      .when(Boolean(this.error), (e) => e.child(div().px(8).py(4).text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("br-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(items.slice(0, 300).map((it, i) => {
          if (it.type === "create") return h_flex().id("br-create").h(32).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
            .when(i === this.at, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.choose(it, cx))
            .child(svg("mods/workspace-chrome/plus.svg").size(13).text_color(t.accent)).child(div().child(`Create branch "${it.name}" from here`));
          const b = it.b;
          return h_flex().id(`br-${b.name}`).h(40).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
            .when(i === this.at, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.choose(it, cx))
            .child(div().w(10).flex_none().text_color(t.accent).child(b.current || (base && b.name === currentBase) ? "●" : ""))
            .child(v_flex().flex_1().min_w(0)
              .child(h_flex().gap(6).min_w(0)
                .child(div().min_w(0).truncate().text_color(b.remote ? t.muted : t.foreground).child(b.name))
                .when(Boolean(b.track), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.blocked).child(b.track)))
                .when(Boolean(b.worktree) && !b.current, (e) => e.child(div().flex_none().px(4).rounded(3).bg(t.raised).text_size(10).text_color(t.muted).child("worktree"))))
              .child(div().truncate().text_size(10.5).text_color(t.dim).child(`${b.when} · ${b.subject}`)))
            .when(!base && !b.current, (e) => e.child(div().id(`brc-${b.name}`).flex_none().px(6).py(2).rounded(4).text_size(10.5).text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
              .tooltip("Compare the current branch against this one").on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); this.compare(b); }).child("compare")));
        }))
        .when(!items.length, (e) => e.child(div().p(10).text_color(t.dim).child(this.status ?? "No branches match"))))
      .child(div().flex_none().px(6).text_size(10.5).text_color(t.dim).child(this.busy ? "Working…" : base ? "↵ compare against" : "↵ switch · branches in another worktree open that worktree"));
  }
}

// Go to file (⌘P). Empty query: recent files. "name:42" opens at line 42; ":42" moves
// the shown editor to line 42.
import { View, div, svg } from "gpui-kit";
import { props, closeOverlay } from "herdr";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, run, shared, setShared } from "herdr";
import { makeEntry, search } from "./score.js";
import { project, activeSpace, openInEditor, RECENT, ACTIVE, GOTO } from "./common.js";

const VISIBLE = 14, LIMIT = 200;
const close = () => (props()?.overlay ? closeOverlay(props().overlay) : run("mod.open", { name: "ide-quickopen" }));

// Searches the space's fixed project folder.
function location() {
  const p = project();
  return { cwd: p?.path ?? null, on: p?.on ?? null, space: activeSpace() };
}

export default class Search extends View {
  init(_props, cx) {
    this.entries = []; this.results = []; this.at = 0; this.top = 0; this.query = ""; this.status = "Reading files…";
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: props()?.line ? "Go to line…" : "Go to file…   (name:42 for a line, :42 in the open file)" });
    if (props()?.line) { this.input.set_value(":"); this.query = ":"; }
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.refilter(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.open(this.results[this.at], cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.load(cx);
  }

  load(cx) {
    const { cwd, on } = location();
    if (!cwd) { this.status = "No folder open"; return; }
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-prefix"], { cwd, on });
        const inGit = top.code === 0;
        this.root = cwd; this.on = on;
        const r = inGit
          // -z keeps unusual names verbatim (no quoting); --deleted is subtracted below.
          ? await exec("git", ["ls-files", "-z", "-co", "--exclude-standard"], { cwd, on })
          : await exec("rg", ["--files", "--hidden", "-g", "!.git", "--null"], { cwd: this.root, on });
        if (r.code !== 0) throw new Error(r.stderr || "Cannot list files");
        const gone = inGit ? new Set((await exec("git", ["ls-files", "-z", "--deleted"], { cwd, on })).stdout.split("\0")) : new Set();
        this.entries = [...new Set(r.stdout.split(/[\0\n]/).filter((f) => f && !gone.has(f)))].sort().map(makeEntry);
        this.status = null;
        this.refilter();
      } catch (e) { this.status = String(e); }
      finally { cx.notify(); }
    });
  }

  // ":42" → a line in the shown file; "name:42" → that line of a file.
  parse() {
    const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(this.query.trim());
    return m ? { name: m[1], line: +m[2], column: m[3] ? +m[3] : 1 } : { name: this.query.trim(), line: null };
  }

  refilter() {
    const q = this.parse();
    this.line = q.line; this.column = q.column;
    if (!q.name) {
      const space = activeSpace(), recent = space ? shared(RECENT)?.[space.id] ?? [] : [];
      const rel = new Set(recent.filter((r) => r.path.startsWith(`${this.root}/`)).map((r) => r.path.slice(this.root.length + 1)));
      this.results = q.line ? [] : [...rel].map(makeEntry);
      this.recent = true;
    } else { this.results = search(q.name, this.entries, LIMIT); this.recent = false; }
    this.at = 0; this.top = 0;
  }

  move(delta) {
    if (!this.results.length) return;
    this.at = (this.at + delta + this.results.length) % this.results.length;
    if (this.at < this.top) this.top = this.at;
    if (this.at >= this.top + VISIBLE) this.top = this.at - VISIBLE + 1;
  }

  open(entry) {
    const q = this.parse();
    if (!q.name && q.line) {
      const a = shared(ACTIVE)?.[activeSpace()?.id];
      if (a?.uid) setShared(GOTO, { uid: a.uid, line: q.line, column: q.column ?? 1, at: `${Date.now()}` });
      close();
      return;
    }
    if (!entry || !this.root) return;
    openInEditor({ path: `${this.root}/${entry.path}`, on: this.on, rel: entry.path, ...(q.line ? { line: q.line, column: q.column } : {}) });
    close();
  }

  row(entry, index, t) {
    const dir = entry.path.slice(0, entry.path.length - entry.name.length).replace(/\/$/, "");
    return h_flex().id(`find-${entry.path}`).h(30).flex_none().px(10).gap(9).items_center().rounded(7).cursor_pointer()
      .when(index === this.at, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.open(entry, cx))
      .child(svg("mods/files/file.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_none().max_w(300).truncate().child(entry.name))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(dir));
  }

  render() {
    const t = theme(), shown = this.results.slice(this.top, this.top + VISIBLE);
    return v_flex().id("ide-quickopen").track_focus(this.handle).size_full().min_h(0).p(10).gap(8).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return close();
        if (e.key === "down") this.move(1);
        else if (e.key === "up") this.move(-1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => {
        if (Math.abs(e.delta.y) < 1) return;
        this.top = Math.max(0, Math.min(Math.max(0, this.results.length - VISIBLE), this.top + (e.delta.y > 0 ? -1 : 1)));
        cx.notify();
      })
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(15).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.entries.length ? `${this.results.length === LIMIT ? `${LIMIT}+` : this.results.length} of ${this.entries.length}` : "")))
      .child(v_flex().flex_1().min_h(0)
        .when(Boolean(this.recent) && shown.length > 0, (e) => e.child(div().px(10).pt(2).pb(4).text_size(10.5).font_semibold().text_color(t.dim).child("RECENT")))
        .children(shown.map((entry, i) => this.row(entry, this.top + i, t)))
        .when(!shown.length, (e) => e.child(div().p(10).text_color(t.dim).child(this.status ?? (this.line && !this.parse().name ? `↵ go to line ${this.line} in the shown file` : this.recent ? "No recent files: type to search" : "No matching files")))));
  }
}

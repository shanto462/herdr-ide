// Git pages in an editor tab. Props: { uid, path (a folder inside the repo), on, ref }.
//   compare:<base>...<head>  what <head> changed since it left <base>; head "" is your
//                            working tree, uncommitted and untracked files included
//   commit:<sha>             one commit: message, author, and every file's diff
//   log: / log:<path>        history (of one file), filterable; a click opens the commit
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar, InputState, Input } from "gpui-base";
import { props, theme, exec, shared, setShared, openOverlay, notify, settings, checking, run } from "herdr";
import { openInEditor, fileTint, paper, FILETABS } from "./common.js";

const PICK = "ide.compare.pick"; // { uid, side: "base" | "head", branch, at } from the branch picker
const BASES = "ide.git.base";    // { [repo top]: branch } the last base compared against
const READ = ["--no-optional-locks"];
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "-M"];
const ROW = 22, FOLD_AT = 800, MAX_ROWS = 40000;
const LOCKS = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock|bun\.lockb?|uv\.lock)$/;
const MARK = { A: "ansi2", D: "ansi1", R: "ansi4", M: "blocked" };

const unquote = (s) => (s.startsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s);

// A whole `git diff` → files, each with its rows ({ kind: "@" | "+" | "-" | " " | "\\", a, b, text }).
function parseDiff(text) {
  const files = [];
  let f = null, old = 0, next = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(line);
      f = { path: m ? m[2] : line.slice(11), from: null, mark: "M", add: 0, del: 0, rows: [], binary: false, inHunk: false };
      files.push(f);
      continue;
    }
    if (!f) continue;
    if (!f.inHunk && !line.startsWith("@@")) {
      if (line.startsWith("new file mode")) f.mark = "A";
      else if (line.startsWith("deleted file mode")) f.mark = "D";
      else if (line.startsWith("rename from ")) { f.mark = "R"; f.from = unquote(line.slice(12)); }
      else if (line.startsWith("rename to ")) f.path = unquote(line.slice(10));
      else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) f.binary = true;
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") f.path = unquote(line.slice(4)).replace(/^b\//, "");
      else if (line.startsWith("--- ") && line !== "--- /dev/null" && f.mark === "D") f.path = unquote(line.slice(4)).replace(/^a\//, "");
      continue;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { f.inHunk = true; old = +m[1]; next = +m[2]; f.rows.push({ kind: "@", text: line }); continue; }
    const k = line[0];
    if (k === "+") { f.add++; f.rows.push({ kind: k, b: next++, text: line.slice(1) }); }
    else if (k === "-") { f.del++; f.rows.push({ kind: k, a: old++, text: line.slice(1) }); }
    else if (k === " ") f.rows.push({ kind: k, a: old++, b: next++, text: line.slice(1) });
    else if (k === "\\") f.rows.push({ kind: "\\", text: line });
  }
  return files;
}

const parseLog = (out) => out.split("\n").filter(Boolean).map((l) => {
  const [sha, short, author, when, subject, refs] = l.split("\x1f");
  return { sha, short, author, when, subject: subject ?? "", refs: (refs ?? "").replace(/HEAD -> /, "") };
});

export default class Changes extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.uid = p.uid; this.on = p.on ?? null; this.cwd = p.path; this.ref = p.ref || "log:";
    this.files = []; this.commits = []; this.meta = {}; this.folded = new Set(); this.cache = null;
    this.showCommits = true; this.filter = "";
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Filter by message, author or hash…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value().trim().toLowerCase(); cx.notify(); });
    this.pickAt = shared(PICK)?.at;
    if (checking()) return;
    this.load(cx);
    cx.timer.every(400, (cx) => this.tick(cx));
  }

  mode() { return this.ref.split(":")[0]; }
  git(args, opts = {}) { return exec("git", [...READ, ...args], { cwd: this.top ?? this.cwd, on: this.on, timeout: 120000, ...opts }); }
  range() {
    const r = this.ref.slice(8), i = r.indexOf("...");
    return i < 0 ? [r, ""] : [r.slice(0, i), r.slice(i + 3)];
  }
  label() {
    const m = this.mode();
    if (m === "compare") { const [base, head] = this.range(); return `${head || "working tree"} ↔ ${base}`; }
    if (m === "commit") return `@${this.ref.slice(7, 14)}`;
    const path = this.ref.slice(4);
    return path ? `History: ${path.split("/").pop()}` : "History";
  }

  // The branch picker reports a new base or head for this tab.
  tick(cx) {
    const pick = shared(PICK);
    if (!pick || pick.at === this.pickAt) return;
    this.pickAt = pick.at;
    if (pick.uid !== this.uid) return;
    const [base, head] = this.range();
    const next = pick.side === "base" ? [pick.branch, head] : [base, pick.branch];
    if (pick.side === "base" && this.top) setShared(BASES, { ...(shared(BASES) ?? {}), [this.top]: pick.branch });
    this.setRef(`compare:${next[0]}...${next[1]}`, cx);
  }

  setRef(ref, cx) {
    this.ref = ref;
    const reg = shared(FILETABS) ?? {}, e = reg[this.uid];
    if (e) { setShared(FILETABS, { ...reg, [this.uid]: { ...e, ref } }); run("tab.rename", { id: e.tab, name: this.label() }); }
    this.load(cx);
  }

  load(cx) {
    const gen = (this.gen = (this.gen ?? 0) + 1);
    this.loading = true; this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!this.top) {
          const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.cwd, on: this.on });
          if (r.code !== 0) throw new Error((r.stderr || "Not a git repository").trim());
          this.top = r.stdout.trim();
        }
        const m = this.mode();
        const got = m === "compare" ? await this.loadCompare() : m === "commit" ? await this.loadCommit() : await this.loadLog();
        if (gen !== this.gen) return;
        this.files = got.files; this.commits = got.commits; this.meta = got.meta; this.cache = null;
        // Fold what would drown the page: lockfiles, huge files, and everything past the row budget.
        this.folded = new Set();
        let budget = MAX_ROWS;
        this.files.forEach((f, i) => {
          if (LOCKS.test(f.path) || f.rows.length > FOLD_AT || f.rows.length > budget) this.folded.add(i);
          else budget -= f.rows.length;
        });
      } catch (e) { if (gen === this.gen) this.error = String(e.message ?? e); }
      finally { if (gen === this.gen) { this.loading = false; cx.notify(); } }
    });
  }

  async loadCompare() {
    const [base, head] = this.range();
    if (!base) return { files: [], commits: [], meta: { base, head } };
    const tip = head || "HEAD";
    const mb = await this.git(["merge-base", base, tip]);
    if (mb.code !== 0) throw new Error(`${base} and ${head || "your working tree"} share no history, or a branch is missing`);
    const at = mb.stdout.trim();
    const [d, log, counts, untracked] = await Promise.all([
      this.git(["diff", ...DIFF, at, ...(head ? [head] : [])], { timeout: 180000 }),
      this.git(["log", "--format=%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1f%D", "-n", "300", `${base}..${tip}`]),
      this.git(["rev-list", "--left-right", "--count", `${base}...${tip}`]),
      head ? null : this.git(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    if (d.code !== 0) throw new Error((d.stderr || "git diff failed").trim());
    let text = d.stdout;
    const fresh = untracked ? untracked.stdout.split("\0").filter(Boolean) : [];
    for (const path of fresh.slice(0, 50)) text += "\n" + (await this.git(["diff", "--no-index", ...DIFF, "--", "/dev/null", path])).stdout;
    const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
    return { files: parseDiff(text), commits: parseLog(log.stdout), meta: { base, head, ahead: ahead || 0, behind: behind || 0, untracked: fresh.length } };
  }

  async loadCommit() {
    const sha = this.ref.slice(7);
    const info = await this.git(["show", "-s", "--date=format:%Y-%m-%d %H:%M", "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%ar%x1f%P%x1f%D%x1f%B", sha]);
    if (info.code !== 0) throw new Error((info.stderr || "Unknown commit").trim());
    const [full, short, author, email, date, ago, parents, refs, ...rest] = info.stdout.split("\x1f");
    const message = rest.join("\x1f").trim(), ps = parents.trim().split(/\s+/).filter(Boolean);
    const d = ps.length ? await this.git(["diff", ...DIFF, ps[0], full], { timeout: 180000 }) : await this.git(["show", "--format=", ...DIFF, full], { timeout: 180000 });
    return {
      files: parseDiff(d.stdout), commits: [],
      meta: { sha: full, short, author, email, date, ago, parents: ps, refs: refs.trim().replace(/HEAD -> /, ""), subject: message.split("\n")[0], body: message.split("\n").slice(1).join("\n").trim() },
    };
  }

  async loadLog() {
    const path = this.ref.slice(4);
    const r = await this.git(["log", "--format=%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1f%D", "-n", "2000", ...(path ? ["--follow", "--", path] : [])]);
    if (r.code !== 0) throw new Error((r.stderr || "No history").trim());
    return { files: [], commits: parseLog(r.stdout), meta: { path } };
  }

  openCommit(c) { openInEditor({ kind: "changes", path: this.top, on: this.on, root: this.top, ref: `commit:${c.sha}` }); }
  pickBranch(side) { openOverlay({ mod: "ide-branches", kind: "popup", width: 460, height: 520, props: { mode: "pick", uid: this.uid, side } }); }

  // The diff as fixed-height rows for the virtual list.
  items() {
    if (this.cache) return this.cache;
    const out = [];
    this.files.forEach((f, i) => {
      out.push({ key: `f${i}`, type: "file", f, i });
      if (this.folded.has(i)) return;
      if (f.binary) out.push({ key: `n${i}`, type: "note", text: "Binary file" });
      else if (!f.rows.length) out.push({ key: `n${i}`, type: "note", text: f.mark === "R" ? `Renamed from ${f.from}` : "No content changes" });
      f.rows.forEach((r, k) => out.push({ key: `r${i}-${k}`, type: "row", r }));
    });
    let wide = 0;
    for (const it of out) if (it.type === "row" && it.r.text.length > wide) wide = it.r.text.length;
    this.width = 130 + Math.min(wide, 400) * 7.6;
    return (this.cache = out);
  }

  toggle(i, cx) {
    this.folded.has(i) ? this.folded.delete(i) : this.folded.add(i);
    this.cache = null;
    cx.notify();
  }

  jump(i, cx) {
    if (this.folded.has(i)) { this.folded.delete(i); this.cache = null; }
    const at = this.items().findIndex((x) => x.key === `f${i}`);
    if (at >= 0) this.scroll.scroll_to_item(at);
    cx.notify();
  }

  row(it, t) {
    if (it.type === "file") {
      const f = it.f, folded = this.folded.has(it.i), name = f.path.split("/").pop();
      return h_flex().id(it.key).w_full().h(ROW).flex_none().pl(8).pr(12).gap(6).items_center().bg(t.raised).border_t(1).border_color(t.border).cursor_pointer()
        .font_family(settings().ui_font ?? "Geist").text_size(12)
        .child(svg(`mods/files/chevron-${folded ? "right" : "down"}.svg`).size(10).flex_none().text_color(t.dim))
        .child(div().w(12).flex_none().font_semibold().text_color(t[MARK[f.mark] ?? "dim"]).child(f.mark))
        .child(div().size(7).flex_none().rounded(2).bg(fileTint(name, t)))
        .child(div().flex_none().font_semibold().child(name))
        .child(div().text_color(t.dim).child(f.mark === "R" && f.from ? `${f.path.slice(0, -name.length)} ← ${f.from}` : f.path.slice(0, -name.length)))
        .child(div().text_color(t.ansi2).child(`+${f.add}`))
        .child(div().text_color(t.ansi1).child(`−${f.del}`))
        .when(folded, (e) => e.child(div().text_color(t.dim).child(LOCKS.test(f.path) ? "· lockfile, folded" : f.rows.length > FOLD_AT ? `· ${f.rows.length} lines, folded` : "· folded")));
    }
    if (it.type === "note") return h_flex().id(it.key).w_full().h(ROW).flex_none().pl(44).items_center().italic().text_color(t.dim).child(it.text);
    const r = it.r;
    if (r.kind === "@") return h_flex().id(it.key).w_full().h(ROW).flex_none().px(12).items_center().bg(t.hover).text_color(t.dim).child(div().whitespace_nowrap().child(r.text));
    const num = (n) => div().w(44).flex_none().text_right().pr(8).text_color(t.dim).child(n === undefined ? "" : String(n));
    return h_flex().id(it.key).w_full().h(ROW).flex_none().items_center()
      .when(r.kind === "+", (e) => e.bg(t.ansi2 + "1f")).when(r.kind === "-", (e) => e.bg(t.ansi1 + "1f"))
      .child(num(r.a)).child(num(r.b))
      .child(div().w(16).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === "+" || r.kind === "-" ? r.kind : ""))
      .child(div().whitespace_nowrap().when(r.kind === "\\", (e) => e.italic().text_color(t.dim)).child(r.text || " "));
  }

  chip(id, children, tip, action, t) {
    return h_flex().id(id).h(26).px(9).gap(6).flex_none().items_center().rounded(6).border_1().border_color(t.border).bg(t.raised).cursor_pointer()
      .hover((s) => s.border_color(t.accent)).tooltip(tip).on_click(action).children(children);
  }
  icon(id, path, tip, action, t) {
    return div().id(id).p(5).flex_none().rounded(5).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(path).size(13).when(path.endsWith("refresh.svg") && Boolean(this.loading), (x) => x.spin(900)));
  }

  stats(t) {
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    return h_flex().gap(8).flex_none().items_center().text_size(11.5)
      .child(div().text_color(t.dim).child(`${this.files.length} file${this.files.length === 1 ? "" : "s"}`))
      .child(div().text_color(t.ansi2).child(`+${add}`))
      .child(div().text_color(t.ansi1).child(`−${del}`));
  }

  header(t) {
    const m = this.mode(), refresh = this.icon("ch-refresh", "mods/ide-explorer/icons/refresh.svg", "Reload", (cx) => this.load(cx), t);
    const bar = h_flex().flex_none().px(14).py(10).gap(10).items_center().border_b(1).border_color(t.border);
    if (m === "compare") {
      const [base, head] = this.range(), meta = this.meta;
      return bar
        .child(svg("mods/ide-explorer/icons/compare.svg").size(15).flex_none().text_color(t.accent))
        .child(this.chip("ch-head", [svg("mods/workspace-chrome/git-branch.svg").size(12).text_color(t.accent), div().max_w(220).truncate().child(head || "Working tree"), svg("mods/files/chevron-down.svg").size(10).text_color(t.dim)],
          "What changed: a branch, or your working tree with uncommitted files", () => this.pickBranch("head"), t))
        .child(div().text_color(t.dim).child("compared with"))
        .child(this.chip("ch-base", [svg("mods/workspace-chrome/git-branch.svg").size(12).text_color(t.muted), div().max_w(220).truncate().child(base || "Pick a branch…"), svg("mods/files/chevron-down.svg").size(10).text_color(t.dim)],
          "The branch it left from", () => this.pickBranch("base"), t))
        .when(Boolean(head), (e) => e.child(this.icon("ch-swap", "mods/ide-explorer/icons/diff.svg", "Swap the two sides", (cx) => this.setRef(`compare:${head}...${base}`, cx), t)))
        .child(div().flex_1())
        .when(Boolean(base) && meta.ahead !== undefined, (e) => e.child(div().text_size(11.5).text_color(t.dim).child(`${meta.ahead} commit${meta.ahead === 1 ? "" : "s"} ahead · ${meta.behind} behind`)))
        .when(this.files.length > 0, (e) => e.child(this.stats(t)))
        .child(refresh);
    }
    if (m === "commit") {
      const meta = this.meta;
      return v_flex().flex_none().px(16).pt(12).pb(10).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(10).items_start()
          .child(svg("mods/ide-explorer/icons/commit.svg").size(16).mt(2).flex_none().text_color(t.accent))
          .child(div().flex_1().min_w(0).text_size(15).font_semibold().child(meta.subject ?? (this.loading ? "Loading…" : "")))
          .child(refresh))
        .when(Boolean(meta.body), (e) => e.child(div().pl(26).max_h(140).overflow_y_scrollbar().text_size(12.5).text_color(t.muted).whitespace_normal().child(meta.body)))
        .when(Boolean(meta.sha), (e) => e.child(h_flex().pl(26).gap(10).items_center().text_size(11.5).text_color(t.dim)
          .child(div().id("ch-sha").px(6).py(1).rounded(4).bg(t.raised).cursor_pointer().font_family(settings().font_family ?? "JetBrains Mono").text_color(t.foreground).hover((s) => s.bg(t.hover))
            .tooltip("Copy the full hash").on_click((_e, cx) => { cx.write_to_clipboard(meta.sha); notify({ title: "Copied commit hash", body: meta.short, timeout: 1500 }); }).child(meta.short))
          .child(div().child(`${meta.author} <${meta.email}>`))
          .child(div().child(`${meta.date} · ${meta.ago}`))
          .children(meta.parents.map((sha, i) => div().id(`ch-parent-${i}`).px(5).rounded(4).cursor_pointer().text_color(t.accent).hover((s) => s.bg(t.hover))
            .tooltip(meta.parents.length > 1 ? `Parent ${i + 1}${i === 0 ? " (this diff compares against it)" : ""}` : "Parent commit").on_click(() => this.openCommit({ sha })).child(`parent ${sha.slice(0, 7)}`)))
          .when(Boolean(meta.refs), (e) => e.child(div().px(5).rounded(4).bg(t.accent + "26").text_color(t.accent).child(meta.refs)))
          .child(div().flex_1())
          .child(this.stats(t))));
    }
    const path = this.ref.slice(4), rel = path && this.top && path.startsWith(this.top + "/") ? path.slice(this.top.length + 1) : path;
    return bar
      .child(svg("mods/ide-explorer/icons/history.svg").size(15).flex_none().text_color(t.accent))
      .child(div().flex_none().font_semibold().child(rel ? `History of ${rel}` : "History"))
      .child(h_flex().flex_1().min_w(0).max_w(420).h(28).px(9).gap(6).items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(12).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(div().flex_1())
      .child(div().text_size(11.5).text_color(t.dim).child(`${this.commits.length}${this.commits.length >= 2000 ? "+" : ""} commits`))
      .child(refresh);
  }

  commitRow(c, id, t, compact = false) {
    return h_flex().id(id).w_full().h(compact ? 34 : 40).flex_none().px(compact ? 10 : 16).gap(8).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .child(svg("mods/ide-explorer/icons/commit.svg").size(12).flex_none().text_color(t.dim))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).min_w(0)
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(c.subject))
          .when(Boolean(c.refs), (e) => e.child(div().flex_none().max_w(160).truncate().px(4).rounded(3).bg(t.accent + "26").text_size(10).text_color(t.accent).child(c.refs))))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(`${c.short} · ${c.author} · ${c.when}`)));
  }

  sidebar(t) {
    const m = this.mode(), [base, head] = this.range();
    const files = this.files.map((f, i) => {
      const name = f.path.split("/").pop();
      const single = m === "commit" ? `commit:${this.meta.sha}` : m === "compare" && !head && base ? `base:${base}` : null;
      return h_flex().id(`cf-${i}`).h(26).flex_none().pl(10).pr(4).gap(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(f.path).on_click((_e, cx) => this.jump(i, cx))
        .child(div().w(10).flex_none().text_size(11).font_semibold().text_color(t[MARK[f.mark] ?? "dim"]).child(f.mark))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(name))
        .child(div().flex_none().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`))
        .child(div().flex_none().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`))
        .when(Boolean(single), (e) => e.child(this.icon(`cfd-${i}`, "mods/workspace-chrome/git-compare.svg", "Open this file's diff in its own tab (hunk actions)",
          () => openInEditor({ kind: "diff", path: `${this.top}/${f.path}`, on: this.on, root: this.top, rel: f.path, ref: single }), t)))
        .when(f.mark !== "D", (e) => e.child(this.icon(`cfo-${i}`, "mods/ide-explorer/icons/open-file.svg", "Open file",
          () => openInEditor({ path: `${this.top}/${f.path}`, on: this.on, rel: f.path }), t)));
    });
    const section = (id, title, count, open, toggle) => h_flex().id(id).h(28).flex_none().px(10).gap(5).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(toggle)
      .child(svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(10).text_color(t.dim))
      .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(title))
      .child(div().px(5).rounded(8).bg(t.raised).text_size(10.5).text_color(t.muted).child(String(count)));
    return v_flex().id("ch-side").w(290).flex_none().h_full().min_h(0).overflow_y_scrollbar().border_r(1).border_color(t.border).pb(10)
      .when(m === "compare" && this.commits.length > 0, (e) => e
        .child(section("ch-commits", "COMMITS", this.commits.length, this.showCommits, (_e, cx) => { this.showCommits = !this.showCommits; cx.notify(); }))
        .when(this.showCommits, (x) => x.children(this.commits.slice(0, 300).map((c, i) => this.commitRow(c, `cc-${i}`, t, true).on_click(() => this.openCommit(c))))))
      .child(section("ch-files", "FILES CHANGED", this.files.length, true, () => {}))
      .children(files);
  }

  render() {
    const t = theme(), m = this.mode();
    const page = v_flex().id("ide-changes").size_full().min_h(0).bg(paper(t)).text_color(t.foreground).text_size(13).child(this.header(t));
    if (this.error) return page.child(div().p(16).text_color(t.ansi1).child(this.error));
    if (m === "log") {
      const q = this.filter, list = q ? this.commits.filter((c) => `${c.subject} ${c.author} ${c.sha} ${c.refs}`.toLowerCase().includes(q)) : this.commits;
      if (!list.length) return page.child(div().p(16).text_color(t.dim).child(this.loading ? "Loading…" : q ? "No commit matches" : "No commits"));
      const byKey = new Map(list.map((c) => [c.sha, c]));
      return page.child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("ch-log", list.length, 40, (i) => list[i]?.sha ?? String(i), (range) => list.slice(range.start, range.end).map((c) => this.commitRow(c, c.sha, t)))
          .size_full().on_item_click((key) => { const c = byKey.get(key); if (c) this.openCommit(c); }))
        .child(Scrollbar.vertical("ch-log").viewport_from_layout().absolute().inset_0()));
    }
    if (m === "compare" && !this.range()[0]) return page.child(div().p(16).text_color(t.dim).child("Pick the branch to compare against."));
    const items = this.items();
    if (!items.length) return page.child(div().p(16).text_color(t.dim).child(this.loading ? "Loading…" : m === "compare" ? "No differences" : "This commit changes no files"));
    return page.child(h_flex().flex_1().min_h(0).items_start()
      .child(this.sidebar(t))
      .child(div().flex_1().min_w(0).h_full().relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12.5)
        .child(div().id("ch-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.width).h_full()
            .child(v_virtual_list("ch-diff", items.length, ROW, (i) => items[i]?.key ?? String(i), (range) => items.slice(range.start, range.end).map((it) => this.row(it, t)))
              .track_scroll(this.scroll).size_full()
              .on_item_click((key, cx) => { if (key[0] === "f") this.toggle(+key.slice(1), cx); }))))
        .child(Scrollbar.vertical("ch-diff").viewport_from_layout().absolute().inset_0())));
  }
}

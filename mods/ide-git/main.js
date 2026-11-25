// The IDE's Git panel, for the project folder (or the worktree picked for it):
// branch + worktree pickers, fetch/pull/push, commit, staged and unstaged changes,
// the BRANCH DIFF against a base branch, and history with per-commit files.
// Every diff opens as an editor tab.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, watchFolder, theme, shared, setShared, openOverlay, notify, checking, nextCommand } from "herdr";
import { SCM, TURNS, activeSpace, project, ensureProject, openInEditor, fileTint, sh } from "./common.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const BASES = "ide.git.base"; // { [repo toplevel]: branch }
const MAX = 1500;

const letter = (xy) => (xy === "??" ? "U" : xy.includes("U") || xy === "AA" || xy === "DD" ? "!" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : xy.includes("R") ? "R" : "M");

function numstat(text) {
  const out = {};
  for (const entry of text.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    out[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0 };
  }
  return out;
}

export default class Git extends View {
  init(_props, cx) {
    this.state = null; this.sections = { turns: true, staged: true, changes: true, branch: true, history: false };
    this.commits = []; this.commitFiles = {}; this.expanded = new Set();
    this.message = "";
    this.input = InputState.new({ placeholder: "Commit message (⏎ to commit)" });
    this.input.on("change", (_e, cx) => { const had = Boolean(this.message.trim()); this.message = this.input.value(); if (had !== Boolean(this.message.trim())) cx.notify(); });
    this.input.on("submit", (_e, cx) => this.commit(cx, false));
    if (checking()) return;
    cx.timer.every(300, (cx) => this.tick(cx));
    cx.timer.every(8000, (cx) => this.refresh(cx));
    cx.timer.every(300000, (cx) => this.backgroundFetch(cx));
    // File events only mark the panel stale; one refresh per 1.5s at most.
    cx.timer.every(1500, (cx) => { if (this.stale) { this.stale = false; this.refresh(cx); } });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.input.focus();
        else if (c === "commit") this.commit(cx, false);
        cx.notify();
      }
    });
  }

  tick(cx) {
    const space = activeSpace();
    if (space && !project(space)) { ensureProject(space); return; }
    const p = project();
    const key = p ? `${p.on ?? ""}|${p.path}` : null;
    if (key !== this.key) {
      this.key = key; this.p = p; this.top = null; this.state = null; this.historyLoaded = false; this.commits = []; this.commitFiles = {}; this.expanded = new Set(); this.error = null;
      this.watching?.cancel?.(); this.watching = null;
      this.refresh(cx);
      cx.notify();
    }
    const base = this.state?.top ? shared(BASES)?.[this.state.top] : null;
    if (this.state && base && base !== this.state.base) this.refresh(cx);
  }

  // Porcelain paths are relative to the repo top, so once it's known every command runs there.
  git(args, opts = {}) { return exec("git", opts.write ? args : [...READ, ...args], { cwd: this.top ?? this.p.path, on: this.p.on, timeout: opts.timeout ?? 30000 }); }

  watch(cx) {
    if (!this.p || this.p.on || this.watching) return;
    const key = this.key, root = this.p.path;
    cx.spawn(async (cx) => {
      try {
        while (this.key === key) {
          this.watching = watchFolder(root);
          await this.watching;
          this.watching = null;
          if (this.key === key) this.stale = true;
        }
      } catch { this.watching = null; }
    });
  }

  refresh(cx) {
    if (!this.p || this.loading || this.busy) return;
    const key = this.key;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await this.git(["rev-parse", "--show-toplevel"]);
        if (this.key !== key) return;
        if (top.code !== 0) { this.state = { repo: false }; this.publish(); return; }
        const s = { repo: true, top: top.stdout.trim() };
        this.top = s.top;
        const [status, head, branch, staged, unstaged] = await Promise.all([
          this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--branch"]),
          this.git(["rev-parse", "--verify", "-q", "HEAD"]),
          this.git(["rev-parse", "--abbrev-ref", "HEAD"]),
          this.git(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
          this.git(["diff", "--numstat", "-z", "--no-renames"]),
        ]);
        s.hasHead = head.code === 0;
        s.branch = branch.code === 0 ? branch.stdout.trim() : ((await this.git(["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || "(no branch)");
        if (s.branch === "HEAD") s.branch = `detached @ ${head.stdout.trim().slice(0, 7)}`;
        const stagedStat = numstat(staged.stdout), unstagedStat = numstat(unstaged.stdout);
        s.staged = []; s.changes = []; s.ahead = 0; s.behind = 0; s.upstream = null;
        const entries = status.stdout.split("\0");
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e) continue;
          if (e.startsWith("## ")) {
            const m = /\.\.\.(\S+)(?: \[(.*)\])?/.exec(e);
            if (m) { s.upstream = m[1]; s.ahead = +(/ahead (\d+)/.exec(m[2] ?? "")?.[1] ?? 0); s.behind = +(/behind (\d+)/.exec(m[2] ?? "")?.[1] ?? 0); }
            continue;
          }
          const xy = e.slice(0, 2), path = e.slice(3);
          if (xy[0] === "R" || xy[0] === "C") i++; // skip the rename source
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          if (xy === "??") { s.changes.push({ path, mark: "U", fresh: true, ...(unstagedStat[path] ?? {}) }); continue; }
          if (conflict) { s.changes.push({ path, mark: "!", conflict: true }); continue; }
          if (xy[0] !== " ") s.staged.push({ path, mark: letter(xy[0] + " "), ...(stagedStat[path] ?? {}) });
          if (xy[1] !== " ") s.changes.push({ path, mark: letter(" " + xy[1]), ...(unstagedStat[path] ?? {}) });
        }
        s.staged = s.staged.slice(0, MAX); s.changes = s.changes.slice(0, MAX);
        // Branch diff: everything this branch (plus uncommitted work) changed since the base.
        s.base = shared(BASES)?.[s.top] ?? (await this.defaultBase(s.branch));
        s.branchFiles = [];
        if (s.base && s.hasHead) {
          const mb = await this.git(["merge-base", s.base, "HEAD"]);
          if (mb.code === 0) {
            const at = mb.stdout.trim();
            const [names, nums, counts] = await Promise.all([
              this.git(["diff", "--name-status", "-z", "--no-renames", at]),
              this.git(["diff", "--numstat", "-z", "--no-renames", at]),
              this.git(["rev-list", "--left-right", "--count", `${s.base}...HEAD`]),
            ]);
            const stat = numstat(nums.stdout), parts = names.stdout.split("\0");
            for (let i = 0; i + 1 < parts.length; i += 2) s.branchFiles.push({ path: parts[i + 1], mark: parts[i][0], ...(stat[parts[i + 1]] ?? {}) });
            for (const f of s.changes) if (f.fresh) s.branchFiles.push({ path: f.path, mark: "U", ...f });
            const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
            s.baseAhead = ahead || 0; s.baseBehind = behind || 0;
          } else s.baseError = `No common history with ${s.base}`;
        }
        if (this.key !== key) return;
        this.state = s; this.error = null;
        this.publish();
        this.watch(cx);
        if (this.sections.history) await this.loadHistory(key);
      } catch (e) { if (this.key === key) this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async defaultBase(current) {
    const origin = await this.git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
    if (origin.code === 0 && origin.stdout.trim()) {
      const b = origin.stdout.trim();
      if (b.replace(/^origin\//, "") !== current) return b;
    }
    for (const b of ["main", "master", "develop", "dev"]) {
      if (b === current) continue;
      const r = await this.git(["rev-parse", "--verify", "-q", b]);
      if (r.code === 0) return b;
    }
    return null;
  }

  async loadHistory(key) {
    const r = await this.git(["log", "-n", "80", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%D%x1e"]);
    this.historyLoaded = true;
    if (this.key !== key || r.code !== 0) { if (this.key === key) this.commits = []; return; }
    this.commits = r.stdout.split("\x1e").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [sha, short, subject, author, when, refs] = l.split("\x1f");
      return { sha, short, subject, author, when, refs };
    });
  }

  publish() {
    const space = activeSpace();
    if (!space) return;
    const s = this.state;
    const value = s?.repo ? { branch: s.branch, count: s.staged.length + s.changes.length, ahead: s.ahead, behind: s.behind, upstream: s.upstream, base: s.base, top: s.top } : null;
    if (JSON.stringify(shared(SCM)?.[space.id] ?? null) !== JSON.stringify(value)) setShared(SCM, { ...(shared(SCM) ?? {}), [space.id]: value });
  }

  // ---------- actions ----------

  act(cx, label, steps, after) {
    if (this.busy || !this.p) return;
    this.busy = label; this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        for (const args of steps) {
          const r = await this.git(args, { write: true, timeout: 120000 });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        after?.();
      } catch (e) { this.note = `${label} failed: ${String(e.message ?? e).split("\n").slice(-3).join(" ")}`; }
      finally { this.busy = null; this.refresh(cx); cx.notify(); }
    });
  }

  fetch(cx) { if (this.state?.repo && !this.busy) this.act(cx, "Fetch", [["fetch", "--all", "--prune"]]); }
  backgroundFetch(cx) {
    if (!this.state?.repo || this.busy || this.fetching) return;
    this.fetching = true;
    cx.spawn(async (cx) => {
      try { await this.git(["fetch", "--all", "--prune", "--quiet"], { write: true, timeout: 120000 }); } catch {}
      finally { this.fetching = false; this.stale = true; }
    });
  }
  pull(cx) { this.act(cx, "Pull", [["pull", "--ff-only"]]); }
  push(cx) {
    const s = this.state;
    this.act(cx, "Push", [s?.upstream ? ["push"] : ["push", "-u", "origin", "HEAD"]], () => notify({ title: "Pushed", body: s.branch, level: "success", timeout: 2500 }));
  }

  stage(paths, cx) { this.act(cx, "Stage", [["add", "-A", "--", ...paths]]); }
  unstage(paths, cx) { this.act(cx, "Unstage", [this.state.hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-q", "--", ...paths]]); }
  discard(f) {
    openOverlay({ mod: "ide-fileops", kind: "dialog", width: 420, props: { mode: "discard", root: this.state.top, on: this.p.on, rel: f.path, isNew: Boolean(f.fresh) || !this.state.hasHead, hasHead: this.state.hasHead } });
  }

  commit(cx, amend) {
    const s = this.state, message = this.message.trim();
    if (!s?.repo || this.busy || (!message && !amend)) return;
    const steps = s.staged.length ? [] : [["add", "-A"]];
    steps.push(amend ? (message ? ["commit", "--amend", "-m", message] : ["commit", "--amend", "--no-edit"]) : ["commit", "-m", message]);
    this.act(cx, "Commit", steps, () => { this.message = ""; this.input.set_value(""); });
  }

  openDiff(f, ref, cx, preview = true) {
    openInEditor({ kind: "diff", path: `${this.state.top}/${f.path}`, on: this.p.on, root: this.state.top, rel: f.path, ref, preview });
  }

  toggleCommit(c, cx) {
    if (this.expanded.has(c.sha)) { this.expanded.delete(c.sha); cx.notify(); return; }
    this.expanded.add(c.sha);
    if (!this.commitFiles[c.sha]) cx.spawn(async (cx) => {
      const [names, nums] = await Promise.all([
        this.git(["show", "--format=", "--name-status", "-z", "--no-renames", c.sha]),
        this.git(["show", "--format=", "--numstat", "-z", "--no-renames", c.sha]),
      ]);
      const stat = numstat(nums.stdout), parts = names.stdout.split("\0").filter((x, i, a) => x !== "" || i < a.length - 1), files = [];
      for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) files.push({ path: parts[i + 1], mark: parts[i][0], ...(stat[parts[i + 1]] ?? {}) });
      this.commitFiles[c.sha] = files;
      cx.notify();
    });
    cx.notify();
  }

  // ---------- agent turns (recorded by ide-tabs) ----------

  // Puts files back the way they were when the agent started; files it created go.
  revertTurn(turn, file, cx) {
    if (!file && this.confirmTurn !== turn.id) { this.confirmTurn = turn.id; cx.notify(); return; }
    this.confirmTurn = null;
    const files = file ? [file] : turn.files;
    cx.spawn(async (cx) => {
      const failed = [];
      for (const f of files) {
        const r = f.mark === "A"
          ? await exec("rm", ["-f", "--", `${turn.top}/${f.path}`], { on: turn.on }).catch((e) => ({ code: 1, stderr: String(e) }))
          : await exec("git", ["--literal-pathspecs", "restore", `--source=${turn.before}`, "--worktree", "--", f.path], { cwd: turn.top, on: turn.on }).catch((e) => ({ code: 1, stderr: String(e) }));
        if (r.code !== 0) failed.push(`${f.path}: ${(r.stderr || "").trim()}`);
      }
      this.note = failed.length ? `Revert failed: ${failed.join("; ")}` : null;
      if (!failed.length) notify({ title: file ? `Reverted ${file.path}` : `Reverted ${files.length} file${files.length === 1 ? "" : "s"}`, body: `to before ${turn.agent}'s turn`, level: "success", timeout: 2500 });
      this.stale = true;
      cx.notify();
    });
  }

  turnRows(t, s) {
    const turns = (shared(TURNS)?.[activeSpace()?.id] ?? []).filter((x) => x.top === s.top);
    if (!turns.length) return [];
    const ago = (at) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
    const rows = [this.section("turns", "AGENT TURNS", turns.length, t)];
    if (!this.sections.turns) return rows;
    for (const turn of turns.slice(0, 10)) {
      const open = this.expanded.has(turn.id), add = turn.files.reduce((n, f) => n + (f.add ?? 0), 0), del = turn.files.reduce((n, f) => n + (f.del ?? 0), 0);
      rows.push(h_flex().id(`tu-${turn.id}`).h(36).flex_none().pl(10).pr(6).gap(6).items_center().cursor_pointer().hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => { open ? this.expanded.delete(turn.id) : this.expanded.add(turn.id); cx.notify(); })
        .child(svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
        .child(svg("mods/ide-explorer/icons/bot.svg").size(13).flex_none().text_color(t.accent))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12).child(`${turn.agent} · ${turn.tab}`))
          .child(h_flex().gap(6).text_size(10.5).text_color(t.dim).child(div().child(`${turn.files.length} file${turn.files.length === 1 ? "" : "s"} · ${ago(turn.at)}`))
            .child(div().text_color(t.ansi2).child(`+${add}`)).child(div().text_color(t.ansi1).child(`−${del}`))))
        .child(this.icon(`tu-rev-${turn.id}`, "mods/ide-explorer/icons/discard.svg", this.confirmTurn === turn.id ? "Click again: revert every file of this turn" : "Revert this whole turn", (cx) => this.revertTurn(turn, null, cx), t,
          this.confirmTurn === turn.id ? div().text_color(t.ansi1).child("confirm") : null)));
      if (open) for (const f of turn.files) rows.push(this.fileRow(f, `tf-${turn.id}-${f.path}`, t,
        (e) => openInEditor({ kind: "diff", path: `${turn.top}/${f.path}`, on: turn.on, root: turn.top, rel: f.path, ref: `turn:${turn.before}..${turn.after}`, preview: e.click_count < 2 }),
        [this.icon(`tf-rev-${turn.id}-${f.path}`, "mods/ide-explorer/icons/discard.svg", "Revert this file to before the turn", (cx) => this.revertTurn(turn, f, cx), t)], 1));
    }
    return rows;
  }

  // ---------- view ----------

  icon(id, path, tip, action, t, extra) {
    return h_flex().id(id).h(22).px(4).gap(3).items_center().rounded(5).cursor_pointer().text_color(t.dim).text_size(11).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(svg(path).size(13)).when(Boolean(extra), (e) => e.child(extra));
  }

  section(key, title, count, t, actions = []) {
    const open = this.sections[key];
    return h_flex().id(`gs-${key}`).h(26).flex_none().pl(8).pr(6).gap(5).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.sections[key] = !open; if (key === "history" && !open && !this.commits.length) { const k = this.key; cx.spawn(async (cx) => { await this.loadHistory(k); cx.notify(); }); } cx.notify(); })
      .child(svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(title))
      .when(count !== null, (e) => e.child(div().px(5).rounded(8).bg(t.raised).text_size(10.5).text_color(t.muted).child(String(count))))
      .child(div().flex_1())
      .children(actions);
  }

  fileRow(f, id, t, onClick, buttons = [], depth = 0) {
    const name = f.path.split("/").pop(), dir = f.path.slice(0, -name.length).replace(/\/$/, "");
    const color = f.mark === "U" || f.mark === "A" ? t.ansi2 : f.mark === "D" || f.mark === "!" ? t.ansi1 : f.mark === "R" ? t.ansi4 : t.blocked;
    const hovered = this.hover === id;
    return h_flex().id(id).h(24).flex_none().pl(22 + depth * 14).pr(6).gap(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => { const next = h ? id : this.hover === id ? null : this.hover; if (next !== this.hover) { this.hover = next; cx.notify(); } })
      .on_click((e, cx) => onClick(e, cx))
      .child(div().size(7).flex_none().rounded(2).bg(fileTint(name, t)))
      .child(div().flex_none().max_w(170).truncate().text_color(f.mark === "D" ? t.dim : t.foreground).when(f.mark === "D", (e) => e.line_through()).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
      .when(hovered, (e) => e.children(buttons))
      .when(!hovered && Boolean(f.add), (e) => e.child(div().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`)))
      .when(!hovered && Boolean(f.del), (e) => e.child(div().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`)))
      .child(div().w(12).flex_none().text_size(10.5).text_color(color).child(f.mark));
  }

  render() {
    const t = theme(), s = this.state, p = project();
    const head = h_flex().h(34).flex_none().pl(14).pr(6).gap(1).items_center()
      .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("GIT"))
      .when(Boolean(s?.repo), (e) => e
        .child(this.icon("g-fetch", "mods/ide-explorer/icons/fetch.svg", "Fetch all remotes", (cx) => this.fetch(cx), t))
        .child(this.icon("g-pull", "mods/ide-explorer/icons/pull.svg", `Pull (fast-forward only)${s.behind ? ` · ${s.behind} behind` : ""}`, (cx) => this.pull(cx), t, s.behind ? div().child(String(s.behind)) : null))
        .child(this.icon("g-push", "mods/ide-explorer/icons/push.svg", s.upstream ? `Push to ${s.upstream}${s.ahead ? ` · ${s.ahead} ahead` : ""}` : "Publish branch to origin", (cx) => this.push(cx), t, s.ahead ? div().child(String(s.ahead)) : !s.upstream ? div().child("publish") : null)));
    if (!p) return v_flex().size_full().bg(t.chrome).text_color(t.dim).child(head).child(div().p(14).child("No project folder"));
    if (s && !s.repo) return v_flex().size_full().bg(t.chrome).text_color(t.dim).text_size(12.5).child(head)
      .child(v_flex().p(14).gap(10).child(div().child(`${p.name} is not a git repository.`))
        .child(div().id("g-init").h(28).px(12).flex().items_center().justify_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).cursor_pointer()
          .on_click((_e, cx) => this.act(cx, "Init", [["init"]])).child("Initialize repository")));
    if (!s) return v_flex().size_full().bg(t.chrome).text_color(t.dim).child(head).child(div().p(14).child(this.error ?? "Reading repository…"));

    const pickers = h_flex().px(10).pb(6).gap(6).flex_none().items_center().text_size(12)
      .child(h_flex().id("g-branch").min_w(0).flex_1().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).cursor_pointer().hover((x) => x.bg(t.hover))
        .tooltip("Switch or create a branch").on_click(() => openOverlay({ mod: "ide-branches", kind: "popup", width: 460, height: 520, props: { mode: "switch" } }))
        .child(svg("mods/workspace-chrome/git-branch.svg").size(13).flex_none().text_color(t.accent))
        .child(div().min_w(0).flex_1().truncate().child(s.branch))
        .child(svg("mods/files/chevron-down.svg").size(10).flex_none().text_color(t.dim)))
      .child(h_flex().id("g-worktree").flex_none().h(26).px(8).gap(5).items_center().rounded(6).border_1().border_color(t.border).cursor_pointer().hover((x) => x.bg(t.hover))
        .tooltip("Switch worktree (stays in this space)").on_click(() => openOverlay({ mod: "ide-worktrees", kind: "popup", width: 520, height: 460 }))
        .child(svg("mods/ide-explorer/icons/worktree.svg").size(13).text_color(t.muted)).child(div().text_size(11.5).text_color(t.muted).child("worktree")));

    const canCommit = Boolean(this.message.trim()) && !this.busy && (s.staged.length || s.changes.length);
    const commitBox = v_flex().px(10).pb(8).gap(6).flex_none()
      .child(div().id("g-msg").h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.input).bg(t.background).cursor_text()
        .on_key_down((e, cx) => { if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) { this.commit(cx, false); cx.stop_propagation(); } })
        .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(h_flex().gap(6)
        .child(div().id("g-commit").flex_1().h(28).flex().items_center().justify_center().rounded(6).text_size(12).font_medium()
          .bg(canCommit ? t.solid : t.raised).text_color(canCommit ? t.solid_foreground : t.dim).when(Boolean(canCommit), (e) => e.cursor_pointer())
          .on_click((_e, cx) => this.commit(cx, false))
          .child(this.busy ? `${this.busy}…` : s.staged.length ? `Commit ${s.staged.length} staged` : s.changes.length ? `Commit all (${s.changes.length})` : "Nothing to commit"))
        .child(div().id("g-amend").h(28).px(10).flex().items_center().rounded(6).text_size(11.5).bg(t.raised).text_color(t.muted).cursor_pointer().hover((x) => x.text_color(t.foreground))
          .tooltip("Amend the last commit (with this message, or keep its message)").on_click((_e, cx) => this.commit(cx, true)).child("Amend")));

    const rows = this.turnRows(t, s);
    if (s.staged.length) {
      rows.push(this.section("staged", "STAGED", s.staged.length, t, [this.icon("g-unstage-all", "mods/workspace-chrome/minus.svg", "Unstage all", (cx) => this.unstage(s.staged.map((f) => f.path), cx), t)]));
      if (this.sections.staged) for (const f of s.staged) rows.push(this.fileRow(f, `st-${f.path}`, t, (e, cx) => this.openDiff(f, "", cx, e.click_count < 2), [
        this.icon(`st-open-${f.path}`, "mods/ide-explorer/icons/open-file.svg", "Open file", () => openInEditor({ path: `${s.top}/${f.path}`, on: p.on, rel: f.path }), t),
        this.icon(`st-un-${f.path}`, "mods/workspace-chrome/minus.svg", "Unstage", (cx) => this.unstage([f.path], cx), t),
      ]));
    }
    rows.push(this.section("changes", "CHANGES", s.changes.length, t, s.changes.length ? [this.icon("g-stage-all", "mods/workspace-chrome/plus.svg", "Stage all", (cx) => this.stage(s.changes.map((f) => f.path), cx), t)] : []));
    if (this.sections.changes) {
      for (const f of s.changes) rows.push(this.fileRow(f, `ch-${f.path}`, t, (e, cx) => this.openDiff(f, "", cx, e.click_count < 2), [
        this.icon(`ch-open-${f.path}`, "mods/ide-explorer/icons/open-file.svg", "Open file", () => openInEditor({ path: `${s.top}/${f.path}`, on: p.on, rel: f.path }), t),
        !f.conflict && !(p.on && f.fresh) && this.icon(`ch-dis-${f.path}`, "mods/ide-explorer/icons/discard.svg", "Discard changes", () => this.discard(f), t),
        this.icon(`ch-st-${f.path}`, "mods/workspace-chrome/plus.svg", "Stage", (cx) => this.stage([f.path], cx), t),
      ].filter(Boolean)));
      if (!s.changes.length) rows.push(div().pl(26).py(4).text_size(11.5).text_color(t.dim).child("Working tree clean"));
    }
    rows.push(this.section("branch", s.base ? `BRANCH DIFF vs ${s.base}` : "BRANCH DIFF", s.base ? s.branchFiles.length : null, t, [
      this.icon("g-base", "mods/workspace-chrome/git-compare.svg", "Compare against another branch", () => openOverlay({ mod: "ide-branches", kind: "popup", width: 460, height: 520, props: { mode: "base" } }), t),
    ]));
    if (this.sections.branch) {
      if (!s.base) rows.push(div().pl(26).py(4).text_size(11.5).text_color(t.dim).child("Pick a base branch to compare against"));
      else if (s.baseError) rows.push(div().pl(26).py(4).text_size(11.5).text_color(t.ansi1).child(s.baseError));
      else {
        rows.push(h_flex().pl(26).pr(8).h(20).gap(8).items_center().text_size(11).text_color(t.dim)
          .child(div().child(`${s.baseAhead ?? 0} commits ahead · ${s.baseBehind ?? 0} behind`))
          .child(div().text_color(t.ansi2).child(`+${s.branchFiles.reduce((n, f) => n + (f.add ?? 0), 0)}`))
          .child(div().text_color(t.ansi1).child(`−${s.branchFiles.reduce((n, f) => n + (f.del ?? 0), 0)}`)));
        for (const f of s.branchFiles) rows.push(this.fileRow(f, `br-${f.path}`, t, (e, cx) => this.openDiff(f, `base:${s.base}`, cx, e.click_count < 2), [
          this.icon(`br-open-${f.path}`, "mods/ide-explorer/icons/open-file.svg", "Open file", () => openInEditor({ path: `${s.top}/${f.path}`, on: p.on, rel: f.path }), t),
        ]));
      }
    }
    rows.push(this.section("history", "HISTORY", null, t));
    if (this.sections.history) {
      for (const c of this.commits) {
        const open = this.expanded.has(c.sha);
        rows.push(h_flex().id(`c-${c.sha}`).h(36).flex_none().pl(10).pr(8).gap(6).items_center().cursor_pointer().hover((x) => x.bg(t.hover))
          .tooltip(`${c.short} · ${c.author} · ${c.when}${c.refs ? `\n${c.refs}` : ""}`)
          .on_click((_e, cx) => this.toggleCommit(c, cx))
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(c.sha); notify({ title: "Copied commit hash", body: c.short, timeout: 1500 }); })
          .child(svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
          .child(v_flex().flex_1().min_w(0)
            .child(h_flex().gap(6).min_w(0)
              .child(div().flex_1().min_w(0).truncate().text_size(12).child(c.subject))
              .when(Boolean(c.refs), (e) => e.child(div().flex_none().max_w(110).truncate().px(4).rounded(3).bg(t.accent + "26").text_size(10).text_color(t.accent).child(c.refs.replace(/HEAD -> /, "")))))
            .child(div().truncate().text_size(10.5).text_color(t.dim).child(`${c.short} · ${c.author} · ${c.when}`))));
        if (open) for (const f of this.commitFiles[c.sha] ?? []) rows.push(this.fileRow(f, `cf-${c.sha}-${f.path}`, t, (e, cx) => this.openDiff(f, `commit:${c.sha}`, cx, e.click_count < 2), [], 1));
      }
      if (!this.commits.length) rows.push(div().pl(26).py(4).text_size(11.5).text_color(t.dim).child(this.historyLoaded ? (s.hasHead ? "No history" : "No commits yet") : "Loading…"));
    }

    return v_flex().id("ide-git").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .child(head).child(pickers).child(commitBox)
      .when(Boolean(this.note || this.error), (e) => e.child(div().px(12).pb(6).text_size(11).text_color(t.ansi1).child(this.note || this.error)))
      .child(v_flex().id("g-list").flex_1().min_h(0).overflow_y_scrollbar().pb(10).border_t(1).border_color(t.border).children(rows));
  }
}

// Search in files across the project folder (ripgrep, git grep as fallback).
// Results are grouped by file; a click opens the file at that line.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, checking, nextCommand, shared, readTextFile, writeTextFile, notify } from "herdr";
import { project, openInEditor, fileTint, FILETABS, DIRTY } from "./common.js";

const MAX_FILES = 300, MAX_MATCHES = 2000;

export default class Find extends View {
  init(_props, cx) {
    this.groups = []; this.folded = new Set(); this.status = null; this.total = 0;
    this.caseSensitive = false; this.regex = false; this.word = false;
    this.input = InputState.new({ placeholder: "Search" });
    this.include = InputState.new({ placeholder: "files to include, e.g. src/**/*.ts" });
    this.input.on("submit", (_e, cx) => this.search(cx));
    this.include.on("submit", (_e, cx) => this.search(cx));
    this.replaceInput = InputState.new({ placeholder: "Replace (in every matching file)" });
    // Searches as you type, a moment after the last key.
    this.input.on("change", (_e, cx) => { this.typedAt = Date.now(); this.dirty = true; });
    if (checking()) return;
    this.focusAt = shared("ide.find.focus");
    cx.timer.every(250, (cx) => {
      // Results belong to one project: another space or worktree starts over.
      const p = project(), key = p ? `${p.on ?? ""}|${p.path}` : null;
      if (key !== this.projectKey) { const first = this.projectKey === undefined; this.projectKey = key; if (!first) { this.groups = []; this.total = 0; if (this.input.value()) this.search(cx); else cx.notify(); } }
    });
    cx.timer.every(250, (cx) => { const f = shared("ide.find.focus"); if (f !== this.focusAt) { this.focusAt = f; this.input.focus(); } if (this.dirty && Date.now() - this.typedAt > 350) { this.dirty = false; this.search(cx); } });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") { this.input.focus(); cx.notify(); }
      }
    });
  }

  search(cx) {
    this.confirmReplace = false;
    const p = project(), query = this.input.value();
    const run = Symbol();
    this.run = run;
    if (!p || !query) { this.groups = []; this.total = 0; this.status = p ? null : "No project folder"; cx.notify(); return; }
    this.status = "Searching…";
    cx.notify();
    const args = ["--line-number", "--column", "--no-heading", "--color", "never", "--max-columns", "300", "--max-columns-preview", "--max-count", "200", "--hidden", "-g", "!.git", "--null"];
    args.push(this.caseSensitive ? "--case-sensitive" : "--ignore-case");
    if (!this.regex) args.push("--fixed-strings");
    if (this.word) args.push("--word-regexp");
    const include = this.include.value().trim();
    for (const glob of include ? include.split(",").map((g) => g.trim()).filter(Boolean) : []) args.push("-g", glob);
    args.push("--", query, ".");
    cx.spawn(async (cx) => {
      let r = await exec("rg", args, { cwd: p.path, on: p.on, timeout: 20000 }).catch(() => null);
      let nullSep = true;
      if (!r || (r.code > 1 && /not found|No such file/i.test(r.stderr ?? ""))) {
        nullSep = false;
        const g = ["grep", "-n", "--column", "-I", ...(this.caseSensitive ? [] : ["-i"]), ...(this.regex ? ["-E"] : ["-F"]), ...(this.word ? ["-w"] : []), "-e", query];
        r = await exec("git", g, { cwd: p.path, on: p.on, timeout: 20000 }).catch(() => null);
      }
      if (this.run !== run) return;
      if (!r) { this.status = "Search failed"; cx.notify(); return; }
      // ripgrep exits 2 when some file couldn't be read, even with matches: keep them.
      if (r.code > 1 && !r.stdout) { this.status = (r.stderr || "Search failed").trim().split("\n")[0]; this.groups = []; cx.notify(); return; }
      const byFile = new Map();
      let total = 0;
      for (const line of r.stdout.split("\n")) {
        if (!line || total >= MAX_MATCHES) continue;
        let file, rest;
        if (nullSep) { const i = line.indexOf("\0"); if (i < 0) continue; file = line.slice(0, i); rest = line.slice(i + 1); }
        else { const m = /^([^:]+):(.*)$/.exec(line); if (!m) continue; file = m[1]; rest = m[2]; }
        const m = /^(\d+):(\d+):(.*)$/.exec(rest);
        if (!m) continue;
        file = file.replace(/^\.\//, "");
        if (!byFile.has(file)) { if (byFile.size >= MAX_FILES) continue; byFile.set(file, []); }
        byFile.get(file).push({ line: +m[1], column: +m[2], text: m[3] });
        total++;
      }
      this.groups = [...byFile.entries()].map(([file, matches]) => ({ file, matches }));
      this.total = total;
      this.root = p.path; this.on = p.on;
      this.status = total ? null : "No results";
      cx.notify();
    });
  }

  // Replaces every match in the listed files, from what's on disk now. Files with
  // unsaved edits are skipped; a file that changed meanwhile refuses the write.
  replaceAll(cx) {
    if (!this.groups.length || this.replacing || !this.root || this.on) return;
    if (!this.confirmReplace) { this.confirmReplace = true; cx.notify(); return; }
    this.confirmReplace = false; this.replacing = true;
    const q = this.input.value(), repl = this.replaceInput.value(), root = this.root;
    let src = this.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (this.word) src = `\\b(?:${src})\\b`;
    const re = new RegExp(src, "gm" + (this.caseSensitive ? "" : "i"));
    const dirty = shared(DIRTY) ?? {}, tabs = shared(FILETABS) ?? {};
    const unsaved = new Set(Object.entries(tabs).filter(([u]) => dirty[u]).map(([, e]) => e.path));
    const files = this.groups.map((g) => g.file);
    cx.notify();
    cx.spawn(async (cx) => {
      let changed = 0, count = 0; const skipped = [], failed = [];
      for (const file of files) {
        const path = `${root}/${file}`;
        if (unsaved.has(path)) { skipped.push(file); continue; }
        try {
          const text = await readTextFile(path);
          const n = (text.match(re) ?? []).length;
          if (!n) continue;
          const next = this.regex ? text.replace(re, repl) : text.replace(re, () => repl);
          await writeTextFile(path, next, text);
          changed++; count += n;
        } catch (e) { failed.push(file); }
      }
      this.replacing = false;
      notify({ title: `Replaced ${count} in ${changed} file${changed === 1 ? "" : "s"}`, body: [skipped.length ? `Skipped (unsaved): ${skipped.join(", ")}` : "", failed.length ? `Failed: ${failed.join(", ")}` : ""].filter(Boolean).join("\n") || undefined, level: failed.length ? "warning" : "success" });
      this.search(cx);
    });
  }

  toggle(key, cx) { this[key] = !this[key]; this.search(cx); }

  flag(id, label, on, key, tip, t) {
    return div().id(id).h(20).px(4).flex().items_center().rounded(4).cursor_pointer().text_size(11).font_semibold().tooltip(tip)
      .bg(on ? t.accent + "33" : t.chrome).text_color(on ? t.foreground : t.dim).border_1().border_color(on ? t.accent : t.chrome)
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.toggle(key, cx)).child(label);
  }

  // The match line with the found text highlighted.
  preview(m, t) {
    const text = m.text.replace(/\t/g, "  "), start = Math.max(0, m.column - 1);
    const q = this.input.value();
    let len = q.length;
    if (this.regex) {
      try { const re = new RegExp(q, this.caseSensitive ? "" : "i"); const found = re.exec(m.text.slice(start)); len = found?.[0]?.length || q.length; } catch {}
    }
    const lead = start > 24 ? "…" + text.slice(start - 20, start) : text.slice(0, start);
    return h_flex().min_w(0).flex_1().overflow_hidden().whitespace_nowrap()
      .child(div().flex_none().text_color(t.muted).child(lead.trimStart()))
      .child(div().flex_none().bg(t.blocked + "40").rounded(2).child(text.slice(start, start + len)))
      .child(div().min_w(0).truncate().text_color(t.muted).child(text.slice(start + len)));
  }

  render() {
    const t = theme();
    const field = (state, id) => div().id(id).h(28).px(8).flex().items_center().rounded(5).border_1().border_color(t.input).bg(t.background).cursor_text()
      .child(Input.new(state).flex_1().h_full().text_size(12.5).text_color(t.foreground));
    return v_flex().id("ide-find").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(34).flex_none().px(14).items_center().child(div().text_size(11).font_semibold().text_color(t.muted).child("SEARCH")))
      .child(v_flex().px(10).gap(6).flex_none()
        .child(h_flex().gap(4).items_center()
          .child(div().flex_1().child(field(this.input, "find-q")))
          .child(this.flag("find-case", "Aa", this.caseSensitive, "caseSensitive", "Match case", t))
          .child(this.flag("find-word", "ab", this.word, "word", "Whole word", t))
          .child(this.flag("find-re", ".*", this.regex, "regex", "Regular expression", t)))
        .child(h_flex().gap(4).items_center()
          .child(div().flex_1().child(field(this.replaceInput, "find-replace")))
          .child(div().id("find-replace-all").h(26).px(8).flex().items_center().rounded(5).cursor_pointer().text_size(11.5)
            .bg(this.confirmReplace ? t.ansi1 : t.raised).text_color(this.confirmReplace ? t.background : t.foreground).hover((x) => x.opacity(0.85))
            .tooltip(this.on ? "Remote projects: not supported" : "Replace every match in the listed files (unsaved files are skipped)")
            .on_click((_e, cx) => this.replaceAll(cx))
            .child(this.replacing ? "Replacing…" : this.confirmReplace ? `Confirm: ${this.groups.length} files` : "Replace all")))
        .child(field(this.include, "find-include"))
        .child(div().h(18).text_size(11).text_color(t.dim).child(this.status ?? (this.total ? `${this.total}${this.total >= MAX_MATCHES ? "+" : ""} results in ${this.groups.length} files` : ""))))
      .child(v_flex().id("find-results").flex_1().min_h(0).overflow_y_scrollbar().pb(10)
        .children(this.groups.flatMap((g) => {
          const name = g.file.split("/").pop(), dir = g.file.slice(0, -name.length).replace(/\/$/, ""), folded = this.folded.has(g.file);
          const head = h_flex().id(`fg-${g.file}`).h(24).flex_none().px(8).gap(5).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { folded ? this.folded.delete(g.file) : this.folded.add(g.file); cx.notify(); })
            .child(svg(`mods/files/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim))
            .child(div().size(7).flex_none().rounded(2).bg(fileTint(name, t)))
            .child(div().flex_none().max_w(180).truncate().child(name))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
            .child(div().px(5).rounded(8).bg(t.raised).text_size(10.5).text_color(t.muted).child(String(g.matches.length)));
          if (folded) return [head];
          return [head, ...g.matches.map((m, i) => h_flex().id(`fm-${g.file}-${i}`).h(22).flex_none().pl(30).pr(8).gap(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((e) => openInEditor({ path: `${this.root}/${g.file}`, on: this.on, rel: g.file, line: m.line, column: m.column, preview: e.click_count < 2 }))
            .child(div().w(30).flex_none().text_right().text_size(10.5).text_color(t.dim).child(String(m.line)))
            .child(this.preview(m, t)))];
        })));
  }
}

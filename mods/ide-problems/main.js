// Problems: runs the checkers this project has (TypeScript, ESLint, Ruff, go vet,
// cargo check) in the project folder and lists what they report, grouped by file.
// A click opens the file at the line. Re-runs after a save (shared "ide.saved").
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, shared, setShared, checking } from "herdr";
import { project, activeSpace, openInEditor, fileTint, sh } from "./common.js";

const PROBLEMS = "ide.problems"; // { [spaceId]: { errors, warnings } }

// Which checkers apply, decided by files in the project folder.
async function detect(root, on) {
  const r = await sh('cd "$1" || exit 1; for f in tsconfig.json node_modules/.bin/tsc node_modules/.bin/eslint pyproject.toml ruff.toml .ruff.toml setup.py requirements.txt go.mod Cargo.toml; do [ -e "$f" ] && echo "$f"; done; ls *.py 2>/dev/null | head -1; command -v ruff >/dev/null && echo has:ruff; command -v go >/dev/null && echo has:go; command -v cargo >/dev/null && echo has:cargo; true', [root], { on });
  const has = new Set(r.stdout.split("\n").filter(Boolean)), list = [];
  if (has.has("tsconfig.json") && has.has("node_modules/.bin/tsc")) list.push("tsc");
  if (has.has("node_modules/.bin/eslint")) list.push("eslint");
  if (has.has("has:ruff") && [...has].some((f) => /\.py$|pyproject|ruff|setup\.py|requirements/.test(f))) list.push("ruff");
  if (has.has("go.mod") && has.has("has:go")) list.push("go");
  if (has.has("Cargo.toml") && has.has("has:cargo")) list.push("cargo");
  return list;
}

const CHECKERS = {
  tsc: { label: "TypeScript", cmd: ["node_modules/.bin/tsc", ["--noEmit", "--pretty", "false"]], parse(out) {
    return out.split("\n").map((l) => /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(l)).filter(Boolean)
      .map((m) => ({ file: m[1], line: +m[2], column: +m[3], severity: m[4], code: m[5], message: m[6] }));
  } },
  eslint: { label: "ESLint", cmd: ["node_modules/.bin/eslint", ["-f", "json", "."]], parse(out, root) {
    try {
      return JSON.parse(out).flatMap((f) => f.messages.map((m) => ({ file: f.filePath.startsWith(root + "/") ? f.filePath.slice(root.length + 1) : f.filePath, line: m.line ?? 1, column: m.column ?? 1, severity: m.severity === 2 ? "error" : "warning", code: m.ruleId ?? "", message: m.message })));
    } catch { return []; }
  } },
  ruff: { label: "Ruff", cmd: ["ruff", ["check", "--output-format", "json", "."]], parse(out, root) {
    try {
      return JSON.parse(out).map((m) => ({ file: m.filename.startsWith(root + "/") ? m.filename.slice(root.length + 1) : m.filename, line: m.location?.row ?? 1, column: m.location?.column ?? 1, severity: "error", code: m.code ?? "", message: m.message }));
    } catch { return []; }
  } },
  go: { label: "go vet", cmd: ["go", ["vet", "./..."]], parse(out) {
    return out.split("\n").map((l) => /^(?:\.\/)?(.+?\.go):(\d+):(\d+): (.*)$/.exec(l)).filter(Boolean).map((m) => ({ file: m[1], line: +m[2], column: +m[3], severity: "error", code: "vet", message: m[4] }));
  } },
  cargo: { label: "cargo check", cmd: ["cargo", ["check", "--message-format", "short", "--quiet"]], parse(out) {
    return out.split("\n").map((l) => /^(.+?\.rs):(\d+):(\d+): (error|warning)(?:\[(\w+)\])?: (.*)$/.exec(l)).filter(Boolean).map((m) => ({ file: m[1], line: +m[2], column: +m[3], severity: m[4], code: m[5] ?? "", message: m[6] }));
  } },
};

export default class Problems extends View {
  init(_props, cx) {
    this.items = []; this.checkers = []; this.folded = new Set(); this.status = null; this.ran = {};
    this.savedAt = shared("ide.saved")?.at;
    if (checking()) return;
    cx.timer.every(500, (cx) => this.tick(cx));
  }

  tick(cx) {
    const p = project(), key = p ? `${p.on ?? ""}|${p.path}` : null;
    if (key !== this.key) { this.key = key; this.items = []; this.checkers = []; this.status = null; if (p) this.run(cx); cx.notify(); return; }
    const saved = shared("ide.saved");
    if (saved && saved.at !== this.savedAt) { this.savedAt = saved.at; if (p && saved.path.startsWith(p.path + "/")) this.pending = Date.now(); }
    if (this.pending && Date.now() - this.pending > 1200 && !this.running) { this.pending = null; this.run(cx); }
  }

  run(cx) {
    const p = project(), key = this.key;
    if (!p || this.running) return;
    this.running = true; this.status = "Checking…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.checkers = await detect(p.path, p.on);
        if (!this.checkers.length) { this.items = []; this.status = "No checker found for this project (TypeScript, ESLint, Ruff, go vet, cargo)"; return; }
        const all = [];
        for (const id of this.checkers) {
          const c = CHECKERS[id];
          const r = await exec(c.cmd[0], c.cmd[1], { cwd: p.path, on: p.on, timeout: 300000 }).catch((e) => ({ stdout: "", stderr: String(e), code: 127 }));
          if (this.key !== key) return;
          const found = c.parse(r.stdout + "\n" + r.stderr, p.path).map((x) => ({ ...x, source: c.label }));
          this.ran[id] = found.length;
          all.push(...found);
        }
        this.items = all.slice(0, 3000);
        this.status = null;
        const space = activeSpace();
        if (space) setShared(PROBLEMS, { ...(shared(PROBLEMS) ?? {}), [space.id]: { errors: all.filter((x) => x.severity === "error").length, warnings: all.filter((x) => x.severity !== "error").length } });
      } catch (e) { this.status = String(e.message ?? e); }
      finally { this.running = false; this.at = Date.now(); cx.notify(); }
    });
  }

  render() {
    const t = theme(), p = project();
    const groups = new Map();
    for (const it of this.items) { if (!groups.has(it.file)) groups.set(it.file, []); groups.get(it.file).push(it); }
    const errors = this.items.filter((x) => x.severity === "error").length;
    return v_flex().id("ide-problems").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(34).flex_none().pl(14).pr(6).gap(6).items_center()
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("PROBLEMS"))
        .when(this.items.length > 0, (e) => e.child(div().text_size(11).text_color(errors ? t.ansi1 : t.blocked).child(`${errors} errors · ${this.items.length - errors} warnings`)))
        .child(div().id("pr-run").p(4).rounded(5).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Run checks again")
          .on_click((_e, cx) => this.run(cx)).child(svg("mods/ide-explorer/icons/refresh.svg").size(13).when(Boolean(this.running), (x) => x.spin(900)))))
      .child(div().px(14).pb(6).text_size(11).text_color(t.dim).child(this.checkers.length ? `${this.checkers.map((c) => CHECKERS[c].label).join(" · ")} · re-runs after you save` : ""))
      .child(v_flex().id("pr-list").flex_1().min_h(0).overflow_y_scrollbar().pb(10)
        .children([...groups.entries()].flatMap(([file, list]) => {
          const name = file.split("/").pop(), folded = this.folded.has(file);
          const head = h_flex().id(`pg-${file}`).h(24).flex_none().px(8).gap(5).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { folded ? this.folded.delete(file) : this.folded.add(file); cx.notify(); })
            .child(svg(`mods/files/chevron-${folded ? "right" : "down"}.svg`).size(11).text_color(t.dim))
            .child(div().size(7).rounded(2).bg(fileTint(name, t)))
            .child(div().flex_none().max_w(170).truncate().child(name))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(file.slice(0, -name.length)))
            .child(div().px(5).rounded(8).bg(t.raised).text_size(10.5).text_color(t.muted).child(String(list.length)));
          if (folded) return [head];
          return [head, ...list.map((it, i) => h_flex().id(`pi-${file}-${i}`).min_h(24).flex_none().pl(26).pr(8).py(3).gap(6).items_start().cursor_pointer().hover((s) => s.bg(t.hover))
            .tooltip(`${it.source} ${it.code}`.trim())
            .on_click(() => openInEditor({ path: it.file.startsWith("/") ? it.file : `${p.path}/${it.file}`, on: p.on, rel: it.file, line: it.line, column: it.column }))
            .child(div().size(7).mt(5).flex_none().rounded(4).bg(it.severity === "error" ? t.ansi1 : t.blocked))
            .child(div().flex_1().min_w(0).child(it.message))
            .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${it.line}:${it.column}`)))];
        }))
        .when(!this.items.length, (e) => e.child(div().p(12).text_color(t.dim).child(this.status ?? (p ? "No problems found" : "No project folder")))));
  }
}

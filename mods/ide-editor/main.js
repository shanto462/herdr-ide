// One file (or diff) as a pane. Files are ordinary Herdr tabs, side by side with
// terminals and agents; ide-tabs opens them (shared "ide.open") and keeps the
// registry "ide.filetabs" { uid: { tab, space, kind, path, ... } }. Props: the same
// descriptor plus its uid. Unsaved edits are kept as drafts on disk, so closing the
// tab or Herdr never loses them.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Scrollbar, v_virtual_list, InputState, Input } from "gpui-base";
import * as fs from "fs/promises";
import { props, shared, setShared, exec, notify, openOverlay, appHome, readTextFile, writeTextFile, nextCommand, theme, settings, checking, run, spaces, panes, focused } from "herdr";
import { FS, CMD, FILETABS, DIRTY, GOTO, CURSOR, activeSpace, project, relTo, openInEditor, closeTab } from "./common.js";
import { resolveLink, findHeading } from "./links.js";

// Names the built-in highlighter accepts.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", pyi: "py", yml: "yaml", toml: "yaml", jsonc: "json", bash: "sh", zsh: "sh", ps1: "sh", env: "sh", example: "sh", gitignore: "sh", dockerignore: "sh", gitattributes: "sh", claudeignore: "sh", csproj: "xml", props: "xml", targets: "xml", config: "xml", svg: "xml", cshtml: "html", tex: "txt", sty: "txt", cls: "txt" };
const language = (name) => {
  if (/^dockerfile/i.test(name)) return "sh";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "txt";
  return LANG[ext] ?? ext;
};
// Viewers for what isn't text. Previews are rendered into the app folder
// (image() only loads from there), keyed by path and modification time.
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|ico|icns|svg|avif)$/i;
const DIRECT = /\.(png|jpe?g|gif|webp|svg)$/i;
const PDF = /\.pdf$/i;
const QUICKLOOK = /\.(docx?|xlsx?|pptx?|key|pages|numbers|rtf|rtfd|odt|ods|odp|epub|psd|ai|sketch|mov|mp4|m4v)$/i;
const CSV = /\.(csv|tsv)$/i;
const BINARY = /\.(pdf|zip|gz|tgz|bz2|xz|7z|rar|dmg|iso|docx?|xlsx?|pptx?|key|numbers|pages|mp[34]|mov|avi|mkv|wav|flac|ogg|woff2?|ttf|otf|eot|jar|class|o|a|so|dylib|dll|exe|bin|sqlite3?|db|ico|icns|psd|ai|sketch|fig|DS_Store)$/i;
const LIMIT = 400000;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// Drafts: unsaved edits, by path.
const draftsDir = () => `${appHome()}/data/ide-drafts`;
const draftFile = (path) => {
  let hash = 5381;
  for (let i = 0; i < path.length; i++) hash = (hash * 33 + path.charCodeAt(i)) >>> 0;
  return `${draftsDir()}/${hash.toString(36)}-${path.length}.json`;
};
const writeDraft = async (path, value, disk) => {
  await fs.mkdir(draftsDir(), { recursive: true });
  await fs.writeFile(draftFile(path), JSON.stringify({ path, value, disk }));
};
const readDraft = async (path) => {
  try { const d = JSON.parse(await fs.readFile(draftFile(path), "utf8")); return d.path === path ? d : null; }
  catch { return null; }
};
const dropDraft = async (path) => { try { await fs.unlink(draftFile(path)); } catch {} };

// ref: "" (working tree vs HEAD), "base:<branch>" (vs merge-base with that branch), "commit:<sha>".
const hashOf = (text) => {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
};
const previewDir = () => `${appHome()}/data/ide-preview`;
const human = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function parseCsv(text, sep) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length && rows.length < 5000; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const idOf = (d) => `${d.kind ?? "file"}|${d.on ?? ""}|${d.path}|${d.kind === "diff" ? d.ref ?? "" : ""}`;

function diffRows(lines) {
  let old = 0, next = 0, hunk = -1;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; hunk++; return { kind: "@", text: line, hunk }; }
    const kind = line[0];
    if (kind === "-") return { kind, a: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, b: next++, text: line.slice(1) || " " };
    if (kind === " ") return { kind, a: old++, b: next++, text: line.slice(1) || " " };
    return { kind: "", text: line };
  });
}

export default class IdeEditor extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.uid = p.uid ?? `p-${hashOf(`${p.kind}|${p.path}|${p.ref ?? ""}`)}`;
    const name = (p.path ?? "untitled").split("/").pop();
    this.b = { id: this.uid, kind: p.kind ?? "file", path: p.path ?? "", on: p.on ?? null, root: p.root ?? null, rel: p.rel ?? null, ref: p.kind === "diff" ? p.ref ?? "" : "", name, state: p.path ? "new" : "ready", generation: 0, view: 0 };
    if (p.line) { this.b.line = p.line; this.b.column = p.column ?? 1; }
    this.lastFs = shared(FS)?.at; this.lastGoto = shared(GOTO)?.at; this.lastCmd = shared(CMD)?.at;
    this.dirtyShared = null;
    this.find = { open: false, replaceOpen: false, caseSensitive: false, word: false, regex: false, matches: [], at: -1 };
    this.find.input = InputState.new({ placeholder: "Find" });
    this.find.replace = InputState.new({ placeholder: "Replace" });
    this.find.input.on("change", (_e, cx) => { this.findMatches(cx); this.showMatch(); cx.notify(); });
    this.find.input.on("submit", (_e, cx) => this.step(1, cx));
    this.find.replace.on("submit", (_e, cx) => this.replaceOne(cx));
    if (checking()) return;
    cx.timer.every(120, (cx) => this.tick(cx));
    cx.timer.every(1000, (cx) => this.flush(cx));
    cx.timer.every(2500, (cx) => this.poll(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (this.isTarget()) this.command(command, cx);
        cx.notify();
      }
    });
  }

  async close() {
    const b = this.b;
    if (b.code && b.dirty && !b.on) await writeDraft(b.path, b.code.value(), b.disk).catch(() => {});
    if (this.dirtyShared !== null) { const d = { ...(shared(DIRTY) ?? {}) }; delete d[this.uid]; setShared(DIRTY, d); }
    b.code?.release();
  }

  rel(b) { return b.rel ?? relTo(b.root ?? project()?.path, b.path); }
  me() { return (shared(FILETABS) ?? {})[this.uid] ?? null; }
  shown() {
    const tab = this.me()?.tab, space = activeSpace();
    return Boolean(tab && space?.tabs.some((t) => t.id === tab && t.active));
  }
  // Keys go to the editor you're in: the focused pane, or the only editor in the shown tab.
  isTarget() {
    if (!this.shown()) return false;
    const tab = this.me().tab, mine = panes().filter((p) => p.tab === tab && p.mod === "ide-editor");
    if (mine.length <= 1) return true;
    const f = panes().find((p) => p.pane === focused()?.pane);
    return f?.mod === "ide-editor" && f.tab === tab;
  }

  publishDirty() {
    const dirty = Boolean(this.b.dirty);
    if (dirty === this.dirtyShared) return;
    this.dirtyShared = dirty;
    setShared(DIRTY, { ...(shared(DIRTY) ?? {}), [this.uid]: dirty });
  }

  command(c, cx) {
    const b = this.b;
    if (c === "save") this.save(b, cx);
    else if (c === "revert") { if (b.dirty) this.revert(b, cx); }
    else if (c === "preview") { if (b.markdown) { b.mdPreview = !b.mdPreview; b.view++; } }
    else if (c === "focus") { if (b.code) b.code.focus(); }
    else if (c === "reveal") { if (!b.on) exec("open", ["-R", b.path]); }
    else if (c === "find") this.openFind(false, cx);
    else if (c === "find_replace") this.openFind(true, cx);
    else if (c === "goto_line") openOverlay({ mod: "ide-quickopen", kind: "popup", width: 680, height: 560, props: { line: true } });
    // From the unsaved-close prompt.
    else if (c === "save_close") { this.closeAfterSave = true; this.save(b, cx); }
    else if (c === "discard_close") { if (b.dirty) { b.code.set_value(b.disk ?? ""); b.dirty = false; b.draftStale = false; dropDraft(b.path); } const tab = this.me()?.tab; if (tab) closeTab(tab); }
  }

  tick(cx) {
    const b = this.b;
    const ev = shared(FS);
    if (ev && ev.at !== this.lastFs) { this.lastFs = ev.at; this.fsEvent(ev, cx); }
    const g = shared(GOTO);
    if (g && g.at !== this.lastGoto) { this.lastGoto = g.at; if (g.uid === this.uid) { b.line = g.line; b.column = g.column ?? 1; } }
    const c = shared(CMD);
    if (c && c.at !== this.lastCmd) { this.lastCmd = c.at; if (c.id === this.uid) { this.command(c.command, cx); cx.notify(); } }
    if ((b.state === "new" || b.state === "stale") && !b.loading && b.path) this.load(b, cx);
    if (b.code && b.line && !b.loading) this.goLine(b, cx);
    if (b.code && b.wantFocus) { b.wantFocus = false; b.code.focus(); }
    this.publishDirty();
    if (b.code && Date.now() - (this.cursorAt ?? 0) > 250 && this.isTarget()) {
      this.cursorAt = Date.now();
      const at = b.code.selected_range().end;
      if (at !== this.cursorOffset) {
        this.cursorOffset = at;
        const before = b.code.value().slice(0, at), line = before.split("\n").length, column = at - before.lastIndexOf("\n");
        setShared(CURSOR, { uid: this.uid, line, column });
      }
    }
  }

  flush() {
    const b = this.b;
    if (!b.draftStale || !b.code || !b.dirty || b.on) return;
    b.draftStale = false;
    writeDraft(b.path, b.code.value(), b.disk).catch(() => { b.draftStale = true; });
  }

  // Claude may be editing the file: pick up changes on disk while shown.
  poll(cx) {
    const b = this.b;
    if (!this.shown() || b.loading || b.saving || b.state === "new") return;
    if (b.kind === "file") this.load(b, cx);
    else if (b.kind === "diff" && !b.ref.startsWith("commit:") && !b.ref.startsWith("turn:")) this.load(b, cx);
  }

  goLine(b, cx) {
    const text = b.code.value(), lines = text.split("\n");
    const line = Math.max(1, Math.min(b.line, lines.length));
    let offset = 0;
    for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1;
    offset += Math.max(0, Math.min((b.column ?? 1) - 1, lines[line - 1]?.length ?? 0));
    b.line = null;
    try { b.code.set_selected_range({ start: offset, end: offset }); } catch {}
    b.code.focus();
    if (b.markdown && b.mdPreview) { b.mdPreview = false; b.view++; }
    cx.notify();
  }

  fsEvent(ev, cx) {
    const b = this.b, me = this.me();
    if (ev.kind === "moved" && (b.path === ev.from || b.path.startsWith(`${ev.from}/`))) {
      if (b.dirty && !b.on) { dropDraft(b.path); b.draftStale = true; }
      b.path = ev.to + b.path.slice(ev.from.length); b.name = b.path.split("/").pop(); b.rel = null;
      if (me) {
        setShared(FILETABS, { ...(shared(FILETABS) ?? {}), [this.uid]: { ...me, path: b.path, rel: null } });
        run("tab.rename", { id: me.tab, name: b.name });
      }
      cx.notify();
    } else if (ev.kind === "removed" && (b.path === ev.path || b.path.startsWith(`${ev.path}/`)) && !b.dirty && me) {
      run("tab.close", { id: me.tab, confirmed: true });
    }
  }

  // ---------- loading ----------

  load(b, cx) {
    if (b.kind === "diff") return this.loadDiff(b, cx);
    if (!b.viewer) b.viewer = b.on ? (BINARY.test(b.name) || IMAGE.test(b.name) ? "binary" : "text")
      : IMAGE.test(b.name) ? "image" : PDF.test(b.name) ? "pdf" : QUICKLOOK.test(b.name) ? "quicklook" : BINARY.test(b.name) ? "binary" : "text";
    if (b.viewer !== "text") return this.loadPreview(b, cx);
    b.loading = true;
    const generation = b.generation;
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        let text = await readTextFile(b.path, { on: b.on }).catch(() => null);
        if (generation !== b.generation) return;
        if (text === null && !b.code && !b.on) {
          // Not UTF-8: text in another encoding is shown read-only, anything else gets a viewer.
          const mime = await exec("file", ["-b", "--mime", b.path]).catch(() => null);
          const m = /^([^;]+);\s*charset=(\S+)/.exec(mime?.stdout?.trim() ?? "");
          if (m && m[2] !== "binary" && (m[1].startsWith("text/") || m[1].includes("json") || m[1].includes("xml"))) {
            const conv = await exec("iconv", ["-f", m[2] === "unknown-8bit" ? "WINDOWS-1252" : m[2].toUpperCase(), "-t", "UTF-8", b.path]).catch(() => null);
            if (conv?.code === 0) { text = conv.stdout; b.encoding = m[2]; }
          }
          if (text === null) { b.viewer = "binary"; b.state = "new"; changed = true; return; }
        }
        if (b.state === "new" || b.state === "stale" || !b.code) {
          if (b.state !== "new" && !b.code && text === b.disk) return;
          const draft = b.on ? null : await readDraft(b.path);
          this.show(b, text, draft);
          b.state = "ready";
          changed = true;
          return;
        }
        if (text === b.disk) { if (b.changed) { b.changed = false; b.latest = null; changed = true; } return; }
        if (b.dirty || text === null) {
          if (!b.changed || text !== b.latest) { b.changed = true; b.latest = text; changed = true; }
          return;
        }
        // Clean buffer, file changed on disk: take it, keep the cursor where it was.
        const sel = b.code.selected_range();
        b.disk = text;
        b.code.set_value(text);
        try { const end = Math.min(sel.end, text.length); b.code.set_selected_range({ start: Math.min(sel.start, end), end }); } catch {}
        b.dirty = false; b.changed = false; b.latest = null;
        changed = true;
      } finally {
        b.loading = false;
        if (changed) cx.notify();
      }
    });
  }

  // Renders (or re-renders, when the file changed) the preview of a non-text file.
  loadPreview(b, cx) {
    if (b.loading) return;
    b.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (b.on) { b.state = "ready"; return; }
        const st = await exec("stat", ["-f", "%m %z", b.path]).catch(() => null);
        if (st?.code !== 0) { b.error = "This file is gone from disk."; b.pages = null; b.state = "ready"; cx.notify(); return; }
        const [mtime, size] = st.stdout.trim().split(" ");
        if (b.previewMtime === mtime && b.state === "ready") return;
        b.size = Number(size);
        if (!b.fileType) b.fileType = (await exec("file", ["-b", b.path]).catch(() => null))?.stdout?.trim().split(",")[0] ?? "";
        const dir = previewDir(), key = hashOf(b.path), stem = `${key}-${mtime}`;
        await exec("mkdir", ["-p", dir]);
        // Old renders of this file go first.
        await exec("sh", ["-c", 'rm -f "$1"/"$2"-*', "rm", dir, key]);
        let files = [];
        if (b.viewer === "image") {
          const ext = b.name.split(".").pop().toLowerCase();
          if (DIRECT.test(b.name)) { await exec("cp", [b.path, `${dir}/${stem}.${ext}`]); files = [`${stem}.${ext}`]; }
          else { const r = await exec("sips", ["-s", "format", "png", b.path, "--out", `${dir}/${stem}.png`]); if (r.code === 0) files = [`${stem}.png`]; }
        } else if (b.viewer === "pdf") {
          const info = await exec("pdfinfo", [b.path]).catch(() => null);
          b.pageCount = Number(/Pages:\s+(\d+)/.exec(info?.stdout ?? "")?.[1] ?? 0) || null;
          const r = await exec("pdftoppm", ["-png", "-r", "130", "-l", "60", b.path, `${dir}/${stem}`], { timeout: 120000 }).catch(() => null);
          if (r?.code === 0) {
            const ls = await exec("sh", ["-c", 'cd "$1" && ls -1 "$2"-*.png 2>/dev/null', "ls", dir, stem]);
            files = ls.stdout.split("\n").filter(Boolean).sort();
          } else {
            const q = await exec("qlmanage", ["-t", "-s", "1600", "-o", dir, b.path]).catch(() => null);
            if (q?.code === 0) { await exec("mv", [`${dir}/${b.name}.png`, `${dir}/${stem}.png`]).catch(() => null); files = [`${stem}.png`]; }
          }
        } else if (b.viewer === "quicklook") {
          const q = await exec("qlmanage", ["-t", "-s", "1600", "-o", dir, b.path], { timeout: 60000 }).catch(() => null);
          if (q?.code === 0) {
            const mv = await exec("mv", [`${dir}/${b.name}.png`, `${dir}/${stem}.png`]).catch(() => null);
            if (mv?.code === 0) files = [`${stem}.png`];
          }
        }
        const pages = [];
        for (const f of files) {
          let w = 0, h = 0;
          if (f.endsWith(".svg")) {
            const text = await readTextFile(`${dir}/${f}`).catch(() => "");
            const vb = /viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(text);
            w = Number(/\swidth=["']([\d.]+)/.exec(text)?.[1] ?? vb?.[1] ?? 512); h = Number(/\sheight=["']([\d.]+)/.exec(text)?.[1] ?? vb?.[2] ?? 512);
          } else if (!pages.length || b.viewer !== "pdf") {
            const r = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", `${dir}/${f}`]);
            w = Number(/pixelWidth:\s*(\d+)/.exec(r.stdout)?.[1] ?? 0); h = Number(/pixelHeight:\s*(\d+)/.exec(r.stdout)?.[1] ?? 0);
          } else { w = pages[0].w; h = pages[0].h; }
          pages.push({ src: `data/ide-preview/${f}`, w: w || 800, h: h || 600 });
        }
        b.pages = pages;
        b.previewMtime = mtime;
        b.error = null;
        if (!pages.length && b.viewer !== "binary") b.viewer = "binary";
        b.state = "ready";
        b.view++;
        cx.notify();
      } catch (e) { b.error = String(e.message ?? e); b.state = "ready"; cx.notify(); }
      finally { b.loading = false; }
    });
  }

  show(b, text, saved = null) {
    b.code?.release();
    Object.assign(b, { code: null, disk: text, dirty: false, changed: false, latest: null, saveError: null, markdown: false, mdPreview: false, editable: false, note: "", recovered: false, draftStale: false, error: null });
    if (text === null) { b.error = "This file can't be shown: it's missing, binary, too large or unreadable."; return; }
    if (text.includes("\0")) { b.binary = true; return; }
    const t = theme(), tooBig = text.length > LIMIT;
    const draft = tooBig || saved?.value === text ? null : saved;
    if (saved && !draft) dropDraft(b.path);
    b.editable = !b.on && !tooBig && !b.encoding;
    b.note = b.on ? "Read-only · remote file" : tooBig ? "Read-only · too large to edit" : b.encoding ? `Read-only · ${b.encoding}` : "";
    b.csv = CSV.test(b.name);
    b.table = b.csv && !draft;
    if (b.csv) b.rowsCsv = null;
    b.markdown = /\.(md|markdown)$/i.test(b.name);
    b.view++;
    b.code = EditorState.new({
      language: b.markdown ? "txt" : language(b.name), readonly: !b.editable,
      value: tooBig ? text.slice(0, LIMIT) + "\n… (file truncated)" : draft?.value ?? text,
      font_family: settings().font_family, font_size: 13.5,
      syntax: { keyword: t.ansi5, string: t.ansi2, "string.escape": t.ansi6, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, boolean: t.ansi1, constant: t.ansi6, operator: t.muted, punctuation: t.muted },
    });
    b.code.on("change", (_e, cx) => this.edited(b, cx));
    if (draft) {
      b.dirty = draft.value !== draft.disk;
      b.recovered = b.dirty;
      b.disk = draft.disk;
      if (draft.disk !== text) { b.changed = true; b.latest = text; }
    }
  }

  loadDiff(b, cx) {
    b.loading = true;
    cx.spawn(async (cx) => {
      try {
        const root = b.root ?? project()?.path, rel = b.rel ?? relTo(root, b.path), on = b.on;
        if (b.ref) { await this.loadRefDiff(b, root, rel, on, cx); return; }
        const head = await exec("git", [...READ, "rev-parse", "--verify", "HEAD"], { cwd: root, on });
        const tracked = await exec("git", [...READ, "ls-files", "--error-unmatch", "--", rel], { cwd: root, on });
        let lines;
        if (tracked.code !== 0 || head.code !== 0) {
          const text = await readTextFile(b.path, { on }).catch(() => null);
          if (text === null) lines = ["(file removed)"];
          else if (text.includes("\0")) lines = ["Binary file · no text diff"];
          else {
            const body = text.slice(0, LIMIT).replace(/\n$/, "").split("\n").slice(0, 4000);
            lines = [`@@ -0,0 +1,${body.length} @@ new file`, ...body.map((l) => `+${l}`)];
          }
        } else {
          // Unstaged (index → working tree) or staged (HEAD → index): hunks act on one side.
          const diff = (cached) => exec("git", [...READ, "diff", ...(cached ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", rel], { cwd: root, on });
          const [unstaged, staged] = await Promise.all([diff(false), diff(true)]);
          const count = (r) => r.stdout.split("\n").filter((l) => /^[+-](?![+-]{2} )/.test(l)).length;
          b.sides = { unstaged: count(unstaged), staged: count(staged) };
          if (!b.side) b.side = !b.sides.unstaged && b.sides.staged ? "staged" : "unstaged";
          const r = b.side === "staged" ? staged : unstaged;
          const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
          b.patchable = first >= 0 && !b.on;
          lines = first < 0 ? [r.stdout.includes("Binary") ? "Binary file changed" : b.side === "staged" ? "Nothing staged in this file" : "No unstaged changes in this file"] : all.slice(first);
          b.diffHeader = first < 0 ? [] : all.slice(0, first);
          this.setDiff(b, lines, cx);
          b.state = "ready"; b.error = null;
          return;
        }
        b.patchable = false; b.untracked = tracked.code !== 0;
        this.setDiff(b, lines, cx);
        b.state = "ready"; b.error = null;
      } catch (e) { b.error = String(e.message ?? e); b.state = "ready"; cx.notify(); }
      finally { b.loading = false; }
    });
  }

  // Branch diffs (working tree vs the merge-base with a branch) and commit diffs.
  async loadRefDiff(b, root, rel, on, cx) {
    try {
      let args;
      if (b.ref.startsWith("commit:")) args = ["show", "--format=", "--no-ext-diff", "--no-textconv", "--no-color", b.ref.slice(7), "--", rel];
      else if (b.ref.startsWith("turn:")) { const [from, to] = b.ref.slice(5).split(".."); args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", from, to, "--", rel]; }
      else {
        const base = b.ref.slice(5);
        const mb = await exec("git", [...READ, "merge-base", base, "HEAD"], { cwd: root, on });
        if (mb.code !== 0) throw new Error(`No merge-base with ${base}`);
        args = ["diff", mb.stdout.trim(), "--no-ext-diff", "--no-textconv", "--no-color", "--", rel];
      }
      const r = await exec("git", [...READ, ...args], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr.trim());
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      // Branch and agent-turn diffs end at the working tree, so a hunk can be reverted there.
      b.patchable = first >= 0 && !b.on && !b.ref.startsWith("commit:");
      b.diffHeader = first < 0 ? [] : all.slice(0, first);
      this.setDiff(b, first < 0 ? [r.stdout.includes("Binary") ? "Binary file changed" : "No differences"] : all.slice(first), cx);
      b.state = "ready"; b.error = null;
    } catch (e) { b.error = String(e.message ?? e); b.state = "ready"; cx.notify(); }
    finally { b.loading = false; }
  }

  setDiff(b, lines, cx) {
    {
        if (lines.length > 6000 || lines.some((l) => l.length > 2000)) b.patchable = false; // a cut line would corrupt a patch
        lines = lines.slice(0, 6000).map((l) => (l.length > 2000 ? l.slice(0, 2000) + "…" : l));
        b.rawLines = lines;
        const key = (b.side ?? "") + lines.join("\n");
        if (key !== b.diffKey) {
          b.diffKey = key;
          b.rows = diffRows(lines);
          b.add = b.rows.filter((r) => r.kind === "+").length;
          b.del = b.rows.filter((r) => r.kind === "-").length;
          b.diffWidth = Math.max(400, ...lines.map((l) => l.length * 7.6 + 110));
          b.view++;
          cx.notify();
        }
    }
  }

  // ---------- hunks ----------

  // One hunk as a patch: the file's diff header plus that hunk's lines.
  hunkPatch(b, hunk) {
    const start = b.rows.findIndex((r) => r.kind === "@" && r.hunk === hunk);
    let end = b.rows.findIndex((r, i) => i > start && r.kind === "@");
    if (end < 0) end = b.rows.length;
    return [...b.diffHeader, ...b.rawLines.slice(start, end)].join("\n") + "\n";
  }

  // stage: index += hunk · unstage: index −= hunk · discard / revert: working tree −= hunk.
  applyHunk(b, hunk, mode, cx) {
    if (b.hunkBusy) return;
    if ((mode === "discard" || mode === "revert") && b.confirmHunk !== hunk) { b.confirmHunk = hunk; cx.notify(); return; }
    b.confirmHunk = null; b.hunkBusy = true; b.hunkError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const patch = `${appHome()}/data/ide-hunk-${Date.now()}.patch`;
      try {
        const root = b.root ?? project()?.path;
        const top = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: root })).stdout.trim();
        await writeTextFile(patch, this.hunkPatch(b, hunk), null);
        const flags = mode === "stage" ? ["--cached"] : mode === "unstage" ? ["--cached", "-R"] : ["-R"];
        const r = await exec("git", ["apply", ...flags, "--whitespace=nowarn", patch], { cwd: top });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(0, 3).join(" "));
        b.state = "stale";
      } catch (e) { b.hunkError = `${mode} failed: ${String(e.message ?? e)}`; }
      finally { b.hunkBusy = false; fs.unlink(patch).catch(() => {}); cx.notify(); }
    });
  }

  stageFile(b, add, cx) {
    const root = b.root ?? project()?.path, rel = b.rel ?? relTo(root, b.path);
    cx.spawn(async (cx) => {
      const r = await exec("git", add ? ["add", "--", rel] : ["restore", "--staged", "--", rel], { cwd: root, on: b.on });
      if (r.code !== 0) b.hunkError = (r.stderr || r.stdout).trim(); else { b.state = "stale"; b.side = null; }
      cx.notify();
    });
  }

  // ---------- find / replace ----------

  openFind(replace, cx) {
    const b = this.b;
    if (!b.code || b.viewer && b.viewer !== "text") return;
    if (b.markdown && b.mdPreview) { b.mdPreview = false; b.view++; }
    const f = this.find;
    f.open = true; f.replaceOpen = replace || f.replaceOpen;
    const sel = b.code.selected_range(), picked = b.code.value().slice(sel.start, sel.end);
    if (picked && !picked.includes("\n") && picked.length < 200) { f.input.set_value(picked); }
    this.findMatches(cx);
    f.input.focus();
    cx.notify();
  }

  closeFind(cx) { this.find.open = false; this.b.code?.focus(); cx.notify(); }

  findRegex(global = true) {
    const f = this.find, q = f.input.value();
    if (!q) return null;
    let src = f.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (f.word) src = `\\b(?:${src})\\b`;
    return new RegExp(src, (global ? "g" : "") + (f.caseSensitive ? "" : "i") + "m");
  }

  findMatches(cx, keepAt = false) {
    const f = this.find, b = this.b;
    f.matches = []; f.error = null;
    if (!b.code) return;
    let re;
    try { re = this.findRegex(); } catch { f.error = "Invalid regular expression"; return; }
    if (!re) { f.at = -1; return; }
    const text = b.code.value();
    for (let m; (m = re.exec(text)) && f.matches.length < 10000;) {
      if (m[0] === "") { re.lastIndex++; continue; }
      f.matches.push({ start: m.index, end: m.index + m[0].length });
    }
    if (!keepAt) {
      const from = b.code.selected_range().start;
      f.at = f.matches.findIndex((x) => x.start >= from);
      if (f.at < 0) f.at = f.matches.length ? 0 : -1;
    } else if (f.at >= f.matches.length) f.at = f.matches.length - 1;
  }

  // Selecting the match is what shows it: the editor scrolls to its selection.
  showMatch() {
    const f = this.find, m = f.matches[f.at];
    if (m) try { this.b.code.set_selected_range({ start: m.start, end: m.end }); } catch {}
  }

  step(delta, cx) {
    const f = this.find;
    if (!f.matches.length) return;
    f.at = (f.at + delta + f.matches.length) % f.matches.length;
    this.showMatch();
    cx.notify();
  }

  replaceOne(cx) {
    const f = this.find, b = this.b, m = f.matches[f.at];
    if (!m || !b.editable) return;
    const text = b.code.value().slice(m.start, m.end), re = this.findRegex(false);
    b.code.set_selected_range({ start: m.start, end: m.end });
    b.code.replace(f.regex ? text.replace(re, f.replace.value()) : f.replace.value());
    this.findMatches(cx, true);
    this.showMatch();
    cx.notify();
  }

  replaceAll(cx) {
    const f = this.find, b = this.b;
    if (!f.matches.length || !b.editable) return;
    const re = this.findRegex(), text = b.code.value(), n = f.matches.length;
    const next = f.regex ? text.replace(re, f.replace.value()) : text.replace(re, () => f.replace.value());
    b.code.set_selected_range({ start: 0, end: text.length });
    b.code.replace(next); // one undo step
    this.findMatches(cx);
    f.note = `Replaced ${n}`;
    cx.notify();
  }

  findBar(t) {
    const f = this.find, b = this.b;
    const toggle = (id, label, key, tip) => div().id(id).h(22).px(5).flex().items_center().rounded(4).cursor_pointer().text_size(11).font_semibold().tooltip(tip)
      .bg(f[key] ? t.accent + "33" : t.background).text_color(f[key] ? t.foreground : t.dim).border_1().border_color(f[key] ? t.accent : t.border)
      .on_click((_e, cx) => { f[key] = !f[key]; this.findMatches(cx); this.showMatch(); cx.notify(); }).child(label);
    const field = (state, id, w) => div().id(id).w(w).h(26).px(8).flex().items_center().rounded(5).border_1().border_color(t.input).bg(t.background).cursor_text()
      .child(Input.new(state).flex_1().h_full().text_size(12.5).text_color(t.foreground));
    const count = f.error ? f.error : !f.input.value() ? "" : f.matches.length ? `${f.at + 1} of ${f.matches.length}${f.matches.length >= 10000 ? "+" : ""}` : "No results";
    return v_flex().flex_none().px(10).py(6).gap(6).border_b(1).border_color(t.border).bg(t.chrome).text_size(12)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.closeFind(cx);
        else if (e.key === "enter" && e.modifiers?.shift) this.step(-1, cx);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().gap(6).items_center()
        .child(div().id("fb-expand").size(22).flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover))
          .tooltip("Toggle replace (⌥⌘F)").on_click((_e, cx) => { f.replaceOpen = !f.replaceOpen; cx.notify(); })
          .child(svg(`mods/files/chevron-${f.replaceOpen ? "down" : "right"}.svg`).size(11)))
        .child(field(f.input, "fb-find", 280))
        .child(toggle("fb-case", "Aa", "caseSensitive", "Match case")).child(toggle("fb-word", "ab", "word", "Whole word")).child(toggle("fb-re", ".*", "regex", "Regular expression"))
        .child(div().min_w(80).text_color(f.error || (f.input.value() && !f.matches.length) ? t.ansi1 : t.dim).child(count))
        .child(this.button("fb-prev", "↑", false, (cx) => this.step(-1, cx), t))
        .child(this.button("fb-next", "↓", false, (cx) => this.step(1, cx), t))
        .child(div().flex_1())
        .child(div().id("fb-close").size(22).flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover)).tooltip("Close (Esc)")
          .on_click((_e, cx) => this.closeFind(cx)).child(svg("mods/pane/close.svg").size(11))))
      .when(Boolean(f.replaceOpen), (e) => e.child(h_flex().gap(6).items_center().pl(28)
        .child(field(f.replace, "fb-replace", 280))
        .child(this.button("fb-r1", "Replace", false, (cx) => this.replaceOne(cx), t))
        .child(this.button("fb-ra", "Replace all", true, (cx) => this.replaceAll(cx), t))
        .when(!b.editable, (x) => x.child(div().text_color(t.dim).child("read-only")))
        .when(Boolean(f.note), (x) => x.child(div().text_color(t.dim).child(f.note)))));
  }

  edited(b, cx) {
    b.rowsCsv = null;
    if (this.find?.open) { this.findMatches(cx, true); this.find.note = null; }
    const dirty = b.code.value() !== b.disk;
    b.draftStale = dirty;
    if (b.preview) { b.preview = false; cx.notify(); }
    if (dirty === b.dirty) return;
    b.dirty = dirty;
    if (!dirty) { b.recovered = false; dropDraft(b.path); }
    this.publishDirty();
    cx.notify();
  }

  save(b, cx) {
    if (!b.code || !b.editable || !b.dirty || b.saving) return;
    const path = b.path, text = b.code.value(), expected = b.disk;
    b.saving = true; b.saveError = null; b.generation++; b.preview = false;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(path, text, expected);
        b.disk = text; b.changed = false; b.latest = null; b.recovered = false; b.draftStale = false;
        b.dirty = b.code.value() !== text;
        await dropDraft(path);
        if (this.closeAfterSave && !b.dirty) { this.closeAfterSave = false; const tab = this.me()?.tab; if (tab) closeTab(tab); }
      } catch (e) {
        this.closeAfterSave = false;
        b.saveError = String(e.message ?? e).replace(/^.*?`: /, "");
      } finally {
        b.saving = false;
        this.publishDirty();
        cx.notify();
      }
    });
  }

  revert(b, cx) {
    b.code.set_value(b.disk ?? "");
    b.dirty = false; b.saveError = null; b.recovered = false; b.draftStale = false;
    dropDraft(b.path);
    this.publishDirty();
    cx.notify();
  }

  useDisk(b, cx) {
    dropDraft(b.path);
    this.show(b, b.latest);
    b.state = "ready";
    cx.notify();
  }

  keepMine(b, cx) {
    b.disk = b.latest; b.changed = false; b.latest = null; b.saveError = null;
    b.dirty = true;
    this.save(b, cx);
  }

  followLink(b, url, cx) {
    const root = project()?.path ?? null;
    const link = resolveLink(url, b.path, root);
    if (link.kind === "web") cx.open_url(link.url);
    else if (link.kind === "anchor") {
      const at = findHeading(b.code.value(), link.slug);
      if (at === null) notify({ title: "Section not found", body: `#${link.slug}`, level: "warning" });
      else { b.sectionAt = at; b.view++; cx.notify(); }
    } else if (link.kind === "file") {
      if (/\.(png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?|zip)$/i.test(link.path) && !b.on) exec("open", [link.path]);
      else openInEditor({ kind: "file", path: link.path, on: b.on });
    } else notify({ title: "Can't open this link", body: url, level: "warning" });
  }

  // ---------- view ----------

  button(id, text, primary, action, t) {
    return div().id(id).h(22).px(8).flex().items_center().flex_none().rounded(5).cursor_pointer().text_size(11.5)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => action(cx)).child(text);
  }

  breadcrumb(b, t) {
    const parts = this.rel(b).split("/");
    const status = b.saving ? "Saving…" : b.dirty ? (b.recovered ? "Recovered unsaved edits" : "Unsaved") : b.note;
    return h_flex().h(28).flex_none().px(14).gap(4).items_center().text_size(12).text_color(t.dim).border_b(1).border_color(t.border).bg(t.background)
      .children(parts.map((p, i) => h_flex().gap(4).items_center().flex_none()
        .when(i > 0, (e) => e.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).text_color(t.dim)))
        .child(div().text_color(i === parts.length - 1 ? t.foreground : t.dim).child(p))))
      .when(b.kind === "diff", (e) => e.child(div().ml(8).text_color(t.ansi2).child(`+${b.add ?? 0}`)).child(div().text_color(t.ansi1).child(`−${b.del ?? 0}`)))
      .child(div().flex_1())
      .when(Boolean(status), (e) => e.child(div().text_color(b.dirty ? t.blocked : t.dim).child(status)))
      .when(b.kind === "diff" && !b.ref && Boolean(b.sides), (e) => e.child(h_flex().rounded(5).border_1().border_color(t.border).overflow_hidden()
        .children(["unstaged", "staged"].map((side) => div().id(`ed-side-${side}`).h(20).px(8).flex().items_center().cursor_pointer().text_size(11.5)
          .bg(b.side === side ? t.selected : t.background).text_color(b.side === side ? t.foreground : t.dim).hover((x) => x.bg(t.hover))
          .on_click((_e, cx) => { if (b.side !== side) { b.side = side; b.state = "stale"; cx.notify(); } })
          .child(`${side === "staged" ? "Staged" : "Unstaged"} ${b.sides[side]}`)))))
      .when(b.kind === "diff" && !b.ref && (b.side === "unstaged" && (b.sides?.unstaged || b.untracked)), (e) => e.child(this.button("ed-stage-file", "Stage file", false, (cx) => this.stageFile(b, true, cx), t)))
      .when(b.kind === "diff" && !b.ref && b.side === "staged" && Boolean(b.sides?.staged), (e) => e.child(this.button("ed-unstage-file", "Unstage file", false, (cx) => this.stageFile(b, false, cx), t)))
      .when(b.kind === "diff", (e) => e.child(this.button("ed-openfile", "Open file", false, (cx) => openInEditor({ kind: "file", path: b.path, on: b.on, rel: b.rel }), t)))
      .when(Boolean(b.csv) && !b.table, (e) => e.child(this.button("ed-csv", "Table", false, (cx) => { b.table = true; b.rowsCsv = null; b.view++; cx.notify(); }, t)))
      .when(Boolean(b.markdown), (e) => e.child(this.button("ed-md", b.mdPreview ? "Edit" : "Preview", false, (cx) => { b.mdPreview = !b.mdPreview; b.sectionAt = 0; b.view++; cx.notify(); }, t)))
      .when(Boolean(b.dirty), (e) => e.child(this.button("ed-revert", "Revert", false, (cx) => this.revert(b, cx), t)).child(this.button("ed-save", "Save ⌘S", true, (cx) => this.save(b, cx), t)));
  }

  banner(b, t) {
    return h_flex().min_h(34).flex_none().px(14).py(5).gap(6).items_center().border_b(1).border_color(t.border).bg(t.raised).text_size(12)
      .child(div().flex_1().min_w(0).text_color(t.blocked).child(b.latest === null ? "This file was deleted on disk. Your copy is still here." : "This file changed on disk while you were editing it."))
      .when(b.latest !== null, (el) => el.child(this.button("ed-disk", "Use disk version", false, (cx) => this.useDisk(b, cx), t)))
      .child(this.button("ed-mine", b.latest === null ? "Save again" : "Keep mine", true, (cx) => this.keepMine(b, cx), t));
  }

  diffRow(r, t) {
    const num = (n) => div().w(44).flex_none().text_right().pr(8).text_color(t.dim).child(n === undefined ? "" : String(n));
    if (r.kind === "@") return h_flex().w_full().h(22).flex_none().px(12).items_center().bg(t.raised).text_color(t.dim).child(div().truncate().child(r.text));
    return h_flex().w_full().h(20).flex_none().items_center()
      .when(r.kind === "+", (e) => e.bg(t.ansi2 + "1f")).when(r.kind === "-", (e) => e.bg(t.ansi1 + "1f"))
      .child(num(r.a)).child(num(r.b))
      .child(div().w(16).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === " " ? "" : r.kind))
      .child(div().whitespace_nowrap().child(r.text));
  }

  hunkHeader(b, r, mode, t) {
    const confirm = b.confirmHunk === r.hunk;
    const act = (id, label, m, kind) => div().id(`${id}-${r.hunk}`).h(18).px(7).flex().items_center().rounded(4).cursor_pointer().text_size(11).font_family(settings().ui_font ?? "Geist")
      .bg(kind === "primary" ? t.solid : t.background).text_color(kind === "primary" ? t.solid_foreground : kind === "danger" ? t.ansi1 : t.foreground)
      .border_1().border_color(kind === "primary" ? t.solid : t.border).hover((x) => x.opacity(0.85))
      .on_click((_e, cx) => this.applyHunk(b, r.hunk, m, cx)).child(label);
    return h_flex().w_full().h(24).flex_none().px(12).gap(6).items_center().bg(t.raised).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(r.text))
      .when(b.hunkBusy, (e) => e.child(div().text_size(11).child("…")))
      .when(mode === "stage", (e) => e.child(act("hk-discard", confirm ? "Confirm discard" : "Discard", "discard", "danger")).child(act("hk-stage", "Stage hunk", "stage", "primary")))
      .when(mode === "unstage", (e) => e.child(act("hk-unstage", "Unstage hunk", "unstage", "plain")))
      .when(mode === "revert", (e) => e.child(act("hk-revert", confirm ? "Confirm revert" : "Revert hunk", "revert", "danger")));
  }

  body(b, t) {
    if (b.kind === "diff") {
      if (!b.rows) return div().p(16).text_color(t.dim).child(b.error ?? "Loading changes…");
      if (b.rows.length <= 2500) {
        const mode = !b.patchable ? null : b.ref ? "revert" : b.side === "staged" ? "unstage" : "stage";
        return div().id(`ed-diff-${b.view}`).flex_1().min_h(0).overflow_scroll().font_family(settings().font_family ?? "JetBrains Mono").text_size(12.5)
          .child(v_flex().min_w(b.diffWidth).children(b.rows.map((r, i) => r.kind === "@" && mode ? this.hunkHeader(b, r, mode, t) : this.diffRow(r, t))));
      }
      return div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12.5)
        .child(div().id(`ed-diff-x-${b.view}`).size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(b.diffWidth).h_full().child(v_virtual_list(`ed-diff-${b.view}`, b.rows.length, 20, (i) => String(i),
            (range) => b.rows.slice(range.start, range.end).map((r) => this.diffRow(r, t))).size_full())))
        .child(Scrollbar.vertical(`ed-diff-${b.view}`).viewport_from_layout().absolute().inset_0());
    }
    if (b.viewer && b.viewer !== "text") return this.previewBody(b, t);
    if (!b.code) return div().p(16).text_color(t.dim).child(b.error ?? "Loading…");
    if (b.csv && b.table) return this.tableBody(b, t);
    if (b.markdown && b.mdPreview) {
      return div().id(`ed-md-${b.view}`).flex_1().min_h(0).overflow_y_scrollbar().px(32).py(20)
        .child(TextView.markdown(`ed-mdv-${b.view}`, b.code.value().slice(b.sectionAt ?? 0)).on_link_click((url, cx) => this.followLink(b, url, cx)));
    }
    return Editor.new(b.code).flex_1().min_h(0);
  }

  previewBody(b, t) {
    const info = [b.fileType, b.size !== undefined ? human(b.size) : null, b.pageCount ? `${b.pageCount} pages` : null].filter(Boolean).join(" · ");
    const bar = h_flex().h(30).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border).text_size(11.5).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(info))
      .when(b.viewer === "image" || b.viewer === "pdf" || b.viewer === "quicklook", (e) => e
        .child(this.button("pv-fit", b.zoom ? `${Math.round(b.zoom * 100)}%` : "Fit", false, (cx) => { b.zoom = b.zoom ? null : 1; cx.notify(); }, t))
        .child(this.button("pv-out", "−", false, (cx) => { b.zoom = Math.max(0.1, (b.zoom ?? 1) / 1.25); cx.notify(); }, t))
        .child(this.button("pv-in", "+", false, (cx) => { b.zoom = Math.min(8, (b.zoom ?? 1) * 1.25); cx.notify(); }, t)))
      .when(/\.svg$/i.test(b.name), (e) => e.child(this.button("pv-src", "Source", false, (cx) => { b.viewer = "text"; b.state = "new"; cx.notify(); }, t)))
      .when(!b.on, (e) => e.child(this.button("pv-open", "Open in app", false, () => exec("open", [b.path]), t)).child(this.button("pv-reveal", "Reveal", false, () => exec("open", ["-R", b.path]), t)));
    if (b.viewer === "binary" || !b.pages?.length) {
      return v_flex().flex_1().min_h(0).child(bar).child(v_flex().flex_1().items_center().justify_center().gap(8).text_color(t.dim)
        .child(div().text_size(15).text_color(t.foreground).child(b.name))
        .child(div().text_size(12).child(b.loading || b.state !== "ready" ? "Rendering preview…" : b.error ?? (b.on ? "Remote binary file" : "No preview for this file type")))
        .when(!b.on && !b.loading, (e) => e.child(this.button("pv-text", "Open as text anyway", false, (cx) => { b.viewer = "text"; b.state = "new"; cx.notify(); }, t))));
    }
    const avail = Math.max(120, (this.size?.width ?? 900) - 56);
    const pages = b.pages.map((pg, i) => {
      // Pages and thumbnails fit a reading width; pictures show at their own size, shrunk to fit.
      const natural = b.viewer !== "image" ? 900 : pg.w;
      const w = b.zoom ? natural * b.zoom : Math.min(natural, avail);
      const h = (w * pg.h) / pg.w;
      return div().flex_none().when(b.viewer === "pdf", (e) => e.shadow_md().bg("#ffffff")).child(image(pg.src).w(w).h(h)).id(`pg-${i}`);
    });
    return v_flex().flex_1().min_h(0).child(bar)
      .child(div().id(`pv-${b.view}`).flex_1().min_h(0).overflow_scroll().bg(t.canvas)
        .child(v_flex().min_w_full().items_center().gap(16).p(24).children(pages)));
  }

  tableBody(b, t) {
    if (!b.rowsCsv) b.rowsCsv = parseCsv(b.code.value(), /\.tsv$/i.test(b.name) ? "\t" : ",");
    const rows = b.rowsCsv, cols = Math.max(0, ...rows.slice(0, 200).map((r) => r.length)), W = 170;
    const row = (r, i) => h_flex().h(24).flex_none().border_b(1).border_color(t.border).when(i === 0, (e) => e.bg(t.raised).font_semibold())
      .child(div().w(48).flex_none().px(6).text_right().text_color(t.dim).child(String(i + 1)))
      .children(Array.from({ length: cols }, (_x, c) => div().w(W).flex_none().px(8).border_l(1).border_color(t.border).truncate().child(r[c] ?? "")));
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(28).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border).text_size(11.5).text_color(t.dim)
        .child(div().flex_1().child(`${rows.length}${rows.length >= 5000 ? "+" : ""} rows · ${cols} columns`))
        .child(this.button("csv-src", "Edit as text", false, (cx) => { b.table = false; cx.notify(); }, t)))
      .child(div().flex_1().min_h(0).relative().text_size(12)
        .child(div().id(`csv-x-${b.view}`).size_full().overflow_x_scrollbar()
          .child(div().w(48 + cols * W).h_full().child(v_virtual_list(`csv-${b.view}`, rows.length, 24, (i) => String(i), (range) => rows.slice(range.start, range.end).map((r, k) => row(r, range.start + k))).size_full())))
        .child(Scrollbar.vertical(`csv-${b.view}`).viewport_from_layout().absolute().inset_0()));
  }

  render() {
    const t = theme(), b = this.b;
    return v_flex().id("ide-editor").on_size_change((size, cx) => { this.size = size; cx.notify(); }).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(this.breadcrumb(b, t))
      .when(Boolean(b.code && b.changed), (e) => e.child(this.banner(b, t)))
      .when(Boolean(b.saveError) && !b.changed, (e) => e.child(div().px(14).py(6).flex_none().text_size(12).bg(t.raised).text_color(t.ansi1).child(b.saveError)))
      .when(Boolean(this.find.open && b.code), (e) => e.child(this.findBar(t)))
      .when(Boolean(b.hunkError), (e) => e.child(div().px(14).py(6).flex_none().text_size(12).bg(t.raised).text_color(t.ansi1).child(b.hunkError)))
      .child(b.path ? this.body(b, t) : div().p(16).text_color(t.dim).child("No file"));
  }
}

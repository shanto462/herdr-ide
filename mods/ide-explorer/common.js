// Shared by every ide-* mod. Each ide-* folder carries an identical copy.
//
// The IDE's one rule: a space has a PROJECT FOLDER that is chosen once and never
// follows `cd`. Explorer, Search, Source Control, Quick Open and new terminals all
// use it. It changes only when the person picks another (Open Folder…, or
// "Set as project root" in the Explorer's context menu).
import { spaces, panes, shared, setShared, exec } from "herdr";

export const ROOTS = "ide.roots";    // { [spaceId]: { path, on } }
export const OPEN = "ide.open";      // { space, kind, path, on, root?, rel?, line?, preview?, focus?, at }
export const ACTIVE = "ide.active";  // { [spaceId]: { kind, path, on, rel, language } | null }
export const TABS = "ide.tabs";      // { [spaceId]: { files: [descriptor], active } }
export const FS = "ide.fs";          // { kind: "moved" | "removed", from?, to?, path?, at }
export const SCM = "ide.scm";        // { [spaceId]: { count, branch, ahead, behind } }
export const CMD = "ide.editor.cmd"; // { command, id: uid, at }: commands for one editor pane
export const FILETABS = "ide.filetabs"; // { uid: { tab, space, kind, path, on, rel, root, ref, preview } }
export const DIRTY = "ide.dirty";      // { uid: true } while an editor has unsaved edits
export const GOTO = "ide.goto";        // { uid, line, column, at }: move an open editor's cursor

export function editorCommand(command, id = null) {
  setShared(CMD, { command, id, at: `${Date.now()}-${Math.random()}` });
}

export const activeSpace = () => spaces().find((s) => s.active) ?? null;

export function project(space = activeSpace()) {
  if (!space) return null;
  const r = shared(ROOTS)?.[space.id];
  if (!r?.path) return null;
  return { path: r.path, on: r.on ?? null, space: space.id, name: r.path.split("/").filter(Boolean).pop() || r.path };
}

export function setRoot(spaceId, path, on = null) {
  setShared(ROOTS, { ...(shared(ROOTS) ?? {}), [spaceId]: { path: path.replace(/\/+$/, "") || "/", on: on ?? null } });
}

// First sight of a space: its repo (else folder), from where its first terminal is.
// Runs once per space; after that the root is fixed.
const pending = new Set();
export async function ensureProject(space = activeSpace()) {
  if (!space || shared(ROOTS)?.[space.id] || pending.has(space.id)) return;
  pending.add(space.id);
  try {
    const ids = new Set(space.tabs.map((t) => t.id));
    const first = panes().find((p) => ids.has(p.tab) && p.cwd);
    const start = first?.cwd || space.folder;
    if (!start) return;
    const on = space.machine ?? null;
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: start, on }).catch(() => null);
    if (shared(ROOTS)?.[space.id]) return;
    setRoot(space.id, top?.code === 0 ? top.stdout.trim() : start, on);
  } finally { pending.delete(space.id); }
}

export function openInEditor(what) {
  setShared(OPEN, { space: activeSpace()?.id, kind: "file", ...what, at: `${Date.now()}-${Math.random()}` });
}

export const relTo = (root, path) => (root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path);

export function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// Runs an app command through the CLI to learn what it made (tab ids, terminals).
export async function doCommand(exec_, name, args) {
  const r = await exec_("herdr-app", ["do", name, JSON.stringify(args)]);
  if (r.code !== 0) throw new Error((r.stdout || r.stderr || "").trim());
  return JSON.parse(r.stdout || "{}");
}

const LANGS = { js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript React", ts: "TypeScript", tsx: "TypeScript React", py: "Python", rs: "Rust", go: "Go", rb: "Ruby", java: "Java", kt: "Kotlin", swift: "Swift", c: "C", h: "C", cpp: "C++", hpp: "C++", cs: "C#", php: "PHP", sh: "Shell", zsh: "Shell", bash: "Shell", json: "JSON", jsonc: "JSON", yml: "YAML", yaml: "YAML", toml: "TOML", md: "Markdown", markdown: "Markdown", html: "HTML", css: "CSS", scss: "SCSS", sql: "SQL", tex: "LaTeX", txt: "Plain Text", xml: "XML", svg: "SVG", lua: "Lua", dart: "Dart", vue: "Vue", svelte: "Svelte" };
export function languageName(name) {
  if (/^dockerfile/i.test(name)) return "Dockerfile";
  if (/^makefile$/i.test(name)) return "Makefile";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return LANGS[ext] ?? (ext ? ext.toUpperCase() : "Plain Text");
}

// A small colored mark per file type, for tabs and the tree.
const TINT = { js: "ansi3", mjs: "ansi3", cjs: "ansi3", jsx: "ansi6", ts: "ansi4", tsx: "ansi6", py: "ansi4", rs: "ansi1", go: "ansi6", json: "ansi3", md: "ansi4", tex: "ansi2", pdf: "ansi1", yml: "ansi5", yaml: "ansi5", toml: "ansi5", sh: "ansi2", css: "ansi5", html: "ansi1", png: "ansi5", jpg: "ansi5", svg: "ansi3", sql: "ansi6", lock: "dim" };
export function fileTint(name, t) {
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return t[TINT[ext]] ?? t.muted;
}

// Symbols of one file for the outline (⌘⇧O), by language patterns. No app calls here.
// Each symbol: { name, kind, line (1-based), depth }.

const RULES = {
  js: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, "function"],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
    [/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, "type"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, "function"],
    [/^\s{2,}(?:static\s+|async\s+|get\s+|set\s+|public\s+|private\s+|protected\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, "method"],
  ],
  py: [[/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, "function"], [/^(\s*)class\s+([A-Za-z_]\w*)/, "class"]],
  go: [[/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "function"], [/^type\s+([A-Za-z_]\w*)/, "type"]],
  rs: [[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, "function"], [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/, "type"], [/^\s*impl(?:<[^>]*>)?\s+([^{]+?)\s*\{/, "impl"]],
  java: [[/^\s*(?:public|private|protected|internal|static|final|abstract|sealed|open|override|data|\s)*\s*(?:class|interface|enum|record|struct|object)\s+([A-Za-z_]\w*)/, "class"], [/^\s*(?:public|private|protected|internal|static|final|override|async|virtual|\s)*\s*(?:fun|func)\s+([A-Za-z_]\w*)/, "function"], [/^\s+(?:public|private|protected|static|final|override|async|virtual|\s)+[\w<>\[\],.?\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, "method"]],
  rb: [[/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, "function"], [/^\s*(?:class|module)\s+([A-Z]\w*(?:::\w+)*)/, "class"]],
  php: [[/^\s*(?:public|private|protected|static|abstract|final|\s)*function\s+([A-Za-z_]\w*)/, "function"], [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, "class"]],
  sh: [[/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, "function"], [/^\s*function\s+([A-Za-z_][\w-]*)/, "function"]],
};
const ALIAS = { ts: "js", tsx: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", py: "py", pyi: "py", go: "go", rs: "rs", java: "java", kt: "java", kts: "java", swift: "java", cs: "java", scala: "java", rb: "rb", php: "php", sh: "sh", bash: "sh", zsh: "sh" };
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "with", "new", "await", "typeof"]);

export function symbols(text, name) {
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const lines = text.split("\n"), out = [];
  if (ext === "md" || ext === "markdown") {
    let fence = false;
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
      if (m) out.push({ name: m[2], kind: "heading", line: i + 1, depth: m[1].length - 1 });
    });
    return out;
  }
  if (ext === "tex" || ext === "sty" || ext === "cls") {
    const depth = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4 };
    lines.forEach((l, i) => {
      const m = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\{(.+)\}/.exec(l);
      if (m) out.push({ name: m[2].replace(/\\[a-zA-Z]+\s*/g, "").replace(/[{}]/g, ""), kind: m[1], line: i + 1, depth: depth[m[1]] });
      const c = /^\s*\\(?:newcommand|renewcommand|def)\s*\{?\\([A-Za-z@]+)/.exec(l);
      if (c) out.push({ name: `\\${c[1]}`, kind: "command", line: i + 1, depth: 0 });
    });
    return out;
  }
  const rules = RULES[ALIAS[ext]];
  if (!rules) return out;
  lines.forEach((l, i) => {
    if (l.length > 400) return;
    for (const [re, kind] of rules) {
      const m = re.exec(l);
      if (!m) continue;
      // Python's first group is the indentation.
      const name = ALIAS[ext] === "py" ? m[2] : m[1];
      if (!name || KEYWORDS.has(name)) continue;
      const indent = ALIAS[ext] === "py" ? m[1].length : (/^\s*/.exec(l)[0].replace(/\t/g, "    ").length);
      out.push({ name: name.trim(), kind, line: i + 1, depth: Math.min(4, Math.floor(indent / (ALIAS[ext] === "go" ? 1 : 2)) > 0 ? 1 : 0) });
      break;
    }
  });
  return out;
}

// universal-ctags output (`ctags --output-format=json -f - <file>`) → symbols.
export function fromCtags(stdout) {
  const out = [];
  for (const line of stdout.split("\n")) {
    try {
      const t = JSON.parse(line);
      if (t._type === "tag" && t.line) out.push({ name: t.name, kind: t.kind ?? "symbol", line: t.line, depth: t.scope ? 1 : 0 });
    } catch {}
  }
  return out.sort((a, b) => a.line - b.line);
}

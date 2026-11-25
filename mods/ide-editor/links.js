// Works out where a Markdown link points. No app calls here, so it can be tested alone.

// GitHub's heading anchors: lowercase, punctuation gone, spaces become hyphens.
export function slug(heading) {
  return heading.trim()
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*~]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

// Where the heading with this anchor starts, or null. Ignores # lines inside code fences.
export function findHeading(text, wanted) {
  const seen = new Map();
  let at = 0, fence = null;
  for (const line of text.split("\n")) {
    const mark = /^ {0,3}(```+|~~~+)/.exec(line)?.[1];
    if (fence) { if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null; }
    else if (mark) fence = mark;
    else {
      // Docs also place hand-written anchors: <a id="name"></a>.
      for (const m of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/gi)) if (m[1].toLowerCase() === wanted) return at;
      const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line.replace(/\r$/, ""));
      if (heading) {
        const base = slug(heading[1]), n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        if ((n ? `${base}-${n}` : base) === wanted) return at;
      }
    }
    at += line.length + 1;
  }
  return null;
}

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

function normalize(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return `/${out.join("/")}`;
}

// { kind: "web", url } | { kind: "anchor", slug } | { kind: "file", path, slug } | { kind: "other", url }
export function resolveLink(url, file, root) {
  const link = url.trim();
  if (/^https?:\/\//i.test(link)) return { kind: "web", url: link };
  if (link.startsWith("#")) return { kind: "anchor", slug: decode(link.slice(1)).toLowerCase() };
  const local = /^file:\/\//i.test(link) ? link.replace(/^file:\/\/(localhost)?/i, "") : link;
  if (/^[a-z][a-z0-9+.-]*:/i.test(local)) return { kind: "other", url: link };
  const [target, fragment] = local.split(/#(.*)/s);
  const clean = decode(target.split("?")[0]);
  // A leading / means the repo root in Markdown, unless it is already a full path.
  const path = clean.startsWith("/")
    ? (!root || clean === root || clean.startsWith(`${root}/`) || /^file:/i.test(link) ? clean : `${root}${clean}`)
    : `${file.slice(0, file.lastIndexOf("/"))}/${clean}`;
  return { kind: "file", path: normalize(path), slug: fragment ? decode(fragment).toLowerCase() : null };
}

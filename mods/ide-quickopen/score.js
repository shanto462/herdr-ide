// Fuzzy file matching. Higher is better; null means no match.
const isBoundary = (text, i) => i === 0 || "/._- ".includes(text[i - 1]) || (text[i] !== text[i].toLowerCase() && text[i - 1] === text[i - 1].toLowerCase());

function subsequence(query, text, lower) {
  let at = 0, total = 0, previous = -2;
  for (const ch of query) {
    const found = lower.indexOf(ch, at);
    if (found < 0) return null;
    total += 1 + (found === previous + 1 ? 5 : 0) + (isBoundary(text, found) ? 4 : 0);
    previous = found; at = found + 1;
  }
  return total;
}

function scoreToken(token, entry) {
  const inName = subsequence(token, entry.name, entry.lowerName);
  const inPath = subsequence(token, entry.path, entry.lowerPath);
  if (inName === null && inPath === null) return null;
  let best = Math.max(inName === null ? -1 : inName + 40, inPath ?? -1);
  if (entry.lowerName.startsWith(token)) best += 60;
  else if (entry.lowerName.includes(token)) best += 30;
  else if (entry.lowerPath.includes(token)) best += 15;
  return best;
}

export function makeEntry(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { path, name, lowerPath: path.toLowerCase(), lowerName: name.toLowerCase() };
}

export function search(query, entries, limit) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return entries.slice(0, limit);
  const scored = [];
  for (const entry of entries) {
    let total = -entry.path.length * 0.02, matched = true;
    for (const token of tokens) {
      const score = scoreToken(token, entry);
      if (score === null) { matched = false; break; }
      total += score;
    }
    if (matched) scored.push({ entry, total });
  }
  scored.sort((a, b) => b.total - a.total);
  return scored.slice(0, limit).map((s) => s.entry);
}

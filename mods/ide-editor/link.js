// Cmd-click a file path in a terminal: open it in the IDE editor, at its line if
// the text says one (path:42, path:42:7, path(42,7), "path", line 42).
// Only in the ide layout; anywhere else the click goes on to the usual opener.
import { shared, setShared, exec } from "herdr";

export async function handleLink({ link, source }) {
  if (shared("layout") !== "ide" || link.kind !== "file" || !link.path) return "pass";
  const on = source.machine ?? null;
  const kind = await exec("sh", ["-c", 'if [ -f "$1" ]; then echo f; elif [ -d "$1" ]; then echo d; fi', "link", link.path], { on }).catch(() => null);
  const what = kind?.stdout?.trim();
  if (what === "d") { setShared("ide.reveal", { path: link.path + "/", at: Date.now() }); return "pass"; }
  if (what !== "f") return "pass";
  const raw = link.raw ?? "";
  const m = /[:(](\d+)(?:[:,](\d+))?\)?\s*$/.exec(raw) ?? /,?\s+line\s+(\d+)/i.exec(raw);
  setShared("ide.open", {
    space: source.space, kind: "file", path: link.path, on,
    line: m ? Number(m[1]) : undefined, column: m?.[2] ? Number(m[2]) : undefined,
    at: `${Date.now()}-${Math.random()}`,
  });
  return "handled";
}

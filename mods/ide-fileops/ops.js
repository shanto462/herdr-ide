// The file system actions behind the Files panel. `exec` is passed in, and names
// only ever travel as arguments, so a quote or space in a filename stays harmless.
const sh = async (exec, on, script, ...args) => {
  const r = await exec("sh", ["-c", script, "ide", ...args], { on });
  if (r.code !== 0) throw new Error((r.stderr || "That did not work").trim());
  return r.stdout;
};

const exists = (p) => `{ [ -e "${p}" ] || [ -L "${p}" ]; }`;

export const parent = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
export const join = (a, b) => (a ? `${a}/${b}` : b);

// What is wrong with a typed name, or null. New items may include folders ("src/a.ts").
export function checkName(name, single) {
  if (!name) return "Enter a name";
  if (name.startsWith("/") || name.includes("\0")) return "Use a name inside this folder";
  if (single && name.includes("/")) return "A name cannot contain /";
  if (name.split("/").some((part) => !part || part === "." || part === "..")) return "Use a name inside this folder";
  return null;
}

export const newFile = (exec, path, on) =>
  sh(exec, on, `if ${exists("$1")}; then echo "\${1##*/} already exists" >&2; exit 1; fi; mkdir -p -- "$(dirname -- "$1")" && : > "$1"`, path);

export const newFolder = (exec, path, on) =>
  sh(exec, on, `if ${exists("$1")}; then echo "\${1##*/} already exists" >&2; exit 1; fi; mkdir -p -- "$1"`, path);

// Never replaces anything. -ef lets a rename change only the case on macOS.
export function move(exec, from, to, on) {
  if (to === from) return Promise.resolve("");
  if (to.startsWith(`${from}/`)) return Promise.reject(new Error("A folder cannot go inside itself"));
  return sh(exec, on, `if ${exists("$2")} && ! [ "$1" -ef "$2" ]; then echo "\${2##*/} already exists" >&2; exit 1; fi; mv -- "$1" "$2"`, from, to);
}

// Copies into a folder, as "name copy.ext" when the name is taken. Returns the new name.
export function copyInto(exec, from, folder, on) {
  if (folder === from || folder.startsWith(`${from}/`)) return Promise.reject(new Error("A folder cannot go inside itself"));
  return sh(exec, on, `base=\${1##*/}; stem=$base; ext=
case $base in ?*.*) stem=\${base%.*}; ext=.\${base##*.};; esac
t=$2/$base; n=1
while ${exists("$t")}; do
  if [ "$n" = 1 ]; then t="$2/$stem copy$ext"; else t="$2/$stem copy $n$ext"; fi
  n=$((n+1))
done
cp -R -- "$1" "$t" && printf %s "\${t##*/}"`, from, folder);
}

// To the system Trash, so a mistake can be undone from Finder. On another machine
// there is no Finder Trash: the file goes to ~/.Trash there instead.
export async function trash(exec, path, on = null) {
  if (on) {
    const r = await exec("sh", ["-c", 'mkdir -p "$HOME/.Trash" && mv -- "$1" "$HOME/.Trash/$(basename -- "$1").$(date +%s)"', "ide", path], { on });
    if (r.code !== 0) throw new Error("Could not move this to the Trash");
    return;
  }
  const r = await exec("/usr/bin/trash", [path]);
  if (r.code !== 0) throw new Error("Could not move this to the Trash");
}

// Throws away one file's uncommitted changes. A file git has never committed
// goes to the Trash; anything else returns to its last committed state.
export async function discard(exec, root, rel, isNew, hasHead, on) {
  const git = async (...args) => {
    const r = await exec("git", ["--literal-pathspecs", ...args], { cwd: root, on });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  };
  if (!isNew) return git("restore", "--source=HEAD", "--staged", "--worktree", "--", rel);
  // Unstage first: a staged new file would otherwise show as deleted once it is gone.
  await exec("git", ["--literal-pathspecs", "rm", "--cached", "-f", "-q", "--ignore-unmatch", "--", rel], { cwd: root, on });
  await trash(exec, `${root}/${rel}`, on);
}

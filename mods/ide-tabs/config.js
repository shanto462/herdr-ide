// Your launchers for the tab strip. This file is personal: keep your own copy when updating.
//
// SHORTCUTS: one button each at the right of the tab strip. A click goes to the tab with
//   that name in the current space, or starts it there (command: a program or shell
//   function; null for a plain shell). Started tabs keep this order at the front, so
//   cmd-1..n mean the same thing in every space.
// SAVED: folders that get an "Open <name>" button while no space is open there; it
//   recreates the space with every shortcut tab.
// USAGE: optional command printing per-account usage JSON for the meters
//   ([{ name, limits: { five_hour: { known, percent, resets_at }, weekly: {...} } }]);
//   null turns meters off.
// ACCOUNT_LABEL: terminal label written on tabs started from a shortcut (read by the
//   Explorer's "Send to …" menu).
//
// Example:
//   export const SHORTCUTS = [
//     { name: "claude", label: "claude", command: "claude" },
//     { name: "codex", label: "codex", command: "codex" },
//     { name: "terminal", label: "terminal", command: null },
//   ];
export const SHORTCUTS = [];

export const SAVED = [];

export const USAGE = null;
export const ACCOUNT_LABEL = "ccam.account";

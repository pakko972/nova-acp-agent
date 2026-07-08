/**
 * version-tree-provider.js — single-item TreeDataProvider for the sidebar
 * section that surfaces the current AI agent CLI version + state.
 *
 * State shape (set by main.js, read by the provider):
 *   {
 *     state: "unknown" | "checking" | "installed" | "up_to_date" |
 *            "update_available" | "not_installed" | "error",
 *     currentVersion: string | null,
 *     latestVersion: string | null,
 *     channel: "stable" | "next",
 *     lastCheckedAt: number | null,
 *     message: string | null,
 *   }
 *
 * The provider keeps a reference to the state; main.js mutates the same
 * object and calls treeView.reload() to refresh the single row.
 */

class VersionTreeProvider {
  constructor(state) {
    this.state = state;
  }

  getChildren(element) {
    if (!element) {
      return [{ kind: "version" }];
    }
    return [];
  }

  getTreeItem(element) {
    const s = this.state;
    const item = new TreeItem(formatLabel(s));
    item.identifier = "acpagent-version";
    item.descriptiveText = formatDescriptive(s);
    item.tooltip = formatTooltip(s);
    item.image = pickImage(s);
    item.command = "acpagent.checkForUpdates";
    return item;
  }
}

function formatLabel(s) {
  switch (s.state) {
    case "checking":
      return "Checking for updates…";
    case "up_to_date":
      return "Agent CLI " + s.currentVersion + " (up to date)";
    case "update_available":
      return "Agent CLI " + s.currentVersion + " → " + s.latestVersion;
    case "installed":
      return "Agent CLI " + (s.currentVersion || "?");
    case "not_installed":
      return "Agent CLI: not installed";
    case "error":
      return "Agent CLI: check failed";
    case "unknown":
    default:
      return "Agent CLI: version unknown";
  }
}

function formatDescriptive(s) {
  if (s.state === "update_available") return "Update available";
  if (s.state === "up_to_date") return "Up to date";
  if (s.state === "not_installed") return "Not found on PATH";
  if (s.state === "checking") return "";
  if (s.state === "error") return "Click to retry";
  if (s.state === "installed" && s.lastCheckedAt) return "Last checked: " + relativeTime(s.lastCheckedAt);
  return "";
}

function formatTooltip(s) {
  const lines = [];
  if (s.currentVersion) lines.push("Installed: " + s.currentVersion);
  if (s.latestVersion) lines.push("Latest (" + (s.channel || "stable") + "): " + s.latestVersion);
  if (s.lastCheckedAt) lines.push("Checked: " + new Date(s.lastCheckedAt).toLocaleString());
  if (s.message) lines.push(s.message);
  lines.push("Click to check for updates.");
  return lines.join("\n");
}

function pickImage(s) {
  switch (s.state) {
    case "update_available":
    case "not_installed":
      return "__builtin.warning";
    case "error":
      return "__builtin.error";
    case "up_to_date":
    case "installed":
      return "__builtin.info";
    case "checking":
      return "__builtin.refresh";
    case "unknown":
    default:
      return "__builtin.info";
  }
}

function relativeTime(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return Math.floor(diff) + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return new Date(ts).toLocaleDateString();
}

module.exports = { VersionTreeProvider: VersionTreeProvider };

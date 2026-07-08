// acp-discovery.js — ACP (Agent Communication Protocol) service-discovery
// manifest writer, analogous to Apple's Xcode 26+ IDE integration approach.
//
// Writes a JSON manifest to ~/.acp/ide/<port>.json so that any ACP-compatible
// AI agent can discover the running bridge. When legacy Claude lock support is
// enabled (CC_LEGACY_CLAUDE_LOCK=1), it also writes ~/.claude/ide/<port>.lock
// so the Claude Code CLI continues to work unchanged during the migration.
//
// Manifest format (ACP standard):
//   {
//     "pid":             <number>,
//     "port":            <number>,
//     "workspaceFolders": [<string>, ...],
//     "ideName":         "Nova",
//     "transport":       "ws",
//     "authToken":       "<uuid>",
//     "capabilities":    ["tool/openFile", "tool/openDiff", ...]   // optional
//   }

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function acpIdeDir() {
  return path.join(os.homedir(), ".acp", "ide");
}

function acpManifestPath(port) {
  return path.join(acpIdeDir(), `${port}.json`);
}

function claudeLockDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "ide");
}

function claudeLockPath(port) {
  return path.join(claudeLockDir(), `${port}.lock`);
}

// ---------------------------------------------------------------------------
// Write ACP manifest (and optionally the legacy Claude lock file)
// ---------------------------------------------------------------------------

/**
 * Write the ACP service-discovery manifest for this bridge instance.
 *
 * @param {Object} opts
 * @param {number}   opts.port             WebSocket port
 * @param {string}   opts.authToken        UUID auth token for the WebSocket
 * @param {string[]} opts.workspaceFolders Workspace paths (usually one)
 * @param {string[]} [opts.capabilities]   Optional list of MCP tool names
 * @param {boolean}  [opts.legacy]         Write legacy ~/.claude lock file too
 * @returns {{ acpPath: string, claudePath: string|null }}
 */
function writeManifest({ port, authToken, workspaceFolders, capabilities, legacy }) {
  const manifest = {
    pid:              process.pid,
    port:             port,
    workspaceFolders: workspaceFolders || [],
    ideName:          "Nova",
    transport:        "ws",
    authToken:        authToken,
  };
  if (Array.isArray(capabilities) && capabilities.length > 0) {
    manifest.capabilities = capabilities;
  }

  // Write ACP manifest
  const acpDir = acpIdeDir();
  try { fs.mkdirSync(acpDir, { recursive: true }); } catch (_) {}
  const acpPath = acpManifestPath(port);
  fs.writeFileSync(acpPath, JSON.stringify(manifest, null, 2));

  // Optionally write legacy Claude lock file
  let claudePath = null;
  if (legacy) {
    const lockDir = claudeLockDir();
    try { fs.mkdirSync(lockDir, { recursive: true }); } catch (_) {}
    claudePath = claudeLockPath(port);
    const lockData = {
      pid:              process.pid,
      workspaceFolders: workspaceFolders || [],
      ideName:          "Nova",
      transport:        "ws",
      authToken:        authToken,
    };
    fs.writeFileSync(claudePath, JSON.stringify(lockData, null, 2));
  }

  return { acpPath, claudePath };
}

// ---------------------------------------------------------------------------
// Remove ACP manifest (and optionally the legacy Claude lock file)
// ---------------------------------------------------------------------------

/**
 * Remove both the ACP manifest and the legacy Claude lock file for `port`.
 * Safe to call multiple times — missing files are silently ignored.
 *
 * @param {number}  port
 * @param {boolean} [legacy] Remove legacy Claude lock too
 */
function removeManifest(port, legacy) {
  try { fs.unlinkSync(acpManifestPath(port)); } catch (_) {}
  if (legacy) {
    try { fs.unlinkSync(claudeLockPath(port)); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { writeManifest, removeManifest };

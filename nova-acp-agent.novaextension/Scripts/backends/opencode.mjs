// backends/opencode.mjs — Chat backend implementation for OpenCode CLI.
//
// Drives `opencode run -p <prompt> --output-format stream-json` (or the
// equivalent flag once the OpenCode team finalises their non-interactive
// API). Falls back gracefully when the binary is not installed.
//
// Implements the pluggable backend interface:
//   sendMessage(opts)   → AsyncGenerator<ChatEvent>
//
// ChatEvent types emitted (same wire format the chat UI WebSocket expects):
//   { type: "session_started", sessionId, model, mode: "opencode-cli" }
//   { type: "assistant_text",  chunk }
//   { type: "assistant_thinking", chunk }
//   { type: "assistant_tool_use", name, input }
//   { type: "tool_result", name, text, isError }
//   { type: "result", success, cost?, tokens?, error? }

import { spawn } from "child_process";

/**
 * Create an OpenCode CLI backend instance.
 *
 * @param {Object}  opts
 * @param {string}  opts.agentPath     Path / command to the opencode binary
 * @param {string}  opts.model         Model identifier to pass to --model
 * @param {string}  opts.cliPermissionMode  Permission mode flag value
 * @param {Function} opts.log          (level, msg, data?) → void
 */
export function createOpenCodeBackend({ agentPath = "opencode", model: initialModel, cliPermissionMode = "acceptEdits", log }) {
  let currentModel = initialModel;

  function setModel(m) { currentModel = m; }

  /**
   * Send a message and stream back ChatEvent objects.
   *
   * @param {Object}           opts
   * @param {string}           opts.prompt          Text prompt
   * @param {string|null}      opts.sessionId       Session to resume
   * @param {AbortController}  opts.abortController
   * @yields {Object} ChatEvent
   */
  async function* sendMessage({ prompt, sessionId, abortController }) {
    const bin = agentPath || "opencode";
    const args = [
      "run",
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--model", currentModel,
    ];

    // Permission mode
    if (cliPermissionMode && cliPermissionMode !== "default") {
      args.push("--permission-mode", cliPermissionMode);
    }

    // Resume a previous session
    if (sessionId) args.push("--resume", sessionId);

    // Extend PATH so the binary is found even in Nova's stripped env.
    const env = { ...process.env };
    if (!bin.startsWith("/")) {
      const home = process.env.HOME || "";
      const extra = [`${home}/.local/bin`, "/usr/local/bin", "/opt/homebrew/bin"];
      const cur = (env.PATH || "").split(":");
      env.PATH = [...new Set([...extra, ...cur])].filter(Boolean).join(":");
    }

    let child;
    try {
      child = spawn(bin, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        signal: abortController?.signal,
      });
    } catch (err) {
      yield { type: "result", success: false, error: `opencode spawn failed: ${err.message}` };
      return;
    }

    // Yield events by parsing the JSON event stream line-by-line.
    // The stream format is modelled on the Claude Code CLI stream-json format;
    // adjust the field names below once OpenCode publishes its spec.
    let buf = "";
    let capturedSessionId = null;
    let lastCost = null;
    let lastUsage = null;

    const lineQueue = [];
    let resolveNext = null;
    let done = false;

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        lineQueue.push(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
      if (resolveNext) { resolveNext(); resolveNext = null; }
    });

    let stderrBuf = "";
    child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString("utf8"); });

    child.on("close", () => { done = true; if (resolveNext) { resolveNext(); resolveNext = null; } });
    child.on("error", () => { done = true; if (resolveNext) { resolveNext(); resolveNext = null; } });

    while (!done || lineQueue.length > 0) {
      if (lineQueue.length === 0) {
        await new Promise((r) => { resolveNext = r; });
        continue;
      }
      const line = lineQueue.shift();
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch (_) { continue; }

      // Normalize OpenCode stream-json events (mirrors Claude Code format).
      if (evt.type === "system" && evt.subtype === "init") {
        capturedSessionId = evt.session_id;
        yield { type: "session_started", sessionId: evt.session_id, model: evt.model ?? currentModel, mode: "opencode-cli" };
      } else if (evt.type === "stream_event" && evt.event?.type === "content_block_delta") {
        const delta = evt.event.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          yield { type: "assistant_text", chunk: delta.text };
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          yield { type: "assistant_thinking", chunk: delta.thinking };
        }
      } else if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (block?.type === "tool_use") {
            yield { type: "assistant_tool_use", name: block.name, input: block.input || {} };
          }
        }
      } else if (evt.type === "user" && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (block?.type === "tool_result") {
            const text = Array.isArray(block.content)
              ? block.content.map((c) => c.text ?? "").join("")
              : (block.content ?? "");
            yield { type: "tool_result", name: block.name ?? "unknown", text, isError: !!block.is_error };
          }
        }
      } else if (evt.type === "result") {
        lastCost  = evt.total_cost_usd ?? null;
        lastUsage = evt.usage ?? null;
      }
    }

    const exitCode = await new Promise((r) => child.on("close", r));
    if (exitCode === 0 || exitCode == null) {
      yield {
        type:    "result",
        success: true,
        cost:    lastCost,
        tokens:  lastUsage ? { input: lastUsage.input_tokens, output: lastUsage.output_tokens } : null,
      };
    } else {
      yield {
        type:    "result",
        success: false,
        error:   stderrBuf.trim().split("\n").slice(-3).join("\n") || `opencode CLI exited with code ${exitCode}`,
      };
    }

    return capturedSessionId;
  }

  return { sendMessage, setModel };
}

// backends/anthropic.mjs — Chat backend implementation using the
// @anthropic-ai/claude-agent-sdk. This module drives the Anthropic Claude
// models through the Agent SDK's query() API with in-process Nova MCP tools.
//
// Implements the pluggable backend interface:
//   startSession(opts)  → void  (no-op; sessions are implicit in the SDK)
//   sendMessage(opts)   → AsyncGenerator<ChatEvent>
//   stopSession()       → void  (no-op; sessions are implicitly ended)
//
// ChatEvent types emitted (same wire format the chat UI WebSocket expects):
//   { type: "session_started", sessionId, model, mode: "sdk" }
//   { type: "assistant_text",  chunk }
//   { type: "assistant_thinking", chunk }
//   { type: "assistant_tool_use", name, input }
//   { type: "tool_result", name, text, isError }
//   { type: "result", success, cost?, tokens?, error? }

import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildNovaToolsServer } from "../chat-tool-wrappers.mjs";

/**
 * Create an Anthropic backend instance.
 *
 * @param {Object}   opts
 * @param {string}   opts.apiKey        ANTHROPIC_API_KEY (already set in env by caller)
 * @param {string}   opts.model         Model identifier, e.g. "claude-sonnet-4-6"
 * @param {Function} opts.callNovaTool  async (toolName, args) → MCP payload
 * @param {Function} opts.log           (level, msg, data?) → void
 * @returns {{ sendMessage, stopSession, novaServer, allowedToolNames }}
 */
export function createAnthropicBackend({ apiKey, model: initialModel, callNovaTool, log }) {
  // Inject the API key into the process environment for the SDK.
  if (apiKey) process.env.ANTHROPIC_API_KEY = apiKey;

  // Build the in-process Nova MCP tool server. Used by the SDK to call Nova
  // editor operations without going through the MCP WebSocket.
  const { server: novaServer, toolNames: allowedToolNames } = buildNovaToolsServer({ callNovaTool, log });
  log("info", `anthropic backend: ${allowedToolNames.length} Nova tools exposed to SDK`);

  let currentModel = initialModel;

  /**
   * Set (or switch) the active model at runtime.
   * @param {string} m
   */
  function setModel(m) { currentModel = m; }

  /**
   * Send a message and stream back ChatEvent objects.
   *
   * @param {Object}             opts
   * @param {string|AsyncIterable} opts.prompt       Text prompt or multimodal iterable
   * @param {string|null}          opts.sessionId    Session to resume (null = new)
   * @param {AbortController}      opts.abortController
   * @yields {Object} ChatEvent
   */
  async function* sendMessage({ prompt, sessionId, abortController }) {
    const q = query({
      prompt,
      options: {
        model:           currentModel,
        tools:           [],
        settingSources:  [],
        mcpServers:      { nova: novaServer },
        allowedTools:    allowedToolNames,
        abortController,
        ...(sessionId ? { resume: sessionId } : {}),
      },
    });

    let capturedSessionId = sessionId || null;

    for await (const event of q) {
      switch (event.type) {
        case "system":
          if (event.subtype === "init") {
            if (!capturedSessionId) capturedSessionId = event.session_id;
            yield { type: "session_started", sessionId: event.session_id, model: event.model ?? currentModel, mode: "sdk" };
          }
          break;
        case "assistant": {
          const content = event.message?.content ?? [];
          for (const block of content) {
            if (block.type === "text") {
              yield { type: "assistant_text", chunk: block.text };
            } else if (block.type === "thinking" && typeof block.thinking === "string") {
              yield { type: "assistant_thinking", chunk: block.thinking };
            } else if (block.type === "tool_use") {
              yield { type: "assistant_tool_use", name: block.name, input: block.input };
            }
          }
          break;
        }
        case "user": {
          const content = event.message?.content ?? [];
          for (const block of content) {
            if (block.type === "tool_result") {
              const text = Array.isArray(block.content)
                ? block.content.map((c) => c.text ?? "").join("")
                : (block.content ?? "");
              yield { type: "tool_result", name: block.name ?? "unknown", text, isError: !!block.is_error };
            }
          }
          break;
        }
        case "result":
          yield {
            type:    "result",
            success: event.subtype === "success",
            cost:    event.total_cost_usd ?? null,
            tokens:  event.usage ? { input: event.usage.input_tokens, output: event.usage.output_tokens } : null,
            ...(event.subtype !== "success" ? { error: event.error ?? String(event) } : {}),
          };
          break;
      }
    }

    return capturedSessionId;
  }

  return { sendMessage, setModel, novaServer, allowedToolNames };
}

/**
 * compaction-tool-pair-guard
 * -----------------------------------------------------------------------------
 * Works around OpenCode's long-standing "orphaned tool_use" bug that makes a
 * session unrecoverable after auto-compaction (or after an interrupted tool
 * call). Anthropic rejects any request where a `tool_use` block is not
 * immediately followed by its matching `tool_result`:
 *
 *   messages.N: `tool_use` ids were found without `tool_result` blocks
 *   immediately after: toolu_XXXX. Each `tool_use` block must have a
 *   corresponding `tool_result` block in the next message.
 *
 * Upstream issues: anomalyco/opencode #27594, #21326, #14367, #17065, #8497,
 * #10616, #1662. No released opencode version fixes this yet, so this plugin
 * does two things:
 *
 *   1. PREVENT (experimental.chat.messages.transform): before every request
 *      and before every compaction, heal any tool call left in pending/running
 *      state by converting it to an error result. That guarantees every
 *      `tool_use` has a paired `tool_result`, eliminating the most common
 *      orphan source (interrupted / aborted tool calls).
 *
 *   2. RECOVER (event: session.error): if an orphan still slips through and
 *      Anthropic returns the 400, automatically revert the failed trailing
 *      message so the session is usable again WITHOUT opening a new terminal,
 *      and surface a toast. Debounced so it can never loop.
 *
 * Drop-in: lives in ~/.config/opencode/plugin/ and loads globally for every
 * project and every Paseo worktree. No config changes required.
 *
 * @type {import("@opencode-ai/plugin").Plugin}
 */
export const CompactionToolPairGuard = async ({ client }) => {
  const ORPHAN_SIGNATURE = "were found without"; // canonical Anthropic phrase
  const TOOLU_RE = /toolu_[A-Za-z0-9_]+/g;
  const DEBOUNCE_MS = 20000;
  const lastRecovery = new Map(); // sessionID -> timestamp

  const log = (...args) => {
    try {
      console.log("[compaction-tool-pair-guard]", ...args);
    } catch {
      /* noop */
    }
  };

  /**
   * Convert any pending/running tool part into a synthetic error result so the
   * model-message conversion emits a matching tool_result for its tool_use.
   * Mutates the parts in place. Returns the number of parts healed.
   */
  const healDanglingToolParts = (messages) => {
    let healed = 0;
    for (const entry of messages ?? []) {
      const info = entry?.info;
      const parts = entry?.parts;
      if (!info || info.role !== "assistant" || !Array.isArray(parts)) continue;
      for (const part of parts) {
        if (part?.type !== "tool") continue;
        const status = part?.state?.status;
        if (status !== "pending" && status !== "running") continue;
        const start = part?.state?.time?.start ?? Date.now();
        part.state = {
          status: "error",
          input: part?.state?.input ?? {},
          error:
            "[Tool execution did not complete — synthesized by compaction-tool-pair-guard to keep tool_use/tool_result paired]",
          time: { start, end: Date.now() },
        };
        healed += 1;
      }
    }
    return healed;
  };

  return {
    /**
     * PREVENT: runs before each LLM request AND before compaction slicing.
     * Heals dangling tool calls so no orphaned tool_use is ever sent.
     */
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const healed = healDanglingToolParts(output?.messages);
        if (healed > 0) log(`healed ${healed} dangling tool call(s) before request`);
      } catch (err) {
        log("transform hook error (non-fatal):", err?.message ?? err);
      }
    },

    /**
     * RECOVER: catches the Anthropic 400 if an orphan still reaches the API,
     * reverts the failed trailing message, and restores the session in place.
     */
    event: async ({ event }) => {
      try {
        if (event?.type !== "session.error") return;
        const props = event.properties ?? {};
        const error = props.error;
        const sessionID = props.sessionID;
        if (!sessionID || !error) return;
        if (error.name !== "APIError") return;

        const message = error?.data?.message ?? "";
        const body = error?.data?.responseBody ?? "";
        const blob = `${message}\n${body}`;
        if (!blob.includes("tool_use") || !blob.includes("tool_result")) return;
        if (!blob.includes(ORPHAN_SIGNATURE)) return;

        const now = Date.now();
        const previous = lastRecovery.get(sessionID) ?? 0;
        if (now - previous < DEBOUNCE_MS) {
          log("orphan error seen again within debounce window; not re-reverting");
          return;
        }
        lastRecovery.set(sessionID, now);

        const offendingIds = [...blob.matchAll(TOOLU_RE)].map((m) => m[0]);
        log(
          `detected orphaned tool_use error in ${sessionID}` +
            (offendingIds.length ? ` (ids: ${offendingIds.join(", ")})` : ""),
        );

        const res = await client.session.messages({ path: { id: sessionID } });
        const messages = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        if (!messages.length) {
          log("no messages returned; cannot auto-recover");
          return;
        }

        // Prefer reverting the trailing failed message (the failed compaction
        // attempt or failed turn). This is the least destructive way to break
        // the wedge — it mirrors the manual "undo the last turn" recovery.
        let targetMessageID;
        for (let i = messages.length - 1; i >= 0; i--) {
          const info = messages[i]?.info;
          if (!info) continue;
          if (info.role === "assistant" && (info.error || info.summary)) {
            targetMessageID = info.id;
            break;
          }
        }
        // Fallback: revert the very last message regardless of role.
        if (!targetMessageID) {
          targetMessageID = messages[messages.length - 1]?.info?.id;
        }
        if (!targetMessageID) {
          log("could not determine a revert target");
          return;
        }

        await client.session.revert({
          path: { id: sessionID },
          body: { messageID: targetMessageID },
        });
        log(`reverted message ${targetMessageID} to recover session ${sessionID}`);

        await client.tui
          .showToast({
            body: {
              title: "Session recovered",
              message:
                "Auto-recovered from a compaction tool_use/tool_result error. " +
                "The broken turn was reverted — continue as normal, or run /unrevert to restore it.",
              variant: "success",
            },
          })
          .catch(() => {});
      } catch (err) {
        log("recovery hook error (non-fatal):", err?.message ?? err);
        try {
          await client.tui
            .showToast({
              body: {
                title: "Compaction guard",
                message:
                  "Detected a tool_use/tool_result error but auto-recovery failed. " +
                  "Try /unrevert or revert the last turn manually.",
                variant: "warning",
              },
            })
            .catch(() => {});
        } catch {
          /* noop */
        }
      }
    },
  };
};

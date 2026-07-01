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
 *   1. PREVENT (experimental.chat.messages.transform): a pairing-normalization
 *      pass over the WithParts[] array that opencode is about to convert and
 *      send. It mirrors opencode's own conversion rules (which tool-part states
 *      emit a tool_use / tool_result, and the assistant-error skip), then drops
 *      any tool part that would emit a tool_use without a matching tool_result
 *      (and any dangling result). It NEVER fabricates tool output the model
 *      would reason over — it only removes provably-unpaired members. The pass
 *      is idempotent and order-independent, so it is correct no matter where it
 *      runs relative to other plugins. This is defense-in-depth: it closes the
 *      genuinely-unpaired classes (interrupted/aborted turns, and any future
 *      opencode regression where a state stops emitting its counterpart).
 *
 *   2. RECOVER (event: session.error): if an orphan still reaches Anthropic and
 *      it returns the 400 (the post-compaction reorder class lives downstream of
 *      the transform, inside the AI-SDK conversion, so prevention cannot always
 *      reach it), parse the offending toolu_ ids out of the error, find the
 *      message that actually holds that orphaned tool_use, and revert to that
 *      turn's clean boundary so the orphan is excluded from the next send.
 *      A per-orphan-id state machine guarantees we act once per distinct orphan
 *      and HARD-STOP (with an actionable toast) if the same orphan recurs after
 *      we acted — so you never sit in a silent 400 loop again. Reverts are
 *      reversible with /unrevert.
 *
 * Drop-in: lives in ~/.config/opencode/plugin/ and loads globally for every
 * project and every Paseo worktree. No config changes required.
 *
 * @type {import("@opencode-ai/plugin").Plugin}
 */
export const CompactionToolPairGuard = async ({ client }) => {
  const ORPHAN_SIGNATURE = "were found without" // canonical Anthropic phrase
  const TOOLU_RE = /toolu_[A-Za-z0-9_]+/g
  const SETTLE_MS = 750 // let the failed stream finish tearing down before we revert

  /**
   * Per-session recovery state machine (NOT a time debounce — that is exactly
   * what made the original failures silent and repeating).
   *   handled: Set<callID> we have already reverted for
   *   acting:  a revert is in flight for this session
   *   blindReverted: we already did one id-less fallback revert
   * @type {Map<string, { handled: Set<string>, acting: boolean, blindReverted: boolean }>}
   */
  const recovery = new Map()

  const log = (...args) => {
    try {
      console.log("[compaction-tool-pair-guard]", ...args)
    } catch {
      /* noop */
    }
  }

  const toast = (title, message, variant) =>
    client.tui.showToast({ body: { title, message, variant } }).catch(() => {})

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // ---------------------------------------------------------------------------
  // Layer 1 — PREVENT: pairing normalization
  // ---------------------------------------------------------------------------

  // Mirror opencode's toModelMessagesEffect (message-v2.ts) skip rule: an
  // assistant message with a non-aborted error emits NOTHING (neither tool_use
  // nor tool_result), so its tool parts cannot orphan. An aborted error that
  // still carries real content is kept.
  const isSkippedAssistant = (info, parts) => {
    if (info.role !== "assistant" || !info.error) return false
    const aborted = info.error?.name === "AbortedError"
    const hasContent = parts.some((p) => p?.type !== "step-start" && p?.type !== "reasoning")
    return !(aborted && hasContent)
  }

  // Every terminal tool-part state opencode converts emits BOTH a tool_use and a
  // matching tool_result (completed/error -> result; pending/running -> an
  // "interrupted" error result). We treat all of these as "emits a result".
  // Anything else (a hypothetical non-terminal state from a future opencode)
  // emits a tool_use with no result -> a genuine orphan we must drop.
  const emitsResult = (status) =>
    status === "completed" || status === "error" || status === "pending" || status === "running"

  /**
   * Remove any tool part that would convert to a tool_use without a matching
   * tool_result. Mutates parts in place. Returns the number of parts dropped.
   * Conservative by construction: under current opencode rules every tool part
   * is self-pairing, so this drops nothing; it only fires on genuinely broken
   * (unpaired) parts.
   */
  const normalizeToolPairs = (messages) => {
    let dropped = 0
    for (const entry of messages ?? []) {
      const info = entry?.info
      const parts = entry?.parts
      if (!info || !Array.isArray(parts) || parts.length === 0) continue
      if (isSkippedAssistant(info, parts)) continue
      if (info.role !== "assistant") continue
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i]
        if (part?.type !== "tool" || !part.callID) continue
        if (!emitsResult(part?.state?.status)) {
          parts.splice(i, 1)
          dropped += 1
        }
      }
    }
    return dropped
  }

  // ---------------------------------------------------------------------------
  // Layer 2 — RECOVER helpers
  // ---------------------------------------------------------------------------

  const getMessages = async (sessionID) => {
    const res = await client.session.messages({ path: { id: sessionID } })
    if (Array.isArray(res?.data)) return res.data
    if (Array.isArray(res)) return res
    return []
  }

  /**
   * Pick the least-destructive revert target that still removes the orphan.
   *
   * The offending tool_use lives in a real assistant message (summaries are
   * generated tool-free, so an orphan callID is never inside a summary). We
   * find that message, then revert to the nearest preceding USER message so the
   * next replay starts on a clean turn boundary (reverting the orphan message
   * itself can leave its sibling dangling as the new tail head — a symmetric
   * orphan). Returns the messageID to revert to, or undefined.
   */
  const pickRevertTarget = (messages, offendingIds) => {
    const ids = new Set(offendingIds)
    let orphanIndex = -1
    for (let i = 0; i < messages.length; i++) {
      const parts = messages[i]?.parts ?? []
      if (parts.some((p) => p?.type === "tool" && p.callID && ids.has(p.callID))) {
        orphanIndex = i
        break
      }
    }
    if (orphanIndex >= 0) {
      for (let i = orphanIndex; i >= 0; i--) {
        if (messages[i]?.info?.role === "user") return messages[i].info.id
      }
      // No preceding user message: revert the orphan message itself.
      return messages[orphanIndex]?.info?.id
    }
    return undefined
  }

  // Last-resort target when the offending ids cannot be located (e.g. the part
  // was pruned): the most recent user message.
  const trailingUserTarget = (messages) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.info?.role === "user") return messages[i].info.id
    }
    return messages[messages.length - 1]?.info?.id
  }

  return {
    /**
     * PREVENT: runs before each LLM request AND before compaction slicing, on
     * the exact (already compaction-filtered/reordered) WithParts[] array that
     * opencode is about to convert and send.
     */
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const dropped = normalizeToolPairs(output?.messages)
        if (dropped > 0) log(`dropped ${dropped} unpaired tool part(s) before request`)
      } catch (err) {
        log("transform hook error (non-fatal):", err?.message ?? err)
      }
    },

    /**
     * RECOVER: catches the Anthropic 400 if an orphan still reaches the API,
     * reverts to the orphan turn's clean boundary, and hard-stops if the same
     * orphan recurs so the session can never wedge into a silent 400 loop.
     */
    event: async ({ event }) => {
      try {
        if (event?.type !== "session.error") return
        const props = event.properties ?? {}
        const error = props.error
        const sessionID = props.sessionID
        if (!sessionID || !error || error.name !== "APIError") return

        const blob = `${error?.data?.message ?? ""}\n${error?.data?.responseBody ?? ""}`
        if (!blob.includes("tool_use") || !blob.includes("tool_result")) return
        if (!blob.includes(ORPHAN_SIGNATURE)) return

        const offendingIds = [...new Set([...blob.matchAll(TOOLU_RE)].map((m) => m[0]))]

        let state = recovery.get(sessionID)
        if (!state) {
          state = { handled: new Set(), acting: false, blindReverted: false }
          recovery.set(sessionID, state)
        }

        // HARD STOP: we already reverted for exactly these ids and they came
        // back. Reverting again would just loop. Tell the human and stop.
        const recurring =
          offendingIds.length > 0 && offendingIds.every((id) => state.handled.has(id))
        if (recurring) {
          log(`orphan(s) ${offendingIds.join(", ")} recurred after recovery in ${sessionID}; stopping`)
          await toast(
            "Compaction guard: manual fix needed",
            "Auto-recovery already reverted this tool_use/tool_result error once and it came back. " +
              "Revert the last turn manually (or start a fresh session) — auto-recovery has stopped to avoid a loop.",
            "warning",
          )
          return
        }

        if (state.acting) {
          log(`recovery already in progress for ${sessionID}; skipping concurrent error`)
          return
        }
        state.acting = true
        try {
          log(
            `detected orphaned tool_use error in ${sessionID}` +
              (offendingIds.length ? ` (ids: ${offendingIds.join(", ")})` : " (no ids parsed)"),
          )

          // Let the failed stream finish tearing down before mutating session state.
          await delay(SETTLE_MS)

          const messages = await getMessages(sessionID)
          if (!messages.length) {
            log("no messages returned; cannot auto-recover")
            return
          }

          let targetMessageID
          if (offendingIds.length > 0) {
            targetMessageID = pickRevertTarget(messages, offendingIds)
          }
          if (!targetMessageID) {
            // Could not locate the orphan part. Do ONE id-less trailing revert,
            // then never blind-revert again for this session.
            if (state.blindReverted) {
              log("orphan part not found and already blind-reverted; stopping")
              await toast(
                "Compaction guard: manual fix needed",
                "Couldn't locate the orphaned tool call to recover automatically. " +
                  "Revert the last turn manually (or /unrevert) to continue.",
                "warning",
              )
              return
            }
            targetMessageID = trailingUserTarget(messages)
            state.blindReverted = true
          }
          if (!targetMessageID) {
            log("could not determine a revert target")
            return
          }

          await client.session.revert({
            path: { id: sessionID },
            body: { messageID: targetMessageID },
          })
          for (const id of offendingIds) state.handled.add(id)
          log(`reverted to ${targetMessageID} to recover session ${sessionID}`)

          await toast(
            "Session recovered",
            "Auto-recovered from a compaction tool_use/tool_result error. " +
              "The broken turn was reverted — continue as normal, or run /unrevert to restore it.",
            "success",
          )
        } finally {
          state.acting = false
        }
      } catch (err) {
        log("recovery hook error (non-fatal):", err?.message ?? err)
        await toast(
          "Compaction guard",
          "Detected a tool_use/tool_result error but auto-recovery failed. " +
            "Try /unrevert or revert the last turn manually.",
          "warning",
        )
      }
    },
  }
}

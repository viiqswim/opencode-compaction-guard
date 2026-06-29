/**
 * Smoke test for compaction-tool-pair-guard.
 * Runs with plain Node (no deps): `node test/smoke.mjs`.
 * Exits non-zero on any failed assertion so CI can gate publishing on it.
 */
import { CompactionToolPairGuard } from "../plugin/compaction-tool-pair-guard.mjs";

let failures = 0;
const assert = (cond, label) => {
  if (cond) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`  FAIL - ${label}`);
    failures += 1;
  }
};

const makeClient = (calls, messages) => ({
  session: {
    messages: async () => ({ data: messages }),
    revert: async (o) => {
      calls.push(["revert", o.body.messageID]);
      return { data: {} };
    },
  },
  tui: {
    showToast: async (o) => {
      calls.push(["toast", o.body.variant]);
      return {};
    },
  },
});

const run = async () => {
  // 1. PREVENT: a running tool part is healed into an error result.
  {
    const hooks = await CompactionToolPairGuard({ client: makeClient([], []) });
    const messages = [
      {
        info: { id: "a1", role: "assistant" },
        parts: [
          { type: "tool", tool: "bash", callID: "toolu_x", state: { status: "running", input: {}, time: { start: 1 } } },
        ],
      },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    assert(messages[0].parts[0].state.status === "error", "running tool call healed to error result");
  }

  // 2. PREVENT: a completed tool part is left untouched.
  {
    const hooks = await CompactionToolPairGuard({ client: makeClient([], []) });
    const messages = [
      {
        info: { id: "a1", role: "assistant" },
        parts: [
          { type: "tool", tool: "bash", callID: "toolu_y", state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } } },
        ],
      },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    assert(messages[0].parts[0].state.status === "completed", "completed tool call left untouched");
  }

  // 3. RECOVER: the orphan error triggers exactly one revert + one toast.
  {
    const calls = [];
    const messages = [
      { info: { id: "m1", role: "user" }, parts: [] },
      { info: { id: "m2", role: "assistant", summary: true, error: { name: "APIError" } }, parts: [] },
    ];
    const hooks = await CompactionToolPairGuard({ client: makeClient(calls, messages) });
    const orphanEvent = {
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          error: {
            name: "APIError",
            data: { message: "messages.2: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01AC", isRetryable: false },
          },
        },
      },
    };
    await hooks.event(orphanEvent);
    // 4. DEBOUNCE: a second identical error within the window does NOT re-revert.
    await hooks.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          error: { name: "APIError", data: { message: "were found without tool_result toolu_02ZZ", isRetryable: false } },
        },
      },
    });
    const reverts = calls.filter((c) => c[0] === "revert");
    const toasts = calls.filter((c) => c[0] === "toast");
    assert(reverts.length === 1, "orphan error reverts exactly once");
    assert(reverts[0][1] === "m2", "reverts the failed trailing message");
    assert(toasts.length === 1 && toasts[0][1] === "success", "shows a success toast");
  }

  // 5. IGNORE: unrelated errors are ignored.
  {
    const calls = [];
    const hooks = await CompactionToolPairGuard({ client: makeClient(calls, []) });
    await hooks.event({
      event: { type: "session.error", properties: { sessionID: "ses_2", error: { name: "APIError", data: { message: "rate limited", isRetryable: true } } } },
    });
    assert(calls.length === 0, "unrelated API error is ignored");
  }

  console.log(failures === 0 ? "\nAll smoke tests passed." : `\n${failures} smoke test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});

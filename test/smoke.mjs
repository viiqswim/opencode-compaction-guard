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

const toolPart = (callID, status) => ({ type: "tool", tool: "bash", callID, state: { status, input: {}, time: { start: 1 } } });
// Mirrors the real Anthropic 400 wording (always contains both `tool_use` and `tool_result`).
const orphanMessage = (callID) =>
  "messages.2: `tool_use` ids were found without `tool_result` blocks immediately after: " + callID;
const orphanEvent = (sessionID, message) => ({
  event: { type: "session.error", properties: { sessionID, error: { name: "APIError", data: { message, isRetryable: false } } } },
});

const run = async () => {
  // 1. PREVENT: a completed tool part is paired -> kept untouched.
  {
    const hooks = await CompactionToolPairGuard({ client: makeClient([], []) });
    const messages = [{ info: { id: "a1", role: "assistant" }, parts: [toolPart("toolu_done", "completed")] }];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    assert(messages[0].parts.length === 1, "completed tool part kept (paired by opencode)");
  }

  // 2. PREVENT: pending/running parts are paired by opencode's own conversion -> NOT dropped.
  {
    const hooks = await CompactionToolPairGuard({ client: makeClient([], []) });
    const messages = [
      { info: { id: "a1", role: "assistant" }, parts: [toolPart("toolu_run", "running"), toolPart("toolu_pend", "pending")] },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    assert(messages[0].parts.length === 2, "pending/running tool parts kept (opencode pairs them)");
  }

  // 3. PREVENT: a tool part in a non-terminal/unknown state would emit a tool_use with no
  //    tool_result -> it is a genuine orphan and is dropped (never fabricated into a fake result).
  {
    const hooks = await CompactionToolPairGuard({ client: makeClient([], []) });
    const messages = [
      { info: { id: "a1", role: "assistant" }, parts: [toolPart("toolu_ok", "completed"), toolPart("toolu_bad", "input-available")] },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    assert(messages[0].parts.length === 1 && messages[0].parts[0].callID === "toolu_ok", "unpaired (non-terminal) tool part dropped");
  }

  // 4. PREVENT: idempotent + order-independent (running twice changes nothing further).
  {
    const hooks = await CompactionToolPairGuard({ client: makeClient([], []) });
    const messages = [
      { info: { id: "a1", role: "assistant" }, parts: [toolPart("toolu_ok", "completed"), toolPart("toolu_bad", "weird")] },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    const afterFirst = messages[0].parts.length;
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    assert(afterFirst === 1 && messages[0].parts.length === 1, "normalization is idempotent");
  }

  // 5. RECOVER: orphan error reverts to the orphan turn's clean boundary (nearest preceding user) + success toast.
  {
    const calls = [];
    const messages = [
      { info: { id: "u1", role: "user" }, parts: [] },
      { info: { id: "a1", role: "assistant" }, parts: [toolPart("toolu_01AC", "completed")] }, // holds the orphan
      { info: { id: "a2", role: "assistant", summary: true }, parts: [] },
    ];
    const hooks = await CompactionToolPairGuard({ client: makeClient(calls, messages) });
    await hooks.event(orphanEvent("ses_1", orphanMessage("toolu_01AC")));
    const reverts = calls.filter((c) => c[0] === "revert");
    const toasts = calls.filter((c) => c[0] === "toast");
    assert(reverts.length === 1, "orphan error reverts exactly once");
    assert(reverts[0][1] === "u1", "reverts to the nearest preceding user message of the orphan turn");
    assert(toasts.length === 1 && toasts[0][1] === "success", "shows a success toast");
  }

  // 6. RECOVER hard-stop: the SAME orphan id recurring after recovery does NOT re-revert (no silent loop).
  {
    const calls = [];
    const messages = [
      { info: { id: "u1", role: "user" }, parts: [] },
      { info: { id: "a1", role: "assistant" }, parts: [toolPart("toolu_01AC", "completed")] },
    ];
    const hooks = await CompactionToolPairGuard({ client: makeClient(calls, messages) });
    await hooks.event(orphanEvent("ses_2", orphanMessage("toolu_01AC")));
    await hooks.event(orphanEvent("ses_2", orphanMessage("toolu_01AC")));
    const reverts = calls.filter((c) => c[0] === "revert");
    const warnings = calls.filter((c) => c[0] === "toast" && c[1] === "warning");
    assert(reverts.length === 1, "same orphan recurrence reverts only once");
    assert(warnings.length === 1, "recurrence surfaces an actionable warning toast (hard stop)");
  }

  // 7. RECOVER: a DIFFERENT orphan id after a prior recovery is treated fresh and reverts again.
  {
    const calls = [];
    const messages = [
      { info: { id: "u1", role: "user" }, parts: [] },
      { info: { id: "a1", role: "assistant" }, parts: [toolPart("toolu_AAA", "completed")] },
      { info: { id: "u2", role: "user" }, parts: [] },
      { info: { id: "a2", role: "assistant" }, parts: [toolPart("toolu_BBB", "completed")] },
    ];
    const hooks = await CompactionToolPairGuard({ client: makeClient(calls, messages) });
    await hooks.event(orphanEvent("ses_3", orphanMessage("toolu_AAA")));
    await hooks.event(orphanEvent("ses_3", orphanMessage("toolu_BBB")));
    const reverts = calls.filter((c) => c[0] === "revert");
    assert(reverts.length === 2, "distinct orphan ids each get their own recovery");
    assert(reverts[0][1] === "u1" && reverts[1][1] === "u2", "each reverts to its own turn boundary");
  }

  // 8. IGNORE: unrelated API errors are ignored.
  {
    const calls = [];
    const hooks = await CompactionToolPairGuard({ client: makeClient(calls, []) });
    await hooks.event(orphanEvent("ses_4", "rate limited"));
    assert(calls.length === 0, "unrelated API error is ignored");
  }

  console.log(failures === 0 ? "\nAll smoke tests passed." : `\n${failures} smoke test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});

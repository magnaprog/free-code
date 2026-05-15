# free-code compaction + LLM provider plan

## 0. Status and intent

This document is the implementation and verification plan for improving:

1. long-session context compaction,
2. context diagnostics,
3. provider/auth architecture,
4. OpenCode Go support,
5. recovery after context overflow.

It is **not** a request to rewrite the agent loop. The safest path is small PRs, each with tests and a clear behavior-preservation report.

Current decision:

```txt
quarantine broken gates
extend existing /context + local compaction config
budget post-compact attachments
preserve raw tail in normal compact
add provider resolver/auth store around existing providers
add OpenCode Go only after endpoint verification
add structured summary fallback path
add artifact recall only after redaction is tested
implement reactive compact
extract provider-aware ContextManager last
```

Highest-value changes:

1. **Tail-preserving normal compact**.
2. **Provider resolver/auth store that preserves current env behavior**.

Do not start with a broad `query.ts` rewrite.

---

## 1. Core goals

### 1.1 Compaction goals

A correct context system should optimize in this order:

1. **Correct continuation**
   - The assistant must still know the active task, current files, user constraints, failing tests, plan state, and next action after compact.

2. **Recoverability**
   - Old raw details must remain findable from transcript ranges, persisted tool results, summaries, and artifact refs.

3. **Provider compatibility**
   - Context packing must work across Anthropic Messages, OpenAI Responses, ChatGPT Codex, OpenAI-compatible chat, Bedrock, Vertex, Foundry, local providers, and future providers.

4. **Cost/latency control**
   - Avoid summary inflation, repeated full-context summaries, and immediate recompaction loops.

5. **Debuggability**
   - `/context` should explain token contributors, thresholds, compact status, session memory, artifact counts, and provider/model limits.

### 1.2 Provider goals

Provider support should move from env-flag branching to a capability-based resolver:

```txt
selected model/provider
-> provider profile
-> auth resolution
-> provider capabilities
-> transport adapter
-> request builder
-> stream parser
```

Rules:

- Existing env users must keep working.
- Existing Codex OAuth behavior must keep working.
- Resolver must not mutate `process.env`.
- Project config must not store API keys by default.
- Unknown provider/model must fail closed.
- Provider-specific hacks should not accumulate in `src/utils/model/model.ts`.

---

## 2. Non-goals

Do not do these in the first implementation wave:

- Rewrite the whole query loop.
- Rewrite the TUI.
- Build a vector database.
- Adopt OpenCode's Effect architecture.
- Dynamically install provider SDK packages inside core CLI.
- Remove current Anthropic SDK facade before transports are stable.
- Remove current env compatibility.
- Force provider JSON mode for summaries.
- Make native/server-side compaction required.
- Store provider secrets in project config.
- Hard-code OpenCode Go base URL without source proof.
- Treat `CONTEXT_COLLAPSE` as working recovery if it is still pass-through/no-op.

---

## 3. Repo source map to inspect before implementation

### Related planning files and security preflight

`DEV_PLAN.md` may not be the only untracked planning file. During audit, also inventory `UPGRADE_PLAN.md` if present and report its git state.

Current known concern from `UPGRADE_PLAN.md`:

- It describes a critical `which.ts` / `windowsPaths.ts` command-injection fix.
- Security fixes should not be blocked by compaction/provider work.
- The auditor should recommend whether that security fix ships before PR A or as a separate urgent PR.
- Do not stage, commit, delete, clean, or modify `UPGRADE_PLAN.md` during audit unless explicitly authorized.

This plan remains focused on provider/context compaction, but security preflight can supersede sequencing when there is confirmed critical risk.

### Query and compaction integration

```txt
src/query.ts
src/services/compact/autoCompact.ts
src/services/compact/compact.ts
src/services/compact/prompt.ts
src/services/compact/microCompact.ts
src/services/compact/cachedMicrocompact.ts
src/services/compact/cachedMCConfig.ts
src/services/compact/timeBasedMCConfig.ts
src/services/compact/sessionMemoryCompact.ts
src/services/compact/apiMicrocompact.ts
src/services/compact/snipCompact.ts
src/services/compact/snipProjection.ts
src/services/compact/postCompactCleanup.ts
src/services/compact/compactWarningHook.ts
src/services/compact/compactWarningState.ts
src/services/compact/grouping.ts
src/services/contextCollapse/index.ts
src/utils/toolResultStorage.ts
src/utils/analyzeContext.ts
src/utils/redaction.ts
src/utils/sessionStorage.ts
src/services/SessionMemory/sessionMemory.ts
src/services/SessionMemory/sessionMemoryUtils.ts
```

Important observations:

- `src/query.ts` already protects many edge cases: stream ordering, stop hooks, prompt-too-long handling, max-output recovery, token-budget continuation, tool summaries, tool-use/tool-result pairing, and compaction ordering.
- `sessionMemoryCompact.ts` has strong invariant logic for choosing a safe keep-tail boundary.
- `compact.ts` already has a `messagesToKeep` path through `buildPostCompactMessages()`; normal full compact should reuse it rather than invent parallel ordering.
- `snipCompact.ts`, `microCompact.ts`, and `postCompactCleanup.ts` must compose with any new tail-preservation logic; none should re-orphan tool pairs after TailSelector chooses a safe boundary.
- `toolResultStorage.ts` already persists large tool results and freezes replacements by `tool_use_id` for prompt-cache stability.
- `analyzeContext.ts` already powers context analysis; TokenLedger should replace or wrap its consumer surface, not become a parallel estimator.
- `redaction.ts` already exports secret redaction helpers; reuse them for `/context`, artifacts, recall, and provider diagnostics.
- `sessionStorage.ts` defines the real transcript/session layout; artifact paths should reuse this layout instead of inventing a new `.free-code/sessions` tree.

### Existing `/context`

```txt
src/commands/context/context.tsx
src/commands/context/context-noninteractive.ts
```

Important correction:

- `/context` already exists.
- Do **not** add a duplicate command.
- Extend existing command output with TokenLedger/top contributors.

### Provider/API integration

```txt
src/services/api/client.ts
src/services/api/codex-fetch-adapter.ts
src/utils/model/providers.ts
src/utils/model/providerCapabilities.ts
src/utils/model/model.ts
src/utils/model/modelStrings.ts
src/utils/model/modelOptions.ts
src/utils/model/configs.ts
src/utils/model/validateModel.ts
```

Important observations:

- Provider enum is still small and env-driven.
- `client.ts` branches directly for provider behavior.
- `codex-fetch-adapter.ts` already contains valuable Anthropic-shaped -> OpenAI/Codex conversion logic.
- `providerCapabilities.ts` has concepts worth keeping, but adapter IDs must match real dispatch paths. Today, adapter IDs like `vertex-gemini` and `azure-foundry-inference` must be wired or treated as fail-closed before a resolver relies on them.

### Feature audit

```txt
FEATURES.md
```

Known risks to verify:

- `REACTIVE_COMPACT` references missing/unfinished paths unless implemented.
- `CONTEXT_COLLAPSE` may be no-op/pass-through and/or import missing `CtxInspectTool` behind flags.

---

## 4. Critical feedback on prior GPT/Codex plans

Keep these ideas:

- Treat compaction as context packing + recovery, not just a better prompt.
- Make reliability features local-configured, not remote experiment dependent.
- Preserve raw recent tail after normal compact.
- Reuse `sessionMemoryCompact.ts` invariants.
- Add provider resolver/catalog instead of more enum branches.
- Keep existing env compatibility.
- Keep markdown compact fallback when structured JSON fails.
- Verify OpenCode Go endpoint before defaulting it.

Corrections:

1. **`/context` already exists**
   - Extend existing files only:
     - `src/commands/context/context.tsx`
     - `src/commands/context/context-noninteractive.ts`

2. **Broken gates are Phase 0**
   - `REACTIVE_COMPACT` and `CONTEXT_COLLAPSE` must be safe before larger refactors.
   - Default builds may already strip missing modules behind `feature(...)`; the remaining risk is feature-on/dev-full builds or env overrides that reach missing modules.
   - Feature-on unimplemented paths should fail with explicit safe messages, not missing-module crashes.

3. **Tail preservation comes before structured summary**
   - Schema quality cannot recover current tool state if raw tail is discarded.

4. **Artifact recall requires redaction first**
   - Searchable artifact snippets must not expose tokens, cookies, API keys, private keys, or `.env` content.

5. **Provider registry starts small**
   - Wrap existing providers first.
   - Add OpenCode Go after endpoint verification.
   - Do not add every provider in one PR.

6. **`query.ts` extraction is last**
   - It is orchestration-heavy because real edge cases exist.
   - Extract narrow, tested modules first.

7. **Verification must be safe**
   - No blind `bun install`.
   - No real auth store mutation.
   - No real provider/model API calls.
   - No mandatory `build:dev:full` unless scoped.
   - Audit mode means no source/config edits.

---

## 5. Phase 0 — Quarantine broken gates and map current behavior

### Goal

Remove false confidence before adding architecture.

### Tasks

1. Search all references:

```bash
rg "REACTIVE_COMPACT|reactiveCompact|CONTEXT_COLLAPSE|contextCollapse|CtxInspectTool"
rg "feature\\([\"'](REACTIVE_COMPACT|CONTEXT_COLLAPSE)[\"']"
rg "require\\(.+reactiveCompact|import\\(.+reactiveCompact|CtxInspectTool"
```

2. For each match, classify:

```txt
file:
line/pattern:
safe when feature disabled? yes/no
safe when feature enabled? yes/no
module exists? yes/no
test/evidence:
```

3. Make feature-on behavior explicit:

- Default/feature-off builds should continue to strip or avoid missing `src/services/compact/reactiveCompact.js` and `src/tools/CtxInspectTool/CtxInspectTool.js` paths.
- When `REACTIVE_COMPACT` or `CONTEXT_COLLAPSE` is built in but still unimplemented, replace missing-module paths with explicit safe-error stubs that report `flag enabled but unimplemented`.
- If `CONTEXT_COLLAPSE` remains pass-through/no-op, make diagnostics say so rather than presenting it as working recovery.

4. Document existing `/context` behavior.

5. Document current compaction order in `src/query.ts`, including `snipCompact`, `microCompact`, `postCompactCleanup`, warning hooks/state, and any cleanup that runs after compact.

6. Identify dead or unwired provider adapter IDs before resolver work, especially `vertex-gemini` and `azure-foundry-inference`.

### Acceptance

- Normal build does not depend on missing reactive/context-collapse modules.
- Feature-off build path is safe.
- Feature-on/dev-full behavior is either implemented or fails with a clear safe error, classified against `FEATURES.md`.
- `/context` still works.
- Normal chat behavior unchanged.
- `CONTEXT_COLLAPSE` is not presented as working if still pass-through/no-op.
- Baseline report includes current compact order and all compact cleanup/warning/snipping steps.

### Tests/evidence

- Search output reviewed.
- Build passes in normal mode.
- Any feature-on failure is explicit and intentional.

---

## 6. Phase 1 — Local compaction config + TokenLedger diagnostics

### Goal

Make current context behavior observable and locally tunable.

### Add

```txt
src/services/context/compactionConfig.ts
src/services/context/TokenLedger.ts
```

### Extend existing

```txt
src/commands/context/context.tsx
src/commands/context/context-noninteractive.ts
```

### Do not add

- Duplicate `/context` command.
- Remote feature flags for reliability defaults.
- Provider-specific hacks in the context command.

### Config shape

```ts
export const DEFAULT_COMPACTION_CONFIG = {
  enabled: true,
  auto: {
    enabled: true,
    thresholdPct: 0.78,
    hardBlockPct: 0.95,
    reserveOutputTokens: 20_000,
    maxConsecutiveFailures: 3,
    maxImmediateRefills: 3,
  },
  toolResultBudget: {
    enabled: true,
    perMessageChars: 120_000,
    previewBytes: 2_000,
  },
  timeBasedMicrocompact: {
    enabled: true,
    gapThresholdMinutes: 60,
    keepRecent: 5,
  },
  cachedMicrocompact: {
    enabled: "provider-capability",
    triggerToolResults: 12,
    keepRecent: 3,
  },
  sessionMemory: {
    enabled: true,
    initAfterTokens: 20_000,
    updateAfterTokens: 8_000,
    updateAfterToolCalls: 4,
    waitForExtractionBeforeCompactMs: 8_000,
  },
  summary: {
    structured: false,
    verifier: false,
    targetTokens: 8_000,
    emergencyTokens: 4_000,
  },
  tail: {
    minTokens: 12_000,
    targetTokens: 25_000,
    maxTokens: 40_000,
    minTextMessages: 6,
  },
}
```

Notes:

- `summary.structured` defaults to `false` until Phase 6 lands.
- `summary.verifier` defaults to `false` until measured.
- Config should be read-only from the perspective of resolver logic; do not mutate env.

### Existing env compatibility

Keep honoring:

```txt
DISABLE_COMPACT
DISABLE_AUTO_COMPACT
CLAUDE_CODE_AUTO_COMPACT_WINDOW
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
```

### New env aliases

Do **not** introduce a second env namespace casually. Phase 1 should first honor the existing `DISABLE_*` / `CLAUDE_*` knobs. Add `FREE_CODE_*` aliases only if there is no existing knob for the behavior or if the rename is explicitly approved.

Candidate aliases, deferred unless approved:

```txt
FREE_CODE_COMPACT=0|1
FREE_CODE_COMPACT_THRESHOLD_PCT=0.78
FREE_CODE_COMPACT_TAIL_TARGET_TOKENS=25000
FREE_CODE_SESSION_MEMORY=0|1
FREE_CODE_CONTEXT_RECALL=0|1
```

### Suggested precedence

Preserve current env-first behavior:

```txt
1. explicit function/test override
2. explicit CLI/session model or context override
3. existing environment variables
4. approved FREE_CODE_* aliases, if added
5. project/user settings if implemented
6. defaults
```

If both old and new env vars conflict, do not guess. Preserve existing env behavior unless a migration test explicitly proves the new alias should override.

### TokenLedger shape

`TokenLedger` should replace or wrap the existing `analyzeContextUsage` / `/context` analysis surface in `src/utils/analyzeContext.ts`. Do not create a second estimator that drifts from the command output.

```ts
type TokenLedger = {
  modelContextWindow: number
  effectiveWindow: number
  outputReservation: number
  systemPromptTokens: number
  toolSchemaTokens: number
  messageTokens: number
  mediaTokens: number
  toolResultTokens: number
  rawTailTokens: number
  summaryTokens: number
  postCompactAttachmentTokens: number
  estimatedTotalInputTokens: number
  threshold: {
    warn: number
    compact: number
    block: number
  }
  topContributors: Array<{
    kind: "message" | "tool_result" | "tool_schema" | "attachment" | "memory" | "system"
    id?: string
    tokens: number
    description: string
  }>
}
```

### `/context` output

Keep concise and terminal-friendly:

```txt
Provider/model
Context window / effective window
Estimated input tokens
Output reserve
Warn/compact/block thresholds
Top contributors
Last compact boundary
Session memory status
Persisted tool-result count
Post-compact attachment estimate
Compaction config summary
```

### Redaction requirement

`/context` must not print:

```txt
API keys
OAuth tokens
Authorization headers
cookies
private key material
.env secrets
provider auth values
raw huge tool outputs
```

Use fake-secret tests, not manual confidence. Reuse existing helpers from `src/utils/redaction.ts` (`redactSecrets`, `redactSecretValues`) rather than creating a second redaction implementation.

### Tests

- Config parsing.
- Existing env override compatibility.
- Existing env compatibility without requiring new aliases.
- Any approved `FREE_CODE_*` aliases, including conflict precedence.
- TokenLedger with text-only messages.
- TokenLedger with large `tool_result`.
- TokenLedger with image/document blocks.
- Unknown model/provider fallback.
- `/context` before first model call.
- `/context` without prior API usage data.
- Secret redaction in top-contributor descriptions.

---

## 7. Phase 2 — Tail-preserving normal compact

### Goal

Normal auto/manual compact must preserve a raw recent tail, not just summary + attachments.

This is the biggest reliability win.

### Add/extract

```txt
src/services/compact/tailSelector.ts
```

Extract the invariant logic from:

```txt
src/services/compact/sessionMemoryCompact.ts
```

Then make both normal compact and session-memory compact call the shared module. Do not duplicate the same boundary logic under `src/services/context/`.

### API

```ts
selectTailForCompaction(messages, config, tokenCounter): {
  prefixToSummarize: Message[]
  tailToKeep: Message[]
  startIndex: number
  reasons: string[]
}
```

### Required invariants

Tail selection must not:

- split assistant `tool_use` from user `tool_result`,
- split parallel tool calls from their results,
- split same assistant `message.id` fragments,
- drop thinking blocks required by provider/API invariants,
- start retained history with invalid assistant/tool result sequence,
- preserve stale compact boundaries that trigger immediate prune/recompact,
- leave orphan recent tool results unless repaired/summarized safely.

### Modify normal compact

Change ordinary `compactConversation()` output from summary-only to:

```txt
boundaryMarker
summaryMessages
messagesToKeep
attachments
hookResults
```

Use existing `buildPostCompactMessages(..., messagesToKeep)` path. Do not build a second post-compact ordering path.

### Pipeline composition

Tail preservation must compose with the existing pipeline:

```txt
tool-result budget
snipCompact / snipProjection
microCompact
postCompactCleanup
normal compact tail selection
```

If snip/microcompact can run before or after tail selection in a given path, add a fixture proving the combined pipeline still does not split tool pairs or same-message-id assistant fragments. Also verify `toolResultStorage.ts` frozen replacement decisions remain stable after compact.

OpenAI/Codex-specific risk: `codex-fetch-adapter.ts` keeps `reasoningItemsByToolCallId` in a process-local in-memory map. Split this into two cases: within-session compact must not orphan raw recent `function_call_output` items whose paired reasoning/tool-call state is still cached; resume/cold-cache behavior is a separate concern and should not be conflated with tail compaction.

### Token fallback order

If post-compact context is too large:

1. shrink raw tail from target toward min,
2. shrink post-compact attachments,
3. emergency compact,
4. show TokenLedger contributors and fail clearly.

### Fixture cases

Create tests for:

```txt
plain text chat
assistant tool_use + user tool_result
parallel tool_use blocks + multi-result user message
assistant fragments with same message.id
thinking fragment + tool_use fragment + text fragment
interrupted/orphaned tool result
existing compact boundary inside candidate tail
tail target too large, must shrink toward min
snip + microcompact + normal compact in one run
prompt-cache/toolResultStorage replacement stability after compact
Codex/OpenAI Responses within-session reasoningItemsByToolCallId across compact boundary
resume/cold-cache Codex reasoning behavior documented separately
```

### Acceptance

- Tool pairs not split.
- Parallel tool calls not split.
- Same `message.id` assistant fragments not split.
- Normal compact summarizes only prefix.
- Raw recent tail survives.
- Post-compact estimated tokens lower than pre-compact for normal fixtures.
- No immediate autocompact on next normal fixture turn.

---

## 8. Phase 3 — Total post-compact attachment budget

### Goal

Stop restored attachments from eating the entire window after compact.

### Existing state

`compact.ts` already has per-file and per-skill caps. Total budget is incomplete across all restored context categories.

### Budget categories

Apply one total post-compact attachment budget across:

```txt
restored files
skills
plan attachment
plan-mode reminder
MCP instructions
deferred tools
agent listings
async agent state
hook outputs
```

### Priority order

1. Current active plan/task state.
2. Recent changed/read file state.
3. Required plan-mode reminder/instructions.
4. Invoked skills relevant to current turn.
5. MCP instructions needed for active tools.
6. Deferred tools/agent listings.
7. Async agent state.
8. Hook outputs.

### Rules

- Existing per-file and per-skill budgets remain.
- Huge MCP/deferred-tool text is capped.
- Hook outputs are capped and marked truncated.
- Plan/current task state must not be silently removed.
- If required plan/plan-mode content alone exceeds budget, fail clearly or summarize with an explicit truncation marker; do not silently drop plan-mode behavior.
- `/context` should show attachment contributors.

### Tests

- Huge MCP instruction fixture.
- Huge deferred tool list fixture.
- Huge hook output fixture.
- Plan-mode fixture that proves required plan-mode behavior remains.
- Fixture where active plan/plan-mode content exceeds the attachment budget.
- Immediate-recompact fixture.

### Acceptance

- Post-compact pack remains under threshold for large attachment fixtures.
- No immediate recompact after normal-size compaction.
- `/context` identifies attachment token contributors.

---

## 9. Phase 4 — Provider registry and auth-store skeleton

### Goal

Prepare provider expansion without breaking current users.

### Add

```txt
src/services/provider/types.ts
src/services/provider/authStore.ts
src/services/provider/providerCatalog.ts
src/services/provider/providerProfiles.ts
src/services/provider/providerResolver.ts
```

### Initial scope

- Wrap existing providers only.
- Do not remove existing env paths.
- Do not move all transports yet.
- Do not replace `client.ts` routing in the first provider PR; build a resolver facade that can be compared against current routing first.
- Do not add a large provider marketplace.
- Do not mutate `process.env`.
- Enumerate current `process.env` reads/writes touched by provider resolution before changing precedence.

### ProviderTransport

Phase 4 should expose only transports that are actually wired. Do not put non-transports such as `not_implemented` in the transport enum.

```ts
export type ProviderTransport =
  | "anthropic_messages"
  | "openai_responses"
  | "chatgpt_codex"
  | "bedrock_converse"
```

Unwired adapters should be represented by resolver failure, not fake transports:

```ts
type ProviderResolution =
  | { ok: true; runtime: ResolvedModelRuntime }
  | { ok: false; reason: "unknown_provider" | "unknown_model" | "not_implemented" | "unsupported_capability" | "missing_auth" | "missing_base_url" }
```

Use `unsupported_capability` when a configured model/provider exists but cannot satisfy the requested operation, such as tool use, images, PDF, structured output, or cache edits.

Do not route models to `vertex_gemini`, `azure_foundry_inference`, or `openai_chat_completions` until real transports exist. Existing `providerCapabilities.ts` adapter IDs for `vertex-gemini` and `azure-foundry-inference` must be wired or made fail-closed before the resolver relies on them.

### ProviderAuth

```ts
export type ProviderAuth =
  | { type: "none" }
  | {
      type: "api"
      key: string
      header?: string
      scheme?: "bearer" | "raw"
      metadata?: Record<string, string>
    }
  | {
      type: "oauth"
      access: string
      refresh?: string
      expires?: number
      accountId?: string
    }
```

Do not encode migration state like `refreshOwner` inside stored auth data. Keep Codex OAuth refresh ownership in the existing `getFreshCodexOAuthTokens` path until a resolver implementation proves equivalent behavior.

Defer a `wellknown` auth variant until a concrete provider flow needs it. If added later, define the exact URL/command/token semantics and safety constraints in that phase.

### ProviderCapabilities

```ts
export type ProviderCapabilities = {
  transport: ProviderTransport
  supportsTools: boolean
  supportsParallelTools: boolean
  supportsStreaming: boolean
  supportsImages: boolean
  supportsPdf: boolean
  supportsReasoning: boolean
  supportsReasoningEffort: boolean
  supportsStructuredOutputs: boolean
  supportsPromptCaching: boolean
  supportsNativeCompaction: boolean
  supportsCacheEdits: boolean
  supportsTokenCounting: boolean
  requiresStrictJsonSchema: boolean
  requiresAlternatingRoles: boolean
  acceptsToolResultBlocks: boolean
  maxContextTokens: number
  maxOutputTokens: number
}
```

### Resolver precedence

```txt
1. explicit CLI/session model override
2. environment variables
3. project config
4. user provider profile
5. auth store
6. provider default
```

Environment variables must stay above config/profile defaults to preserve current behavior, including `OPENAI_API_KEY` winning over Codex OAuth when both are present.

### Compatibility env vars

Keep these working:

```txt
CLAUDE_CODE_USE_OPENAI
OPENAI_API_KEY
OPENAI_MODEL
OPENAI_BASE_URL
ANTHROPIC_API_KEY
ANTHROPIC_MODEL
CLAUDE_CODE_USE_BEDROCK
CLAUDE_CODE_USE_VERTEX
CLAUDE_CODE_USE_FOUNDRY
```

### Auth store

Default target:

```txt
${XDG_DATA_HOME:-~/.local/share}/free-code/auth.json
```

Rules:

- Preserve existing auth paths during migration; do not silently move a user's current Codex/OAuth credentials.
- File mode `0600` is required on POSIX and best-effort/OS-conditional elsewhere.
- Store secrets only in auth store/secure storage, not project config.
- Project config stores `authRef`, not key material.
- Logs/errors redact auth values.
- Tests use temp dirs/mocks, not the real auth store.
- Codex OAuth refresh ownership must stay with the existing `getFreshCodexOAuthTokens` path until a resolver test proves equivalent behavior.

### Unknown provider fail-closed

Unknown provider/model must not assume:

```txt
tools
parallel tools
images
PDF
JSON mode
reasoning
cache edits
native compaction
large context
large output
```

### Tests

- Anthropic default resolution.
- `ANTHROPIC_API_KEY` resolution.
- `CLAUDE_CODE_USE_OPENAI=1 OPENAI_API_KEY=...` resolution through the same OpenAI Responses adapter path as today.
- Existing OpenAI Responses/Codex adapter request-construction path.
- Mocked Codex OAuth resolution and refresh ownership.
- `OPENAI_API_KEY` wins over Codex OAuth.
- Bedrock/Vertex/Foundry env routing preserved.
- Unwired adapter IDs (`vertex-gemini`, `azure-foundry-inference`, future `openai_chat_completions`) fail closed until transports land.
- Resolver does not mutate `process.env` and restores any fake env values in tests.
- Auth file mode `0600` on POSIX; best-effort behavior documented elsewhere.
- Project config never stores secrets by default.
- Unknown provider fail-closed fixture.

### Acceptance

- Existing env behavior preserved.
- Existing auth behavior preserved.
- Secret redaction tests pass.
- Provider additions do not require changes in `model.ts` unless unavoidable and justified.
- Resolver output can be compared against current `client.ts` routing for Anthropic, OpenAI API key, Codex OAuth, Bedrock, Vertex, and Foundry before transport code moves.

---

## 10. Phase 5 — OpenCode Go provider auth

### Goal

Add OpenCode Go as a normal API-key provider.

### Known facts

- Docs/user-provided flow says API key is created at `https://opencode.ai/auth`.
- Exact API base URL and protocol must be verified before setting a default.

### Required endpoint verification before default

Report:

```txt
Exact source URL/file:
Base URL:
Protocol: OpenAI chat / OpenAI responses / other
Models endpoint:
Auth header:
Special headers:
Free/public vs paid model metadata:
```

If not verified, require explicit config/env:

```txt
FREE_CODE_OPENCODE_GO_BASE_URL
OPENCODE_BASE_URL
```

If verification proves OpenCode Go uses OpenAI Chat Completions, add `openai_chat_completions` transport in this phase with tests. Do not list it as supported in Phase 4 before a transport exists.

### Provider ID

```txt
opencode-go
```

### Env aliases

```txt
OPENCODE_API_KEY
OPENCODE_GO_API_KEY
FREE_CODE_OPENCODE_GO_API_KEY
OPENCODE_BASE_URL
FREE_CODE_OPENCODE_GO_BASE_URL
```

### Commands

First verify whether a `/provider` slash-command namespace already exists. If not, add the command namespace in this phase and keep it minimal.

```txt
/provider login opencode-go
/provider logout opencode-go
/provider list
/provider use opencode-go/<model>
```

### Login copy

```txt
Create an API key at https://opencode.ai/auth, then paste it here.
```

### Stored auth shape

```json
{
  "opencode-go": {
    "type": "api",
    "key": "..."
  }
}
```

### Public fallback rule

- Do not silently use `"public"` for paid models.
- Use public fallback only if model catalog explicitly marks model as unauthenticated/free.
- Paid model without key must fail clearly.

### Tests

- Env key overrides stored key.
- Stored key loaded from temp auth store.
- Logout removes only temp stored key in tests.
- Missing key error for paid models.
- Missing base URL error if no verified default.
- Public fallback only for explicitly safe model metadata.
- `OPENCODE_API_KEY=public` + paid model fails clearly.
- No real network/model calls.

### Acceptance

- OpenCode Go can be configured without touching real auth store.
- No guessed base URL is hard-coded.
- No paid model uses `public` fallback.

---

## 11. Phase 6 — Structured compact summary

### Goal

Make compact summaries checkable and repeatable while keeping markdown fallback.

### Add

```txt
src/services/context/summary/CompactSummarySchema.ts
src/services/context/summary/generateCompactSummary.ts
src/services/context/summary/repairCompactSummary.ts
src/services/context/summary/renderCompactSummary.ts
```

### Schema

```ts
export const CompactSummarySchema = z.object({
  schemaVersion: z.literal(1),
  sourceRange: z.object({
    startUuid: z.string(),
    endUuid: z.string(),
    transcriptPath: z.string().optional(),
  }),
  primaryRequest: z.string(),
  activeTask: z.string(),
  hardConstraints: z.array(z.string()),
  userPreferences: z.array(z.string()),
  files: z.array(z.object({
    path: z.string(),
    role: z.enum(["read", "modified", "created", "deleted", "mentioned", "test", "config"]),
    facts: z.array(z.string()),
    latestKnownState: z.string().optional(),
  })),
  commands: z.array(z.object({
    command: z.string(),
    cwd: z.string().optional(),
    outcome: z.string(),
    importantOutput: z.string().optional(),
  })),
  errors: z.array(z.object({
    symptom: z.string(),
    cause: z.string().optional(),
    fixAttempted: z.string().optional(),
    status: z.enum(["resolved", "unresolved", "unknown"]),
  })),
  decisions: z.array(z.object({
    decision: z.string(),
    rationale: z.string().optional(),
  })),
  tests: z.array(z.object({
    command: z.string(),
    result: z.enum(["pass", "fail", "not_run", "partial", "unknown"]),
    notes: z.string().optional(),
  })),
  plan: z.array(z.object({
    item: z.string(),
    status: z.enum(["todo", "doing", "done", "blocked"]),
  })),
  nextAction: z.string(),
  artifactRefs: z.array(z.object({
    kind: z.string(),
    id: z.string(),
    path: z.string().optional(),
    summary: z.string(),
  })),
  doNotForget: z.array(z.string()),
})
```

### Emergency/MVP schema

The full schema is for normal compact only. Emergency compact should use a minimal variant that fits the emergency target:

```ts
{
  schemaVersion: 1,
  activeTask: string,
  hardConstraints: string[],
  changedFiles: string[],
  failingTests: string[],
  nextAction: string,
  artifactRefs: Array<{ id: string; summary: string }>
}
```

If the structured schema itself risks exceeding the emergency target, fall back to the existing markdown emergency prompt.

### Generation strategy

1. Ask for plain text JSON only.
2. Parse with Zod.
3. Repair once if parse/validation fails.
4. Fall back to existing markdown prompt if repair fails.
5. Render structured state into the existing compact summary message.
6. Do not require provider JSON mode.

### Verifier

Optional and off by default until measured.

Run only when:

- not emergency,
- token budget remains,
- provider/model is capable enough,
- config allows it.

Verifier prompt intent:

```txt
Given the compacted prefix and generated summary JSON, identify missing critical details:
file paths, tool results, failing tests, user constraints, active task, next action.
If missing, return corrected JSON; otherwise return same JSON.
```

### Tests

Golden transcript includes:

```txt
hard user constraint
exact file path
modified file
command run
failing test output
unresolved bug/error
active plan
next action
```

Assert schema captures all critical facts.

Also test:

- invalid JSON repaired once,
- invalid repair falls back to markdown,
- emergency compact uses shorter MVP schema or falls back to markdown,
- schema too large for emergency target falls back safely,
- summary inflation detected,
- provider JSON mode not required.

### Acceptance

- Structured summary is off by default until tests pass.
- Markdown fallback still works.
- Summary is not the only recoverability layer.

---

## 12. Phase 7 — Artifact index and ContextRecallTool

### Goal

Make old compacted details recoverable without dumping huge data into context.

### Prerequisite

Redaction utilities and snippet caps are implemented and tested. Reuse `toolResultStorage.ts` persistence and session metadata where possible; do not create a second independent tool-result persistence system.

### Add

```txt
src/services/context/ArtifactIndex.ts
src/tools/ContextRecallTool/
```

### Index path

Reuse the existing session-storage layout from `src/utils/sessionStorage.ts`. Do not invent a parallel `.free-code/sessions/` tree. A candidate path should be derived from the active transcript/session directory, for example:

```txt
<existing-session-dir>/<session-id>/artifacts/index.jsonl
```

The exact path must be verified against current session storage helpers before implementation.

### Artifact records

```ts
type ContextArtifactRef =
  | {
      kind: "tool_result"
      id: string
      toolUseId: string
      toolName: string
      path: string
      sha256: string
      bytes: number
      preview: string
      createdAt: string
    }
  | {
      kind: "transcript_range"
      id: string
      startUuid: string
      endUuid: string
      path: string
      createdAt: string
    }
  | {
      kind: "summary"
      id: string
      compactId: string
      path: string
      createdAt: string
    }
  | {
      kind: "checkpoint"
      id: string
      compactId: string
      path: string
      createdAt: string
    }
```

### Tool input

```ts
{
  query?: string
  filePath?: string
  toolName?: string
  kind?: "tool_result" | "transcript" | "summary" | "checkpoint"
  limit?: number
}
```

### Search

Start simple:

```txt
exact path match
exact text match
substring/fuzzy text match
tool name/kind filters
rank exact path > exact text > fuzzy
```

No vector DB in first version.

### Output rules

- Return snippets and artifact IDs.
- Do not return full huge files.
- Redact secret-looking content.
- Cap snippet count and bytes.
- Missing/deleted artifact files do not crash.
- Corrupt or partially-written `index.jsonl` lines are skipped with diagnostics, not fatal errors.

### Fake-secret fixtures

Use inline/temp fixtures, not real `.env` files:

```txt
Authorization: Bearer fake-token
sk-test_fake_openai_key
ghp_fakegithubtoken
Cookie: session=fakecookie
OPENAI_API_KEY=fake
ANTHROPIC_API_KEY=fake
-----BEGIN PRIVATE KEY-----
```

Assert fake secrets are redacted in:

```txt
/context output
TokenLedger contributor descriptions
artifact previews
recall snippets
logs/errors generated by new code
provider resolver diagnostics
```

### Acceptance

- Persisted tool output can be recalled by text query.
- Summary includes artifact refs.
- Recall output is capped.
- Fake secrets do not appear in snapshots except as input fixtures.

---

## 13. Phase 8 — Reactive compact

### Goal

Complete the currently referenced recovery path for prompt-too-long/media-too-large failures.

### Add

```txt
src/services/compact/reactiveCompact.ts
```

### Expected API

```ts
tryReactiveCompact({
  hasAttempted,
  querySource,
  aborted,
  messages,
  cacheSafeParams,
}): Promise<CompactionResult | null>

isReactiveCompactEnabled(): boolean
isWithheldPromptTooLong(message): boolean
isWithheldMediaSizeError(message): boolean
isReactiveOnlyMode(): boolean
reactiveCompactOnPromptTooLong(
  messages,
  cacheSafeParams,
  options,
): Promise<{ ok: true; result: CompactionResult } | { ok: false; reason: string }>
```

Match exactly what `src/query.ts` and `src/commands/compact/compact.ts` expect. Before implementation, enumerate call sites in `query.ts` and `commands/compact/compact.ts` with file:line and verify option/result shapes.

### Behavior

```txt
if already attempted -> null
if querySource is compact/session_memory -> null
if aborted -> null
if prompt-too-long/media-size error:
  strip old image/document blocks safely
  force old tool-result offload
  apply time-based microcompact if safe
  run emergency tail-preserving compact
  retry once through existing query loop
if second failure:
  surface original error + TokenLedger contributors
```

### Rules

- No infinite retry.
- No compact recursion for compact/session_memory query sources.
- Do not invoke stop hooks on invalid API-error continuation.
- Preserve recent user media when likely relevant.
- Use emergency mode; do not try to restore every attachment.

### Tests

- Synthetic prompt-too-long assistant/API error.
- Synthetic media-size error.
- Failure after retry.
- Aborted signal.
- compact/session_memory guard.
- Stop-hook non-invocation on invalid continuation.

### Acceptance

- Reactive compact triggers once.
- Second failure surfaces diagnostics.
- No missing-module import risk remains.

---

## 14. Phase 9 — Provider-aware ContextManager extraction

### Goal

Move context packing behind a provider-aware facade only after earlier pieces are stable.

This phase is optional. Re-evaluate after Phase 8; if earlier phases already provide reliable behavior, defer this refactor indefinitely rather than moving code for cosmetic architecture.

Evaluation result: defer. Phases 1–8 now provide local config, token ledger, tail-preserving compact, post-compact budgets, provider resolver/OpenCode Go, structured summaries, artifact recall, and reactive recovery without needing a ContextManager rewrite. Extracting it now would mostly move risk into `query.ts` ordering and stream/tool/stop-hook behavior.

### Add

```txt
src/services/context/ContextManager.ts
src/services/context/ContextPack.ts
```

### Initial responsibility

Wrap current order; do not replace the whole agent loop.

Preserve:

```txt
tool-result budget
snip
microcompact
context collapse if implemented
autocompact
model call
reactive compact on real overflow/error
```

### ContextPack shape

```ts
type ContextPack = {
  id: string
  providerId: string
  modelId: string
  reason: "normal" | "manual" | "auto" | "reactive" | "resume"
  messages: Message[]
  sourceMessages: {
    startUuid?: string
    endUuid?: string
    compactBoundaryUuid?: string
  }
  summary?: CompactSummary
  artifacts: ContextArtifactRef[]
  tokenLedger: TokenLedger
  warnings: ContextWarning[]
}
```

### Provider-aware decisions

- `supportsCacheEdits`: allow cached microcompact.
- `supportsNativeCompaction`: optional native compaction.
- `requiresAlternatingRoles`: coalesce/repair before send.
- `supportsTools=false`: convert tool blocks to text in summary-only paths.
- `maxOutputTokens` small: reduce summary target.
- local providers: skip cloud-cache-only optimizations.
- unknown providers: fail closed.

### Tests

- Anthropic path unchanged.
- OpenAI Responses function/tool output continuity.
- OpenAI-compatible role alternation.
- Provider without tools can still summarize.
- Local provider path avoids cloud-cache overhead.
- Unknown provider fail-closed.

### Acceptance

- `query.ts` is smaller only by extracting tested context-prep pieces.
- Stream/tool/stop-hook behavior unchanged.
- Provider capabilities influence packing, not broad behavior rewrites.

---

## 15. Cleanup and de-risking phase

Do this after functionality lands:

- Remove or quarantine false feature gates.
- Keep `CONTEXT_COLLAPSE` disabled/stubbed until truly implemented.
- Replace GrowthBook-only defaults for core reliability with local config.
- Remove dead provider capability records or wire them correctly.
- Keep old env compatibility until migration tests pass.
- Avoid another monolithic OpenAI shim if smaller transport modules work.
- Avoid vague comments; document concrete invariants only.

---

## 16. Global edge cases to guard forever

### Compaction correctness

- Do not split `tool_use` / `tool_result`.
- Do not split parallel tool calls from their results.
- Do not split same assistant `message.id` fragments.
- Do not lose thinking blocks required by provider/API invariants.
- Do not start retained history with invalid assistant/tool result sequence.
- Do not summarize current user request incorrectly.
- Do not lose exact file paths.
- Do not lose failing test commands/output.
- Do not lose hard user constraints.
- Do not lose current task/plan/todo state.
- Do not lose async agent/task state.
- Do not allow summary inflation.
- Do not immediately recompact next turn.
- Do not break `snipCompact` / `microCompact` / `postCompactCleanup` composition.
- Do not break within-session Codex/OpenAI Responses reasoning-item continuity (`reasoningItemsByToolCallId`); document resume/cold-cache behavior separately.
- Do not duplicate prompt-cache break detection; consult existing prompt-cache stability utilities.

### Provider correctness

- Existing env users must not break.
- Stored keys must not leak to logs/errors.
- Auth file must be `0600`.
- Project config must not store secrets by default.
- OpenAI API key should keep current precedence over Codex OAuth.
- Local models should avoid cloud-cache-specific overhead.
- OpenAI-compatible providers may require strict alternating roles.
- Some providers reject unknown schema fields.
- Some providers reject optional fields in strict tool schemas.
- Some providers do not support tools/images/PDF/reasoning/JSON mode.
- Some providers stream usage only at the end or not at all.

### Artifact recall

- Missing artifact file should not crash.
- Huge artifact should return snippets only.
- Secret-looking content must be redacted.
- Artifact refs should include enough metadata to decide whether to read them.

### OpenCode Go

- Verify base URL before defaulting it.
- Treat as API-key provider.
- Do not use public fallback for paid models.
- Support env key override.
- Support temp auth-store tests.
- Add useful errors for missing key/base URL/model.

---

## 17. Test matrix

### Unit tests

```txt
CompactionConfig
TokenLedger
tailSelector invariants
normalCompact preserves tail
snip/microcompact/tail composition
post-compact attachment budget
CompactSummarySchema parse/repair/render
ArtifactIndex corruption recovery
ContextRecallTool redaction/snippet caps
ProviderAuthStore temp-dir behavior
ProviderResolver precedence
transport message conversion
unknown provider fail-closed
dead/unwired provider adapter IDs fail closed
Codex reasoningItemsByToolCallId within-session compact behavior
Codex reasoning resume/cold-cache behavior documented separately
```

### Integration fixtures

```txt
simple coding task
long Bash output
many Grep/Glob results
parallel tool calls
orphan/interrupted tool call
image/document-heavy chat
session memory present
session memory stale
multiple compactions
resume after compact
provider without tools
provider requiring alternating roles
local OpenAI-compatible provider
huge MCP instructions
huge deferred tool list
huge hook output
active plan larger than attachment budget
snip + microcompact + normal compact in one run
corrupt artifact index
```

### Provider matrix

| Provider type | Required checks |
| --- | --- |
| Anthropic Messages | thinking/tool invariants, cache control |
| OpenAI Responses | function_call/function_call_output continuity |
| ChatGPT Codex | mocked OAuth/account/reasoning behavior unchanged |
| OpenAI-compatible chat | role alternation, strict schema, no orphan tools |
| Bedrock | env routing preserved |
| Vertex | env routing preserved |
| Foundry | env routing preserved |
| OpenCode Go | API-key auth, base URL override, model selection |
| Local OpenAI-compatible | no API key, toolless fallback, fast path |

### Metrics/evals

Track if possible:

```txt
post_compact_task_success
summary_inflation_rate
immediate_recompact_rate
artifact_recall_success
prompt_cache_break_rate
provider_error_rate
auth_failure_rate
manual_resume_success
```

---

## 18. Audit/verification protocol

Use this protocol after any plan, mixed, or implementation branch.

### 18.1 Audit-mode safety rules

Audit mode means observe, classify, and report only. The audit output should be returned in chat by default; do not create `docs/AUDIT-baseline.md` or any other report file unless explicitly approved afterward.

Before sending audit instructions to another agent, remove any ChatGPT-only citation markers or rendered citation glyphs. Do not keep iterating audit wording once these safety rules are satisfied; proceed to the actual audit unless a concrete contradiction affects safety or correctness.

Do not:

- edit source/config files,
- add tests, fixtures, helper files, snapshots, or patches,
- delete, clean, stage, commit, or mutate user files,
- mutate real auth/config stores,
- run real provider/model API calls,
- use real API keys or OAuth tokens,
- inspect, echo, or print real provider credential values,
- run `/provider logout` or auth mutation tests against real stores,
- run plain `bun install` blindly,
- globally override `HOME` for the whole audit,
- claim a failure is unrelated unless proven.

If unsure, classify as `unknown`.

Build/test commands may create artifacts. Report any workspace changes afterward. Do not clean, stage, or commit them without approval.

Never run auth/provider mutation tests against real:

```txt
~/.free-code
~/.claude
~/.codex
~/.config
~/.local/share
```

Use temp HOME/XDG only around auth/provider tests, not the whole build:

```bash
TMP_HOME="$(mktemp -d)"
HOME="$TMP_HOME" \
XDG_CONFIG_HOME="$TMP_HOME/.config" \
XDG_DATA_HOME="$TMP_HOME/.local/share" \
bun test <auth-or-provider-test-file>
```

If free-code exposes project-specific config/auth path env vars, set those to temp paths too for auth/provider tests.

Provider behavior must be verified through:

```txt
resolver tests
request-construction tests
mocked fetch tests
fixture tests
adapter tests
```

No live network/model calls unless explicitly approved.

Use fake scoped env values only. Never echo, inspect, or print real values for:

```txt
OPENAI_API_KEY
ANTHROPIC_API_KEY
CODEX_API_KEY
OPENCODE_API_KEY
GITHUB_TOKEN
GH_TOKEN
Authorization
Cookie
```

If tests mutate `process.env`, verify they restore it afterward.

### 18.2 Branch classification and diff inventory

Run first:

```bash
git status --short
git ls-files --others --exclude-standard
git diff --stat
git diff --name-status
git diff --check
git diff --cached --stat
git diff --cached --name-status
git diff --cached --check
```

Also include exact evidence for the audit reference file when `DEV_PLAN.md` is present:

```bash
git status --short -- DEV_PLAN.md
grep -n "Treat the current working-tree.*DEV_PLAN.md.*audit reference" DEV_PLAN.md || true
grep -n "Audit reference state" DEV_PLAN.md || true
git diff --check -- DEV_PLAN.md
```

If `UPGRADE_PLAN.md` is present, include its state too because it may contain security work that supersedes provider/context sequencing:

```bash
git status --short -- UPGRADE_PLAN.md
grep -n "which.ts\|windowsPaths.ts\|Command Injection\|Security Fixes" UPGRADE_PLAN.md || true
git diff --check -- UPGRADE_PLAN.md
```

If the grep commands do not find the expected audit-reference guard or `Audit reference state:` fields, do not assume they exist. Report that under `Remaining risks` or `Patch proposals, not applied`; do not patch during audit unless explicitly authorized.

Classify the branch as:

```txt
plan/docs only
implementation
mixed docs + implementation
```

Treat the current working-tree `DEV_PLAN.md` as the audit reference if present, but report its git state first. If `DEV_PLAN.md` is untracked, inspect it directly as plan/docs work and state that it is untracked. Do not assume an untracked plan is committed branch state. Do not stage, commit, delete, clean, or modify it during audit.

Important: `git diff` does not show untracked file contents. Inspect likely planning/docs files and small relevant source files directly. Do not dump or read arbitrary huge untracked files; use size/type judgment and report anything skipped.

If `.claude/worktrees/*` contains untracked worktree mirrors, include them in the untracked inventory but exclude them from source greps/diff conclusions by default. They can mirror `src/` and produce duplicate or stale hits. Mark them as `worktree mirror — out of audit scope unless explicitly requested`.

If branch type is `plan/docs only`:

- inspect changed/untracked docs directly,
- verify markdown quality,
- verify phase consistency,
- verify no misleading implementation claims,
- verify no accidental source changes,
- do not run the implementation verification matrix,
- do not run builds unless explicitly requested,
- mark source-code behavior sections as `N/A — docs-only branch`.

If source files changed, continue with the relevant audit sections only. For untouched areas, report `N/A — no source changes in this area`.

Then inspect relevant tracked/staged diffs without dumping huge full diffs into the final answer:

```bash
git diff -- src/query.ts
git diff -- src/services/compact
git diff -- src/services/context
git diff -- src/services/provider
git diff -- src/services/api
git diff -- src/utils/model
git diff -- src/commands/context

git diff --cached -- src/query.ts
git diff --cached -- src/services/compact
git diff --cached -- src/services/context
git diff --cached -- src/services/provider
git diff --cached -- src/services/api
git diff --cached -- src/utils/model
git diff --cached -- src/commands/context
```

Inventory must include:

```txt
Branch type:
Audit reference state:
Related plan file state:
Tracked changed files:
Staged changed files:
Untracked files:
Files mapped to DEV_PLAN phases:
Files not mapped to any phase:
Possible scope creep:
Duplicated existing functionality:
Potential over-engineering:
Untracked mirrors/skipped paths:
```

For every changed file:

```txt
file -> DEV_PLAN phase -> acceptance criterion -> evidence/test
```

### 18.3 Install/build command rules

Do not run plain `bun install`.

Preferred:

```bash
if test -d node_modules; then
  echo "node_modules present; skipping install"
else
  echo "node_modules missing; dependency install needed"
  echo "Do not install unless explicitly approved."
fi
```

If dependency installation is explicitly approved, use:

```bash
bun install --frozen-lockfile
```

Be clear that even `bun install --frozen-lockfile` mutates `node_modules`.

If dependencies are present and branch type is implementation or mixed, run:

```bash
bun run build
```

Run compile only if compile artifacts are expected and dependencies are present:

```bash
bun run compile
```

Run feature-gated builds only if source changes touched feature-gated code or the repo baseline expects them to pass:

```bash
bun run build:dev
bun run build:dev:full
```

If `build:dev:full` fails, classify against `FEATURES.md`, known broken flags, and current baseline before calling it a regression.

For every command report:

```txt
Command:
Result: pass/fail/not-run
Why run/skipped:
Important output:
Failure classification:
  - caused by this diff
  - known pre-existing
  - environment/dependency
  - feature-flag/baseline
  - unknown
```

If the cause cannot be proven safely, say `unknown`, not `unrelated`.

### 18.4 Required final audit report

For untouched areas, write `N/A — no source changes in this area`. For docs-only branches, most source behavior sections should say `N/A — docs-only branch`.

```txt
## Diff inventory

Branch type:
Audit reference state:
Related plan file state:
Tracked changed files:
Staged changed files:
Untracked files:
Files mapped to phases:
Files not mapped to phases:
Scope creep:
Duplicated existing code:
Potential over-engineering:
Untracked mirrors/skipped paths:

## Implemented phases

- Phase X:
  - Files:
  - Acceptance criteria:
  - Evidence:
  - Tests:
  - Known limitations:

## Build/test results

- Command:
  Result:
  Why run/skipped:
  Important output:
  Failure classification:

## Behavior preservation

- Anthropic default:
- Anthropic API key:
- OpenAI env:
- Codex OAuth:
- Bedrock:
- Vertex:
- Foundry:
- /context:
- query.ts order:
- compaction invariants:
- secret redaction:

## Provider checks

- Resolver precedence:
- Unknown provider fail-closed:
- Auth temp-dir safety:
- OpenCode Go endpoint:
- OpenCode Go auth:
- Real network/API calls used? yes/no

## Compaction checks

- Raw tail preserved:
- Tool pairs preserved:
- Same message.id fragments preserved:
- Post-compact attachment budget:
- Immediate recompaction risk:
- Summary fallback:
- Reactive compact:

## Workspace mutations from build/test

- Files changed/created after commands:
- Source/config files edited by audit? yes/no
- Untracked files left untouched? yes/no
- Build artifacts produced:
- Anything staged/committed/deleted? yes/no

## Missing tests

1.
2.
3.

## Remaining risks

1.
2.
3.

## Patch proposals, not applied

Include only if failures or important missing tests were found:
- Minimal patch:
- Files/functions:
- Why this is safe:
- Tests needed:

## Next smallest safe PR

...
```

---

## 19. Phase-specific verification checklist

### Phase 0 verification

- Feature-disabled startup/build safe.
- Missing reactive/context-collapse modules not imported.
- Existing `/context` still works.
- No normal chat behavior changed.

### Phase 1 verification

- Existing env vars still work.
- New env vars work.
- Precedence documented and tested.
- `summary.structured` and `summary.verifier` default false.
- TokenLedger reports all required fields.
- `/context` works before model usage.
- `/context` redacts fake secrets.

### Phase 2 verification

- TailSelector reuses/preserves `sessionMemoryCompact.ts` invariants.
- No tool pair split.
- No parallel tool split.
- No same `message.id` split.
- No invalid assistant-first retained history.
- No stale compact boundary in tail.
- Normal compact order is `boundary -> summary -> tail -> attachments -> hooks`.

### Phase 3 verification

- Total budget covers all post-compact attachment categories.
- Plan/current task and recent files get priority.
- Huge MCP/deferred/hook text capped.
- Plan-mode instructions preserved.
- `/context` shows attachment contributors.

### Phase 4 verification

- Anthropic default and `ANTHROPIC_API_KEY` path preserved.
- OpenAI env path preserved.
- Existing Codex OAuth mocked path preserved.
- `OPENAI_API_KEY` wins over Codex OAuth.
- Bedrock/Vertex/Foundry env paths preserved.
- Resolver does not mutate `process.env`.
- Auth tests use temp dirs.
- Unknown provider fails closed.

### Phase 5 verification

- OpenCode Go endpoint source cited.
- If unverified, base URL required from env/config.
- Env aliases work.
- Env key overrides stored key.
- Public fallback only for explicitly free/unauthenticated-safe model metadata.
- No real network/API calls.

### Phase 6 verification

- Plain JSON summary generation.
- Zod validation.
- One repair attempt.
- Markdown fallback.
- No mandatory provider JSON mode.
- Emergency compact remains short.
- Summary inflation detection exists.

### Phase 7 verification

- No vector DB.
- Simple capped search.
- Missing artifact files do not crash.
- Snippets redacted and size-limited.
- Artifact index metadata complete enough.

### Phase 8 verification

- API shape matches `query.ts`.
- Does not run for compact/session_memory.
- Retries once.
- Strips old media safely.
- Forces tool-result offload before emergency summary.
- Does not loop.
- No stop hooks on invalid API-error continuation.

### Phase 9 verification

- Anthropic path unchanged.
- Existing order preserved.
- Capabilities used only for packing decisions.
- Role repair tested for OpenAI-compatible chat.
- Provider without tools can summarize.
- Local provider avoids cloud-cache overhead.
- Unknown provider fails closed.

---

## 20. Questions for GPT / external verifier

Ask for concrete facts or adversarial review only, not another broad plan.

1. What is the verified OpenCode Go API base URL and protocol?
   - Exact source URL/file?
   - OpenAI Chat Completions, OpenAI Responses, or other?
   - Models endpoint?
   - Auth header?
   - Special headers?

2. What exact metadata marks OpenCode Go models as free/public vs paid?
   - How does OpenCode decide when `apiKey: "public"` is safe?

3. In current free-code, are any feature-gated imports statically bundled even when the feature is off?
   - Focus: `REACTIVE_COMPACT`, `CONTEXT_COLLAPSE`, `CtxInspectTool`.

4. Does `compactConversation()` assume `messagesToKeep` is only for partial/session-memory compact?
   - If yes, what is the smallest safe normal-compact change?

5. Which `providerCapabilities.ts` entries are dead/unreachable from `client.ts` dispatch?
   - Remove, wire, or rename before adding new providers?

6. What redaction utilities already exist and can be reused for `/context`, artifacts, recall, and provider diagnostics?
   - Need exact files/functions.

7. Are there existing tests/fixtures for tool-use/tool-result pairing across compaction?
   - If not, what is the minimal fixture shape matching current message types?

8. Does OpenAI Responses/Codex require preserving exact `tool_call_id`/`call_id` ordering after compaction?
   - What breaks if old tool calls are summarized while recent tool outputs remain raw?

9. What happens to `reasoningItemsByToolCallId` in `codex-fetch-adapter.ts` in two cases?
   - Within-session compact: related tool call is summarized away but later raw tool outputs remain.
   - Resume/cold-cache: process-local reasoning cache is empty on the first call after resume.

10. Does current Codex OAuth refresh handle 401/expiry only at request start or also mid-stream?

11. Are `vertex-gemini` and `azure-foundry-inference` real supported paths today, or dead adapter IDs that must fail closed until wired?

12. What is the smallest provider resolver that wraps current env behavior without moving `client.ts` transport code yet?
   - Ask for migration outline, not implementation rewrite.

13. Which `/context` fields exist today, and which should be added from TokenLedger?

---

## 21. Review checklist per PR

Before merge:

- Current Anthropic/free-code behavior preserved?
- Existing env compatibility preserved?
- Tests cover the claimed failure mode?
- Tool-use/tool-result invariants preserved?
- Same-message-id assistant fragments preserved?
- Secrets redacted from logs, `/context`, artifacts, recall snippets, and provider diagnostics?
- Prompt-cache stability preserved unless intentionally changed?
- Unknown provider capabilities fail closed?
- Diagnostics are useful but concise?
- Summary is not the only copy of old context?
- Code is small enough to review?
- No source/config edits made during audit-only passes?

---

## 22. Recommended PR sequence

### PR A — Gate safety + baseline docs/tests

- Quarantine broken `REACTIVE_COMPACT` / `CONTEXT_COLLAPSE` imports.
- Map existing `/context` behavior.
- Add build/startup guard tests if missing.

### PR B — Local config + TokenLedger `/context`

- Add `compactionConfig.ts`.
- Add `TokenLedger.ts`.
- Extend existing `/context`.
- Add redaction tests with fake secrets.

### PR C — Post-compact attachment budget

- Add total budget across attachments.
- Add huge MCP/deferred/hook/plan-overflow fixtures.
- This can ship before tail preservation because it reduces immediate-recompact risk in the current compact path.
- When PR D adds raw-tail preservation, revisit the budget so final post-compact accounting includes `summary + raw tail + attachments`, not just `summary + attachments`.

### PR D — TailSelector + normal compact raw tail

- Extract shared `src/services/compact/tailSelector.ts` from session-memory invariants.
- Make session-memory compact and normal compact use the shared selector.
- Use `messagesToKeep` in normal compact.
- Add boundary/invariant and snip+microcompact composition fixtures.

### PR E — Provider resolver/auth-store skeleton

- Add provider types/resolver/auth store.
- Wrap current providers only.
- Preserve env behavior.
- Add temp-auth tests.

### PR F — OpenCode Go

- Verify endpoint/protocol first.
- Add API-key auth flow.
- Require explicit base URL if unverified.
- Add env aliases and temp-auth tests.

### PR G — Structured summary

- Add schema/generator/repair/render.
- Keep markdown fallback.
- Keep off by default until tests pass.

### PR H — Artifact index + recall

- Add artifact index.
- Add ContextRecallTool.
- Redaction and snippet caps required.

### PR I — Reactive compact

- Implement missing module.
- Retry once.
- Emergency tail-preserving compact.

### PR J — Provider-aware ContextManager

- Extract context packing last.
- Preserve query order and stream/tool behavior.

---

## 23. Final recommendation

Do not chase the whole architecture in one branch.

Start with:

```txt
Phase 0 -> Phase 1 -> Phase 3 -> Phase 2
```

Phase 3 can ship before Phase 2 because attachment budgeting reduces immediate-recompact risk in the current compact path and is independent of tail selection. Phase 2 remains the headline reliability win.

Then do provider work:

```txt
Phase 4 -> Phase 5
```

Only then add structured summary, artifact recall, reactive compact, and re-evaluate whether ContextManager extraction is still worth doing.

The repo already contains many of the hard pieces. The work is to make them local-configured, provider-aware, testable, redacted, and safe under long sessions.

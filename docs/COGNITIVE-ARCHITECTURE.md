# Cognitive Architecture: Multi-Layer Context Preparation

This document defines the cognitive architecture that governs how agents prepare context before acting. It replaces the previous "mechanical assembly" model (system prompt + raw session + compression) with a **cognitive preparation pipeline** where multiple LLM calls, each with persona-aware prompts, prepare context before the main reasoning call.

---

## 1. Theoretical Foundations

### 1.1 From Cognitive Psychology

**Dual Process Theory (Kahneman, 2011)**. Human cognition operates in two modes: System 1 (fast, automatic, low-effort) and System 2 (slow, deliberate, high-effort). The current agent architecture is all System 1 -- stimulus arrives, context is mechanically assembled, LLM responds. There is no System 2 -- no deliberate "let me think about what I need to know before I respond."

The cognitive architecture introduces System 2 via the **Cognitive Preparation Pipeline**: before the main LLM call, the agent deliberately assesses what context it needs, retrieves it, and reflects on it.

**Working Memory Model (Baddeley, 2000)**. Baddeley's model includes a Central Executive that controls attention and coordinates subsidiary systems, plus an Episodic Buffer that integrates information from different sources into a coherent representation. In the current system, `ContextEngine.buildSystemPrompt()` acts as a passive buffer -- it dumps everything mechanically. The redesign introduces an active Central Executive (the Appraisal phase) that decides what to load, and the Assembly phase acts as the Episodic Buffer.

**Metacognition (Flavell, 1979)**. Metacognition is "thinking about thinking" -- the ability to assess one's own knowledge state and regulate cognitive processes accordingly. Current agents have no metacognitive capability: they cannot assess "do I know enough to answer this?" before responding. The Appraisal phase introduces metacognition: the agent evaluates its own readiness and plans what additional context it needs.

**Levels of Processing (Craik & Lockhart, 1972)**. Deep processing (meaning, connections, implications) produces better memory and understanding than shallow processing (surface features). Current memory retrieval is shallow: keyword matching, substring search, or raw recency. The Reflection phase introduces deep processing: the agent considers patterns, implications, and connections between retrieved information.

**Spreading Activation (Collins & Loftus, 1975)**. In semantic networks, activating one concept activates related concepts. The Association mechanism works like spreading activation: starting from the current stimulus, the agent identifies related concepts, which activate further related concepts, producing a rich context network rather than isolated keyword hits.

**Tulving's Memory Systems (1972, 1985)**. Three distinct memory systems serve different functions:

| Memory System | Maps to Agent Store | Current State | Problem | Proposed |
|---------------|--------------------|--------------------|---------|----------|
| **Episodic** (personal experiences) | Experience (SQLite activity index) | `recall_activity` (list/get by ID) | No semantic search | Persona-directed: "As a backend dev, what's my experience with auth?" |
| **Semantic** (general knowledge) | Knowledge (MEMORY.md + memories.json) | 5 overlapping prompt sections (SOPs, lessons, best practices, long-term knowledge, applicable lessons) | Redundant taxonomy | Single `## Your Knowledge` section; agent-organized, not system-categorized |
| **Procedural** (how to do things) | Identity (ROLE.md) + Skills | Static injection; skills on-demand | Skills and SOPs overlap | ROLE.md defines core behaviors; Skills are external capability packages; SOPs merge into MEMORY.md knowledge |

The current system's treatment of semantic memory is especially problematic: it splits "what the agent knows" across 5 separate prompt sections with a rigid lesson → best-practice → SOP promotion pipeline. In human cognition, there is no such taxonomy -- knowledge is knowledge, organized by the knower into whatever structure makes sense for their work. The redesign lets agents organize MEMORY.md freely.

### 1.2 From Philosophy of Mind

**Intentionality (Brentano, 1874; Husserl, 1901)**. Mental states are always "about" something -- they are directed at objects. The agent's current state (working on task X, idle, blocked on Y) defines what its cognitive processes are "about." Context preparation should be directed by this intentionality: when the agent is working on an auth module task and receives a message, everything is perceived through the lens of "how does this relate to my auth work?"

**Global Workspace Theory (Baars, 1988)**. Consciousness arises from information being broadcast to a "global workspace" where multiple unconscious processes compete for access. Not everything can be conscious at once -- the workspace has limited capacity (analogous to context window limits). The cognitive preparation pipeline is the competition mechanism: multiple information sources (activity history, memories, team context, task state) compete for inclusion in the final context, and the Appraisal phase acts as the selection filter.

**Extended Mind Thesis (Clark & Chalmers, 1998)**. Cognitive processes extend beyond the individual brain into the environment. For agents, tools (recall, search, file read), stored memories, and team knowledge are extensions of the agent's cognitive system. The key insight: using these extensions should be a cognitive act (the agent decides when and how to use them based on its assessment of the situation), not a mechanical one (the system always loads the same context regardless of situation).

**Enactivism (Varela, Thompson & Rosch, 1991)**. Cognition is not passive information processing but active sense-making through interaction with the environment. The agent doesn't merely receive and process stimuli -- it actively constructs its understanding by probing its environment (checking task state, reading files, querying colleagues). Context preparation should support this active construction.

**Phenomenological Perspective (Merleau-Ponty, 1945)**. Experience is always perspectival -- shaped by the perceiver's embodied situation. A backend developer and a project manager perceive the same "auth module error" differently. The cognitive preparation prompts must encode this perspectival difference: the same retrieval query, filtered through different roles, produces different relevant context.

### 1.3 From LLM Principles

**Attention Mechanism**. Transformer attention is query-key-value based: the model attends to tokens that are relevant to the current query. A curated 5,000-token context with high relevance outperforms a mechanically-assembled 50,000-token context with low signal-to-noise ratio. The cognitive preparation pipeline is an external attention mechanism that pre-selects high-relevance information.

**In-Context Learning**. LLMs learn from examples in the prompt. Past experiences presented as structured examples ("Last time I encountered a similar auth issue, I...") are more effective than raw activity logs. The Reflection phase transforms raw retrieved data into structured lessons.

**Chain of Thought**. Breaking reasoning into explicit steps improves accuracy. The multi-phase preparation pipeline IS a chain of thought at the meta level: Appraisal ("what do I need?") -> Retrieval ("let me gather it") -> Reflection ("what does it mean?") -> Response ("now I act").

**Prompt Sensitivity**. Small prompt changes cause large behavioral differences. Persona + state + goal in the prompt significantly affects output quality. This is precisely WHY different mechanisms need different prompts: the same retrieval question asked from a backend developer's perspective vs. a manager's perspective should yield different context selections.

**Context Window Efficiency**. Not all context is equally useful. Relevant context >> irrelevant context. LLM-curated context (selected by the Appraisal phase based on persona and situation) > mechanically assembled context (loaded by fixed rules regardless of situation).

---

## 2. The Cognitive Preparation Pipeline

### 2.1 Architecture Overview

The Cognitive Preparation Pipeline (CPP) runs between triage and main processing. It replaces the current model (mechanical context assembly) with a cognitive model (agent-driven context preparation).

```
Current model:
  Stimulus -> Triage -> buildSystemPrompt() [mechanical] -> LLM call

Proposed model:
  Stimulus -> Triage -> Cognitive Preparation Pipeline -> LLM call
                              |
                              +-- Phase 1: Appraisal (lightweight LLM)
                              +-- Phase 2: Retrieval (directed tool calls)
                              +-- Phase 3: Reflection (lightweight LLM)
                              +-- Phase 4: Assembly (code, no LLM)
```

### 2.2 Cognitive Depth Levels

Not every stimulus requires full cognitive preparation. Following Dual Process Theory, the system operates at four depth levels:

| Level | Name | Phases | When | Extra LLM Calls | Analogy |
|-------|------|--------|------|-----------------|---------|
| D0 | **Reflexive** | None | HEARTBEAT_OK, simple acknowledgment, memory_consolidation | 0 | System 1: automatic |
| D1 | **Reactive** | Appraisal only | Most chats, A2A messages, comments | 0-1 | System 1.5: quick assessment |
| D2 | **Deliberative** | Appraisal + Retrieval + Reflection | New task execution, complex questions, escalations | 2 | System 2: careful thought |
| D3 | **Meta-cognitive** | Full pipeline + post-response evaluation | High-stakes decisions, novel situations, repeated failures | 2-3 | System 2+: thinking about thinking |

The **triage system** (already implemented) determines which depth level to use. The mapping:

| Triage Outcome | Default Depth | Override Conditions |
|----------------|---------------|---------------------|
| `human_chat` (simple question) | D1 | D2 if topic is unfamiliar or crosses session boundary |
| `human_chat` (complex request) | D2 | D3 if high-risk (file edits, deployments) |
| `task_execution` (new task) | D2 | D3 if task involves unfamiliar domain |
| `task_execution` (retry/resume) | D2 | Always D2 -- prior attempt context is critical |
| `a2a_message` | D1 | D2 if coordination requires cross-task context |
| `heartbeat` | D0 | D1 if failed tasks or blockers exist |
| `comment_response` | D1 | D2 if comment references prior context |
| `memory_consolidation` | D0 | Always D0 -- dream cycle has its own prompts |

### 2.3 Phase 1: Appraisal

**Theoretical basis**: Lazarus's Cognitive Appraisal Theory -- we first evaluate the significance and demands of a situation before responding.

**What it does**: A lightweight LLM call that assesses the current situation from the agent's perspective and produces a context preparation plan.

**Key principle**: The prompt is persona-aware and state-aware. Different agents in different states produce different appraisal plans for the same stimulus.

**Prompt template**:

```
You are {agentName}, a {roleDescription}.

Your current state:
- Status: {status}
- Working on: {currentTaskSummary || 'nothing specific'}
- Recent activity: {recentActivityRing, last 3 items}
- Current knowledge gaps: {from last reflection, if any}

A new stimulus has arrived:
- Type: {mailboxItemType}
- From: {senderName} ({senderRole})
- Summary: {itemSummary}
- Content preview: {first 500 chars}

As {agentName}, consider your role, expertise, and current state.

1. RELEVANCE: How does this relate to your current work and expertise?
2. CONTEXT NEEDS: What specific past experience or knowledge do you need?
   (Be specific: task names, file paths, topics, error types, colleague names)
3. TEAM CONTEXT: What do you need to know about what colleagues are doing?
4. CONFIDENCE: Can you respond well with your current context? (high/medium/low)

If confidence is HIGH, explain why and skip further preparation.
If confidence is MEDIUM or LOW, specify exactly what to retrieve.

Respond as JSON:
{
  "confidence": "high" | "medium" | "low",
  "reasoning": "...",
  "retrievalPlan": {
    "activityQueries": ["keyword search strings for activity history"],
    "memoryQueries": ["semantic search strings for memories"],
    "taskIds": ["specific task IDs to check"],
    "fileHints": ["file paths that may be relevant"],
    "teamQueries": ["what to check about colleagues"]
  },
  "reflectionNeeded": true | false,
  "reflectionFocus": "what to reflect on"
}
```

**LLM parameters**: Low cost -- temperature 0.1, max_tokens 512, use the cheapest available model tier.

**Skip condition**: If confidence is "high", skip Phases 2 and 3 -- proceed directly to Assembly with standard context.

### 2.4 Phase 2: Directed Retrieval

**Theoretical basis**: Tulving's encoding specificity principle -- retrieval is most effective when the retrieval cues match the encoding conditions. The Appraisal phase generates retrieval cues that are specific to the agent's current situation, not generic keywords.

**What it does**: Executes the retrieval plan from Phase 1. No LLM call -- this is mechanical execution of the cognitive plan.

**Operations** (driven by `retrievalPlan` from Phase 1):

| Plan Field | Execution | Source |
|------------|-----------|--------|
| `activityQueries` | Search `agent_activities` by `summary` and `keywords` columns | SQLite activity store |
| `memoryQueries` | Semantic search on `memories.json` via vector index; fallback to substring | MemoryStore + VectorIndex |
| `taskIds` | Fetch task details via `taskService.getTask()` | SQLite task store |
| `fileHints` | Note for main LLM call context (not read here -- too expensive) | Passed through |
| `teamQueries` | Check recent A2A messages, colleague status | AgentManager identity context |

**Output**: `RetrievedContext` -- a structured object with categorized results:

```typescript
interface RetrievedContext {
  activities: Array<{ id: string; summary: string; when: string; relevance: string }>;
  memories: Array<{ id: string; content: string; type: string }>;
  taskContext: Array<{ id: string; title: string; status: string; summary: string }>;
  teamContext: Array<{ colleague: string; status: string; recentActivity: string }>;
  fileHints: string[];
}
```

**Budget**: Total retrieved context capped at 4000 tokens. If over budget, prioritize by the Appraisal's ordering (first items are most important).

### 2.5 Phase 3: Reflection

**Theoretical basis**: Schon's Reflective Practice (1983) -- reflection-in-action, where practitioners think about what they're doing while they're doing it. Also Dewey's reflective thought (1933) -- the active, persistent consideration of any belief in light of the grounds that support it.

**What it does**: A lightweight LLM call that processes the retrieved context through the lens of the agent's persona, extracting patterns, lessons, and warnings.

**Key principle**: The same retrieved data, filtered through different agent personas, produces different reflections. A backend developer reflects on code quality and error patterns. A project manager reflects on timeline impacts and team coordination.

**Prompt template**:

```
You are {agentName}, a {roleDescription}.
You are preparing to handle: {stimulus_summary}

Here is what you recalled from your experience:

## Activity History
{retrieved activities, formatted}

## Relevant Knowledge
{retrieved memories, formatted}

## Task Context
{retrieved task details, formatted}

## Team Situation
{retrieved team context, formatted}

From your perspective as {roleDescription}, reflect:

1. PATTERNS: What connects these past experiences to the current situation?
2. LESSONS: What mistakes or successes from the past are directly relevant?
3. CAUTIONS: What assumptions should you be careful about? What might go wrong?
4. KEY CONTEXT: What is the single most important thing to keep in mind?

Be concise. Focus on actionable insight, not summary. Max 200 words.
```

**LLM parameters**: Low cost -- temperature 0.2, max_tokens 512, cheapest model tier.

**Skip condition**: If `reflectionNeeded` is false from Phase 1 (Appraisal determined this is straightforward).

### 2.6 Phase 4: Assembly

**Theoretical basis**: Global Workspace Theory -- the final assembly is the "broadcast" that makes selected information available to the main cognitive process.

**What it does**: No LLM call. Code assembles the prepared context into the system prompt for the main LLM call.

**Assembly structure**:

The system prompt gains three new dynamic sections at §16a-c, replacing `## Relevant Memories` (§16) when CPP is active:

```
## Cognitive Context                          <-- NEW (Phase 1 output)
[Appraisal reasoning -- why this context was selected]

## Retrieved Context                          <-- NEW (Phase 2 output)
[Structured retrieved information from activities, memories, tasks]

## Reflection                                 <-- NEW (Phase 3 output)
[Persona-aware insights, patterns, cautions]
```

These sections replace the following current sections when CPP is active:
- `## Recent Activity Summary` (daily logs) -- replaced by targeted activity retrieval
- `## Relevant Memories` (bulk retrieval) -- replaced by directed memory retrieval

When CPP is at D0 (Reflexive), these sections are absent and the current mechanical assembly is used unchanged.

---

## 3. Persona-Aware Prompt Differentiation

### 3.1 The Core Principle

The same cognitive function (appraisal, retrieval, reflection) uses different prompts depending on the agent's persona and state. This is not cosmetic -- it fundamentally changes what information the agent considers relevant.

### 3.2 How Persona Shapes Each Phase

| Phase | What Persona Affects | Example: Backend Developer | Example: Project Manager |
|-------|---------------------|---------------------------|--------------------------|
| Appraisal | What counts as "relevant context" | Code files, error patterns, test results, dependencies | Timeline, team capacity, stakeholder expectations, risk |
| Retrieval | Which queries are generated | "auth module error", "login.ts", "test failure" | "auth feature timeline", "team blockers", "stakeholder feedback" |
| Reflection | What patterns are extracted | "This is similar to the race condition I fixed last week" | "This delay impacts the sprint goal, need to re-prioritize" |

### 3.3 How State Shapes Each Phase

Agent state creates a cognitive frame that filters all processing:

| State | Cognitive Frame | Effect on Appraisal |
|-------|----------------|---------------------|
| Working on Task X | "Everything through lens of Task X" | Higher confidence for Task X-related stimuli; lower for unrelated |
| Idle | "Open to any stimulus" | Broader retrieval, more exploratory reflection |
| After failure | "What went wrong?" | Retrieval focused on error context; reflection focused on cautions |
| After success | "What worked?" | Retrieval focused on approach; reflection focused on lessons |
| Collaborating with Agent Y | "Joint context matters" | Team queries prioritized; A2A history included |

### 3.4 Prompt Construction Rules

1. **Role description comes from ROLE.md** -- the first paragraph, which captures the agent's identity and expertise. This is NOT the full ROLE.md (that would be too long for preparation prompts).
2. **Current state is computed** -- status, current task, recent activity ring, recent failures/successes.
3. **Preparation prompts are short** -- under 1000 tokens input. They are lightweight by design.
4. **Preparation prompts never include tools** -- Phases 1 and 3 are pure reasoning, no tool use.
5. **Preparation prompts use the cheapest model** -- they don't need the strongest model; pattern recognition and planning are sufficient.

---

## 4. Integration with Existing Systems

### 4.1 Relationship to Triage

Triage (AttentionController) decides WHAT to process. CPP decides HOW to prepare for processing.

```
AttentionController          Cognitive Preparation Pipeline
  |                            |
  +-- What to focus on?        +-- What context do I need?
  +-- Priority ordering        +-- How to retrieve it?
  +-- Preempt/cancel/defer/drop +-- What does it mean for me?
  |                            |
  v                            v
  TriageResult                 PreparedContext
  (processItemId,              (cognitiveContext,
   deferItemIds,                retrievedContext,
   reasoning)                   reflection)
```

The triage `reasoning` (currently stored as `currentCognition`) feeds into the Appraisal phase as part of the agent's current state. This preserves the existing triage investment while extending it.

### 4.2 Relationship to Memory System

CPP changes both HOW memories are accessed and HOW knowledge is organized.

**Retrieval model change:**

| Current | Proposed |
|---------|----------|
| `buildSystemPrompt()` always loads 5 knowledge sections (SOPs, lessons, best practices, long-term, applicable lessons) | `buildSystemPrompt()` loads one `## Your Knowledge` section from MEMORY.md |
| `retrieveRelevantMemories()` does bulk semantic search on every call | Phase 2 does targeted retrieval based on Phase 1's plan |
| Memory retrieval is the same regardless of agent role | Memory retrieval is shaped by persona (via Appraisal queries) |
| `injectActivityToMainSession()` dumps summaries into session | Activity context assembled from indexed store, not session messages |
| Daily logs injected into every prompt (1500 chars) | Daily logs are write-only audit trail; activity index replaces them |

**Knowledge organization change:**

The current system forces a rigid taxonomy on agent knowledge: `lesson` → `best-practice` → `SOP` with separate prompt sections for each. This creates five overlapping prompt sections that waste context window space repeating the same kind of information.

The redesign follows cognitive science: knowledge is knowledge, organized by the knower. MEMORY.md becomes a free-form agent-organized knowledge base with a single `## Your Knowledge` section in the prompt. Skills remain separate -- they are externalized, installable capability packages, architecturally distinct from personal knowledge.

| Old Mechanism | Disposition |
|--------------|-------------|
| `lesson` tag in memories.json | → `insight` tag (simpler name, same function) |
| `best-practice` tag in memories.json | → merged with `insight` (false distinction) |
| `tool-preference` tag in memories.json | → merged with `insight` |
| MEMORY.md `lessons-learned` section | → agent-organized sections (agent decides structure) |
| MEMORY.md `tool-preferences` section | → agent-organized sections |
| MEMORY.md `sops` section | → agent-organized sections |
| `## Lessons from Past Experience` prompt section | → replaced by `## Your Knowledge` (unified) |
| `## Best Practices` prompt section | → eliminated (redundant) |
| `## Your SOPs` prompt section | → eliminated (merged into `## Your Knowledge`) |
| `## Applicable Lessons for This Task` prompt section | → CPP Phase 2 handles task-specific retrieval |
| Skills (`discover_tools`) | → **unchanged** (different mechanism: installable capability packages) |

### 4.3 Relationship to Compression Pipeline

CPP reduces compression pressure by producing thinner, more relevant context:

| Current Problem | How CPP Helps |
|----------------|--------------|
| Sessions bloated with activity injections | Activities retrieved on-demand, not injected |
| 5 overlapping compression mechanisms | With thinner sessions, most never trigger |
| Compression loses high-value information | CPP pre-selects high-value information; compression operates on less important remainder |
| LLM summaries written to daily logs (feedback loop) | `prepareMessages` becomes pure -- no side effects |

### 4.4 Relationship to Store-Index-Assemble Model

CPP is the "Assemble" part of the Store-Index-Assemble model proposed in the fix plan:

| Principle | Implementation |
|-----------|---------------|
| **Store everything indexed** | `agent_activities` with `summary` + `keywords` columns (Tier 0A) |
| **On-demand recall** | Phase 2: Directed Retrieval based on Phase 1's plan |
| **Smart context assembly** | Phase 4: Assembly merges stable context + prepared context |

---

## 5. Cognitive Lifecycle Beyond Single Calls

### 5.1 Post-Response Evaluation (D3 only)

At the Meta-cognitive depth level, after the main LLM call completes, a brief evaluation pass runs:

```
You are {agentName}. You just completed handling: {stimulus_summary}
Your response: {response_summary}

Evaluate:
1. Did you have enough context? What was missing?
2. Did your response match your role's expertise?
3. What should you remember for next time?

Output JSON: { "contextGaps": [...], "lessonsToSave": [...], "confidence": 0-1 }
```

This feeds back into the memory system: `lessonsToSave` are persisted via `memory_save`, and `contextGaps` inform future Appraisal phases (stored as `lastKnowledgeGaps` on the agent).

### 5.2 Dream Cycle Integration

The existing dream cycle (memory consolidation) benefits from CPP's indexed storage:

- **Before**: Dream cycle operates on raw `memories.json` entries, using an LLM to identify duplicates and merge candidates from content alone.
- **After**: Dream cycle can use `summary` and `keywords` from the activity index to identify related entries more accurately, reducing hallucination risk in the consolidation process.

### 5.3 Cross-Session Continuity

CPP solves the "context wall" problem between sessions:

- **Before**: When switching from task execution to chat, the agent loses detailed task context. Only `injectActivityToMainSession()` summaries bridge the gap.
- **After**: Phase 1 (Appraisal) recognizes "I was just working on Task X" from the agent's state. Phase 2 retrieves the relevant activity history. Phase 3 reflects on what was learned. The main call has full context despite being in a different session.

---

## 6. Cost and Latency Analysis

### 6.1 Additional LLM Calls

| Depth | Extra Calls | Est. Input Tokens | Est. Output Tokens | Est. Latency |
|-------|-------------|-------------------|-------------------|-------------|
| D0 | 0 | 0 | 0 | 0ms |
| D1 | 0-1 (Appraisal, often skipped for high-confidence) | ~800 | ~300 | ~500ms |
| D2 | 2 (Appraisal + Reflection) | ~2500 total | ~800 total | ~1500ms |
| D3 | 2-3 (Appraisal + Reflection + Evaluation) | ~3500 total | ~1200 total | ~2000ms |

### 6.2 Cost Justification

The extra preparation cost is justified by:

1. **Reduced main call tokens**: Better-curated context means smaller system prompts. A 50K-token system prompt with 10% relevance is replaced by a 15K-token prompt with 80% relevance.
2. **Fewer tool call iterations**: With better context, the main LLM makes better decisions earlier, reducing the tool loop length.
3. **Reduced compression cost**: Thinner sessions mean the expensive 4-stage compression pipeline rarely activates.
4. **Better first-attempt quality**: Fewer retries, fewer escalations, fewer "I don't have context for this" situations.

### 6.3 Cheap Model for Preparation

Preparation phases use the cheapest available model (e.g., a "simple" tier model in the LLM router). The Appraisal and Reflection tasks are well within the capability of smaller models -- they require pattern recognition and planning, not complex reasoning.

---

## 7. Implementation Mapping

### 7.1 New Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `CognitivePreparation` | `packages/core/src/cognitive.ts` | Orchestrates the 4-phase pipeline |
| `AppraisalPromptBuilder` | `packages/core/src/cognitive.ts` | Builds persona-aware appraisal prompts |
| `ReflectionPromptBuilder` | `packages/core/src/cognitive.ts` | Builds persona-aware reflection prompts |
| `ContextPlan` type | `packages/shared/src/types/cognitive.ts` | Output of Phase 1 |
| `RetrievedContext` type | `packages/shared/src/types/cognitive.ts` | Output of Phase 2 |
| `PreparedContext` type | `packages/shared/src/types/cognitive.ts` | Final output of Phase 4 |

### 7.2 Modified Components

| Component | Change |
|-----------|--------|
| `Agent.handleMessage()` | Call `CognitivePreparation.prepare()` before `buildSystemPrompt()` |
| `Agent._executeTaskInternal()` | Call `CognitivePreparation.prepare()` before first LLM call |
| `ContextEngine.buildSystemPrompt()` | Accept `PreparedContext` param; inject cognitive sections |
| `ContextEngine.prepareMessages()` | Remove `writeDailyLog` side effect; pure function |
| `ContextEngine.retrieveRelevantMemories()` | Becomes the Phase 2 retrieval backend; no longer called from `buildSystemPrompt()` when CPP is active |

### 7.3 Configuration

```typescript
interface CognitiveConfig {
  enabled: boolean;                    // Feature flag for gradual rollout
  defaultDepth: CognitiveDepth;        // D0 | D1 | D2 | D3
  depthOverrides: Record<string, CognitiveDepth>;  // Per-scenario overrides
  appraisalModel?: string;             // Model for Phase 1/3 (defaults to cheapest)
  retrievalBudgetTokens: number;       // Max tokens for Phase 2 output (default: 4000)
  reflectionMaxTokens: number;         // Max output for Phase 3 (default: 512)
  confidenceThreshold: number;         // Appraisal confidence to skip Phase 2/3 (default: 0.8)
}
```

---

## 8. Relationship to Other Documents

| Document | Relationship |
|----------|-------------|
| [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md) | CPP changes how memory stores are accessed (targeted vs bulk). Storage unchanged. |
| [PROMPT-ENGINEERING.md](./PROMPT-ENGINEERING.md) | CPP adds a new LLM call taxonomy category. System prompt gains 3 new sections. |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | CPP adds `CognitivePreparation` as a new core component alongside `ContextEngine`. |
| [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) | Triage output feeds into CPP Phase 1. No changes to mailbox itself. |

---

## 9. Migration Strategy

### Phase A: Foundation (prerequisite)
1. Add `summary` + `keywords` columns to `agent_activities` (Tier 0A from fix plan)
2. Make `prepareMessages` pure -- remove `writeDailyLog` (Tier 0C from fix plan)
3. Reduce activity injection volume (Tier 0B from fix plan)

### Phase B: Core Pipeline
1. Implement `CognitivePreparation` with all 4 phases
2. Wire into `handleMessage` and `_executeTaskInternal` behind feature flag
3. Add `PreparedContext` sections to `buildSystemPrompt`

### Phase C: Refinement
1. Tune depth-level selection heuristics based on production data
2. Optimize preparation prompts based on observed quality
3. Add post-response evaluation (D3)
4. Integrate with dream cycle

### Phase D: Full Rollout
1. Enable by default
2. Remove legacy bulk memory retrieval from `buildSystemPrompt` (when CPP handles it)
3. Simplify compression pipeline (most stages become unnecessary with thinner sessions)

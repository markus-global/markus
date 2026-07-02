---
sidebar_position: 5
---

# Cognitive Architecture

Markus agents use a **Cognitive Preparation Pipeline (CPP)** inspired by Kahneman's dual-process theory (System 1 / System 2). Instead of mechanically assembling the same context for every interaction, agents assess what they need before they respond.

## Dual-Process Foundation

Every stimulus is processed at one of four **cognitive depths**, mirroring Kahneman's model:

| Depth | Name | Process | Analogy | Extra LLM Calls |
|-------|------|---------|---------|:---------------:|
| D0 | **Reflexive** | No preparation | System 1 (automatic) | 0 |
| D1 | **Reactive** | Appraisal only | System 1.5 (quick assessment) | 0–1 |
| D2 | **Deliberative** | Appraisal → Retrieval → Reflection | System 2 (careful thought) | 2 |
| D3 | **Meta-cognitive** | Full pipeline + post-response evaluation | System 2+ (thinking about thinking) | 2–3 |

The triage system determines depth: simple acknowledgments use D0, most chats use D1, task execution uses D2, and high-stakes decisions trigger D3.

## Cognitive Preparation Pipeline

CPP runs between triage and the main LLM call, replacing mechanical context assembly with agent-driven preparation:

- **Phase 1 — Appraisal**: A lightweight, persona-aware LLM call assesses the situation, determines confidence, and produces a retrieval plan.
- **Phase 2 — Directed Retrieval**: Executes the plan against indexed stores (activity history, memories, tasks, team context).
- **Phase 3 — Reflection**: A second lightweight LLM call extracts patterns, lessons, and cautions through the agent's persona lens.
- **Phase 4 — Assembly**: Code merges the prepared context (appraisal reasoning, retrieved data, reflection insights) into the system prompt.

## Context Window Management

CPP improves context quality by reducing quantity. Curated 5,000 tokens with high relevance outperform mechanically-assembled 50,000 tokens with low signal-to-noise ratio. The appraisal phase acts as an external attention mechanism, pre-selecting high-value information before the main call.

## KV-Cache Optimization

The system prompt uses a **3-tier cache architecture** with explicit cache breakpoints:

- **Tier 1 (Stable)**: Role, policies, tool rules, scenario instructions — rarely changes, cached across all calls for the same scenario.
- **Tier 2 (Semi-stable)**: Identity, organization context, workspace info, MEMORY.md — stable within a session.
- **Tier 3 (Dynamic)**: Project context, task board, mailbox state, CPP sections — changes per call, always re-processed.

With CPP active, the cognitive sections (§22a–c) live in Tier 3. The stable Tier 1+2 prefix benefits from provider-side caching (e.g., Anthropic's `ephemeral` cache breakpoint), reducing latency and cost.

## Deeper Reading

- [docs/COGNITIVE-ARCHITECTURE.md](https://github.com/markus-global/markus/blob/main/docs/COGNITIVE-ARCHITECTURE.md) — full theoretical foundations, prompt templates, implementation mapping
- [docs/PROMPT-ENGINEERING.md](https://github.com/markus-global/markus/blob/main/docs/PROMPT-ENGINEERING.md) — LLM call taxonomy, system prompt tiers, compression pipeline

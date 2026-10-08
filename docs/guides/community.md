# Markus Community Guide

Markus's goal is to turn "people who start using it" into "people who stay to build it together." This document is the single source of truth for the community entry point: the channel matrix, how to join, the operating rules, and the launch checklist.

> Status legend: 🟢 Live · 🟡 In progress · 🔵 Planned

---

## 1. Channel Matrix

| Channel | Language | Status | Purpose |
|------|------|------|------|
| [GitHub Discussions](https://github.com/markus-global/markus/discussions) | EN/Chinese | 🟢 | Q&A, Show & Tell, feature discussions, case-study callouts (the official preferred asynchronous channel) |
| [GitHub Issues](https://github.com/markus-global/markus/issues) | EN | 🟢 | Bugs and specific feature requests (including good first issue / help wanted) |
| [Blog](https://markus.global/blog) | EN | 🟢 | Tutorials, release announcements, case stories |
| **Discord** | EN (global) | 🟡 | Real-time chat, contributor collaboration, release announcements — see the launch plan below |
| **WeChat group** | Chinese | 🟡 | Chinese-language user chat, beta feedback, localization collaboration — see the launch plan below |
| X (Twitter) | EN | 🔵 | Product updates, community showcase (the ops team is already working on it) |

**Operating principle**: all channels ultimately feed back into GitHub (discussion conclusions → issues; cases that should be public → blog/docs). Discord/WeChat groups are positioned as "real-time entry points" and do not replace the asynchronously visible GitHub discussions.

---

## 2. Discord (EN / Global) — Launch Plan

**Why Discord**: it is mainstream in open-source AI project communities (e.g. LangChain, LlamaIndex, n8n), and it supports real-time collaboration, bot integration, and GitHub linkage (a GitHub bot is available).

**Target channel structure** (suggested):

```
#welcome           Server rules + role pickup (Contributor / User / Maintainer)
#general           Chit-chat and Q&A
#show-and-tell     Showcasing work
#contributing      Contribution guide, finding collaborators, PR help
#releases         Auto-broadcast of GitHub releases
#core-runtime     In-depth core/org-manager discussion (optional; open later once there is enough activity)
```

**Launch checklist (Markus team internal TODO)**

- [ ] Create the Discord server (suggested first team identity → `markus-global`)
- [ ] Configure server rules and the `welcome` channel (reference our [Code of Conduct](../../CODE_OF_CONDUCT.md))
- [ ] Generate an invite link (set it to never expire) and fill it into the "Invite link" field below
- [ ] Wire up the GitHub notification bot (`Github` webhook / Zappier) to broadcast releases and good-first-issue changes
- [ ] Enable the Discord badge link in the README community section

**Invite link:** `<!-- TODO: once the Discord server is created, fill the invite link in here and reference it in the README -->`

---

## 3. WeChat Group (Chinese) — Launch Plan

**Why invite**: Chinese users and contributors make up a large share, and WeChat groups / official accounts are the most natural entry point for the Chinese community. They also carry Chinese documentation localization, beta feedback, and hands-on support for "turning users into contributors."

**Launch checklist (TODO)**

- [ ] Create the official WeChat group (a maintainer or ops contact creates it; enable "group invite confirmation" to prevent spam)
- [ ] Generate the group QR code → add it to this document and README.zh-CN.md
- [ ] Create the "Markus Assistant" reception script: after joining, guide people to read `CONTRIBUTING.md` and pick up good-first-issues
- [ ] Chinese localization collaboration space: translate `docs/*`, maintain the README, unify the glossary

**WeChat group QR code:** `<!-- TODO: group QR code image (keep it up to date to avoid expiry) -->`

**Join passphrase convention**: when joining, note "Markus + GitHub username" in the request (if they do not have GitHub, guide them to sign up first, paving the way for contributor conversion).

---

## 4. Code of Conduct

The [Code of Conduct](../../CODE_OF_CONDUCT.md) (Contributor Covenant 2.1) applies to all community channels (GitHub, Discord, WeChat groups, blog). Report misconduct to `conduct@markus.global`.

---

## 5. The Path from User to Contributor

| Stage | User action | What we say |
|------|---------|--------|
| Try | Get Markus running, file an issue | README Quick Start → `markus start` |
| Ask | GitHub Discussion / Discord / WeChat | On-duty responder within 48h, distilled into the FAQ |
| Feedback | Bug / feature request | Maintainer confirms → converted into issues + labels |
| **Become a contributor** | Claim a `good first issue` | CONTRIBUTING guide + good-first-issue list; after the first PR is merged, invite them into the Contributor channel/group (Discord role / WeChat group "contributor" note) |
| Deep involvement | Write adapters / docs / tests | After 3+ merged PRs → fast-track their PRs; invite them to join the Maintainers |

**The key conversion point**: the first merge is when retention is highest. Make it explicit in the welcome flow that "you are now a contributor," and give a Role / badge / acknowledgment.

---

## 6. Maintenance Responsibilities

- **Response times**: someone responds to GitHub issues/discussions within 48 hours (automated AI assistant + human rotation); Discord within 2-4h during working hours.
- **Report handling**: `conduct@markus.global` receives → the maintainer team assesses within 48h → handled per the CoC Enforcement Guidelines.
- **Content boundaries**: no ads/soft ads; showcases are encouraged but must show genuine usage.

---

## 7. Milestones

- [x] GitHub Discussions / Issues / Blog live
- [ ] Discord created and connected (clickable in README)
- [ ] WeChat group established (clickable in README.zh-CN)
- [ ] First community case study on the README "Real Teams on Markus"
- [ ] First external contributor PR merged

*Document maintenance: PRs to improve this page are welcome (especially channel links and translations).*

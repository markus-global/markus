# Deliverable Sharing to Hub — Design Proposal

> Author: CTO | Date: 2026-08-12 | Status: Pending review
> Scope: joint work across both ends — the Markus client (desktop) + Markus Hub (cloud)

> **As built:** the client side shipped. `DeliverableShareService` (`packages/core/src/deliverable-share.ts`) plus the
> web-ui wrapper/dialog (`packages/web-ui/src/lib/deliverableShare.ts`, `packages/web-ui/src/components/DeliverableShareModal.tsx`)
> write the §4.1 fields onto `DeliverableRow` (`hubShareId`/`shareStatus`/`shareUrl`/`shareVisibility`, plus a `shareReason`
> field added for rejection reasons) and call `/api/hub/deliverables/publish|status|revoke` (client also adds
> `GET /api/hub/deliverables/mine` via `listMine()`) through the client's **generic** `/api/hub/*` proxy in
> `packages/org-manager/src/api-server.ts`, not a deliverables-specific route. The Hub-side items (§4.2 `DeliverableShare`
> table, R2 object storage, `/deliverable/{slug}` page, sitemap/search, review queue) live in the separate markus.global
> service and are not verifiable from this repo.

---

## 1. Background and Goals

### 1.1 Current state
- A deliverable is the core carrier for the assets an Agent produces — research reports, documents, code, and so on — and currently **exists only on the user's local machine**: the `DeliverableRow` lives in the local SQLite database (`packages/storage`), the file content lives on the local disk, and it is previewed through the built-in browser in the Team Chat right-hand panel.
- The local `DeliverableRow` has a limited set of fields (`id/type/title/summary/reference/format/tags/status/taskId/agentId/projectId/…`) and no sharing-related fields.
- Using `/api/hub/publish` + a Hub token, the client can already publish **assets** such as Agent/Skill/Team to the Hub (`POST {hubUrl}/api/items`), and the Hub already has an asset publishing and review mechanism.
- Deliverables **currently cannot be shared outside the repository / with other users**.

### 1.2 Goals
Let deliverables be shared to the Hub with one click and generate a shareable link, achieving: others can view them through the link, they participate in SEO indexing, they can be searched by Tag/Summary, they are controlled by visibility, and wide public exposure requires review. The Hub displays a deliverable's provenance (user, time, producing Agent) and can trace back to a Hub asset.

### 1.3 Core scenarios
- The user has an Agent produce an industry research report / a valuable asset → one-click public or link sharing.
- Public visibility: visible to everyone, participates in SEO.
- Link visibility: only people who hold the link can see it.
- Wide visibility (public / featured recommendation) goes through Hub review.

---

## 2. Current-state Analysis and Design Boundaries

| Layer | Current state | To be added this time |
|----|------|-----------|
| Client storage | local SQLite `DeliverableRow` | Reserved fields for share status/visibility/share URL |
| Client files | local disk reference | Upload to Hub object storage |
| Client UI | right-panel preview | Share button + confirmation dialog |
| Hub proxy | `/api/hub/publish` (existing) | New `/api/hub/deliverables/*` sharing-related proxy endpoints |
| Hub server | asset items + review | New deliverable type / standalone page / object storage / SEO / search |

**Design boundary**: The Markus Hub server-side asset storage and rendering page are a separate service (markus.global). This proposal defines the **two-sided contract** (API + data model); client changes are implemented in this repository, and the Hub side implements to the contract.

---

## 3. Overall Architecture

```
[Markus client]
  Deliverable (DeliverableRow + local file)
        │  user clicks "Share to Hub"
        ▼
  Share service (new) ── encapsulates: validation / field completion / object upload ──┐
        │ POST /api/hub/deliverables/publish   │ (client goes through the local hub proxy)
        ▼                                      ▼
[Hub server]  ┌→ review queue (wide visibility) → publish on approval
  /api/deliverables/publish
   ├─ metadata written to DB (DeliverableShare table)
   ├─ file written to object storage (R2/S3)
   └─ generate share record + URL
        │
        ▼
[Hub frontend]
  Deliverable public page /o/{slug} (or /deliverable/{id})
  ├─ display: owning user / time / producing Agent / preview / download
  ├─ provenance: if the Agent is a Hub asset → jump to the Agent/Team page; local Agent → show name only
  ├─ participates in /sitemap.xml
  └─ supports /api/search (by Tag / Summary / full text)
```

**Key new concept (introducing a sharing layer)**: one deliverable can have multiple "shares" locally; each share = an independent `DeliverableShare` record (with visibility, status, review, URL), associated with the local `DeliverableRow` through `localDeliverableId`.

---

## 4. Data Model Design

### 4.1 Client: DeliverableRow extension (local SQLite)
New fields (nullable, backward compatible):

| Field | Type | Description |
|------|------|------|
| `hubShareId` | string\|null | Record id of the most recent share on the Hub |
| `shareStatus` | string\|null | `none`/`pending_review`/`published`/`rejected`/`revoked` |
| `shareUrl` | string\|null | Share link (backfilled after publishing) |
| `shareVisibility` | string\|null | `public`/`link` (no private; `none` = not shared) |

### 4.2 Hub side: DeliverableShare table (new)
```
id            string PK       Share record (dlv_share_…)
slug          string UNIQUE   Public-page short link (readable slug)
ownerUserId   string          Hub user id (who shared it)
ownerName     string          Display name
localDeliverableId string     Source (client magic string, used for dedup within the same DB)
title         string
summary       string          Searchable
content       text            Preview content (text, etc.), or an object storage reference
fileRef       string          R2/S3 object key
format        string          markdown/html/text/json/…
tags          string[]        Searchable
visibility    enum            public | link   ← only two shareable visibilities (no private)
status        enum            pending_review | published | rejected | revoked
producerAgentId   string|null  Agent id that produced this deliverable
producerAgentName string       Display name of the producing Agent
producerAgentSource enum|null   hub_asset | local   ← used for provenance jump / name only
createdAt     datetime
publishedAt   datetime|null
reviewedBy    string|null    Reviewer
reviewAt      datetime|null
```

> **No `private`**: <u>sharing is publishing</u> — this mirrors the Hub asset (Agent/Skill/Team) sharing mental model in one loop: not sharing means no record is produced (it stays local); once a share is initiated, visibility can only be `link` or `public` (both require review).

### 4.3 Hub side: object storage (file upload)
- Use **Cloudflare R2** as object storage (**consistent with the existing temporary image storage**, reusing the same object storage and credential system).
- Each deliverable file is stored under the key `deliverables/{ownerUserId}/{shareId}/{filename}`.
- Metadata and files are separated: the DB stores metadata, object storage stores files; previews fetch from object storage in real time (or generate a CDN-cached URL).
- For text-type deliverables (markdown/html/text), in addition to the file, **extract clean content** into the DB for search and SEO.

---

## 5. Visibility and Review Model

| Visibility | Who can see it | Requires review | Participates in SEO |
|--------|--------|----------|----------|
| `link` (visible to whoever holds the link) | Anyone who has the URL (no login required) | **Yes** | **No** (added to the robots blocklist) |
| `public` (public, wide visibility) | All users + search engines | **Yes** | Yes |

> **Sharing is publishing (confirmed)**: not sharing = no record produced (it stays local). Once shared, there are only two visibilities — **`link` / `public`** — and **both go through Hub review**. Default visibility = **`public`**, which the user switches manually in the share dialog. This fully mirrors the Hub asset sharing mental model (Agent/Skill/Team publish → review → public page/link).

**Review mechanism (reusing the Hub's existing review flow)**:
- Reuse the Hub's existing `review/pending/approved/rejected` mechanism for Agent/Skill/Team assets, adding `DeliverableShare` as a reviewable entity type.
- **Both `link` and `public` trigger review**: after submission `status=pending_review`; if the Hub approves → `published` (`public` is added to the sitemap); if not → `rejected` (with a reason, visible on the client and resubmittable).
- Abuse prevention: a review queue + a per-user daily submission cap + content size limits.
- **Ownership (confirmed)**: a share must be bound to a **Hub account** (`ownerUserId` is required); without a Hub account, sharing/publishing is impossible (when not signed in to the Hub, the client disables sharing and prompts the user to sign in).

---

## 6. Frontend Design (client)

### 6.1 Share entry point
- When the Team Chat right-hand panel **previews a deliverable in the built-in browser**, add a "Share" button (with a share icon) to the toolbar at the top of the preview panel.
- Available only when the deliverable's `reference` points to an existing local file.

### 6.2 Confirmation dialog (share wizard)
Clicking "Share" opens a confirmation dialog containing:
1. **Hub login check (prerequisite)**: when not signed in to a Hub account, the dialog directly shows "You must sign in to a Markus Hub account before you can share" and guides the user to sign in (corresponding to the "mandatory Hub account" constraint).
2. **Visibility selection (single choice, default `public`)**: `Public (visible to everyone + search engines)` / `Visible with link`; the user can switch manually.
3. Preview information confirmation: title, summary (editable), Tags (add/remove; recommended to carry over from the deliverable's existing tags).
4. **Hint copy**:
   - Selecting "Public" → show "Public deliverables must pass Hub review before they are published; once published, everyone can see them and they participate in search".
   - Selecting "Visible with link" → show "Only people who obtain the link can view it; it does not participate in search engines; it likewise must pass Hub review".
5. Primary button "Share to Hub" → calls the share API; on success, the preview panel shows the share link + a "Copy link" button + a status badge (under review / published / rejected).

### 6.3 Status feedback
- `pending_review`: show "Under review", button disabled.
- `published`: show a copyable link and allow "Cancel share" (revoke).
- `rejected`: show the reason + "Resubmit".

---

## 7. Server-side / Hub-side API Design

### 7.1 Client → local proxy → Hub (contract)
| Method | Path | Description |
|------|------|------|
| POST | `/api/hub/deliverables/publish` | Upload and publish (body: `{ visibility, title, summary, tags, filename, content?, fileBase64?, producerAgent:{id,name,source} }`, multipart or JSON+base64) |
| GET | `/api/hub/deliverables/status?localId=…` | Query share status |
| POST | `/api/hub/deliverables/revoke` | Cancel a share (public/link → revoked) |
| GET | `/api/hub/deliverables/{id or slug}` | Read for the public page (for Hub frontend/SSR rendering) |

(The client passes through the existing Hub proxy pattern in `packages/org-manager` to avoid CORS.)

### 7.2 Public page (Hub frontend)
Visiting `/deliverable/{slug}` renders:
- Header: title, author (`ownerName` + avatar), share time (`publishedAt`).
- Body: content preview (rich text/text/JSON rendering, depending on format) + a download button (object storage URL).
- **TJ provenance area (CTI)**:
  - `producerAgentSource === 'hub_asset'` and the Agent/team asset exists on the Hub → render "Produced by Agent [link]" / "Owning team [link]", **clickable to jump** to the Hub's Agent/Team asset page.
  - `producerAgentSource === 'local'` → render only the Agent name as text, with no link.
- Tag display (clicking searches for the same Tag).

### 7.3 SEO / Sitemap
- **Only public (`public` and `published`) deliverables enter the search engine index**.
- When the Hub generates `/sitemap.xml`, it includes every `published && public` `DeliverableShare` (URL is `/deliverable/{slug}`).
- The public page enables SSR/static pre-rendering + injection of `meta description` (from summary) + `og:title/og:description` (social share cards).
- `robots.txt`: add `X-Robots-Tag: noindex, nofollow` to the paths where `private`/`link` deliverables live (the link page blocks indexing via a response header).
- Slugs use keyword-containing readable short links (e.g. `industry-report-ai-2026`) to improve SEO.

### 7.4 Search (Hub)
- `/api/search` is extended to support the deliverable type; the searched fields are: `title`, `summary`, `tags`, `content` (full text).
- Index only `published && public` records; `link` records do not enter public search (they are reachable only via URL).
- Provide filtering by Tag + keyword matching on Summary, for a unified experience with the existing asset search (Agent/Skill/Team).

---

## 8. Security and Privacy

- **Credentials**: the share API reuses Hub token authentication; the public page is read-only and requires no login.
- **Link security**: `link` visibility uses an unguessable slug/short id (e.g. `dlv_` + 24 random characters); it does not rely heavily on "the link is the key" for highly sensitive content, but it satisfies the semantics of the "visible with link" scenario.
- **Content compliance**: public requires review; provide a "report" entry point; the sharer can `revoke` at any time.
- **Size limit**: a per-deliverable file cap (50MB suggested); over the limit, prompt for local compression or reject.
- **Ownership**: only the owner (the Hub user corresponding to the Hub token) can revoke/resubmit.

---

## 9. Phased Implementation

**Phase 1 (MVP, usable for self-use/internal beta)**
- Client: share service + preview-panel "Share" + Hub login check + `link`/`public` visibility selection (default `public`) + review-status display.
- Hub: `DeliverableShare` table + object storage (R2) + public page (basic rendering) + **`link`/`public` both go through the review queue (reusing Hub review)**.
- Verify end-to-end "share → pending review → approved → obtain link → someone else opens and views it".

**Phase 2 (publishing + SEO + search)**
- `public` visibility + review queue (reusing Hub review).
- sitemap / SSR / og-meta / noindex control.
- Hub search ingests deliverables (Tag/Summary/full text).

**Phase 3 (operations hardening)**
- Complete provenance links (Agent/Team asset jumps), deliverable collection pages (browse by user / by Tag), reporting/statistics (traffic), CDN cache optimization.

---

## 10. Open Questions / Decisions Needed

> **Confirmed decisions**: (1) **No `private`** — sharing is publishing (reusing the Agent/Skill/Team asset sharing logic; not sharing = no record produced); (2) default visibility = `public` (changeable manually in the dialog); (3) owner requires a Hub account (you cannot publish without a Hub account); (4) object storage = Cloudflare R2 (consistent with the existing temporary images); (5) both `link` and `public` fully go through review.

**Still open for discussion**:
1. **Content extraction**: should text be extracted from PDF/Office to enable full-text search? (Optional for Phase 2; support markdown/html/text/json first.)
2. **Review granularity**: once both `link` and `public` enter the queue, should there be separate queue priorities? (`public` affects SEO/the public surface, so reviewing it first is suggested.)

---

*This document is a design proposal; development breakdown and task scheduling begin after review and confirmation.*

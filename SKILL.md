---
name: ado-hygiene-skill
description: Scans Azure DevOps for work-item hygiene gaps (no owner, no due date, no description, no child tasks, missing hours, duplicates) and routes findings to the people who can fix them via Teams. Authenticates with an Azure CLI token (az login) against the ADO REST API — no MCP server required, and the tenant is auto-discovered from the organization. Scope follows a configurable manager's ADO team and semester. Dry-run by default. For Scout/WorkIQ group delivery, tags every owner with a real Teams mention. Use when the user says "ado hygiene", "hygiene sweep", "check ADO", or asks who needs to fix their work items.
---

# ADO Hygiene Sweep

Scans Azure DevOps for work-item hygiene gaps and routes each finding to the person who can fix it, as one consolidated Teams message. Unowned items go to a team group chat instead.

**Skill root:** `<SKILL_ROOT>`

> `<SKILL_ROOT>` is this skill's own folder — the directory containing this
> `SKILL.md`, with `src/`, `config/` and `test/` beside it. Everything the sweep
> needs lives there; nothing outside it is required.

---

## STEP 0 — Preflight

The sweep talks to Azure DevOps over the REST API, authenticated with a token
brokered by the Azure CLI. That is the only requirement, and it is the same on
Windows, macOS and Linux.

### A. Verify the credential

```bash
az account get-access-token \
  --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --query accessToken -o tsv
```

`499b84ac-1321-427f-aa17-267ca6975798` is the Azure DevOps first-party resource
ID — identical in every tenant, so it is safe to hardcode.

If that fails, sign in **against the organization's tenant**:

```bash
az login --tenant <tenant-id> --allow-no-subscriptions
```

`--allow-no-subscriptions` is not optional boilerplate. Azure DevOps access does
not require an Azure subscription, and without the flag `az login` fails outright
for anyone who has ADO but no subscription in that tenant.

### B. The tenant is discovered, never hardcoded

Do not ask the user for a tenant ID and do not assume one. The organization will
name its own tenant:

```bash
curl -sI https://dev.azure.com/<org>/_apis/connectionData \
  -H 'X-TFS-FedAuthRedirect: Suppress' | grep -i x-vss-resourcetenant
```

`src/ado.js` does this automatically on every live run and caches the result to
`azureDevOps.tenantId`. Because the value is derived from the org name, the skill
works unchanged against any organization, on any machine.

**The redirect suppression is load-bearing.** Without that header ADO replies
`203 Non-Authoritative Information` with an HTML sign-in page instead of a `401`,
the header is absent, and every downstream error becomes misleading.

### C. Diagnosing auth failures

| Symptom | Cause | Fix |
|---|---|---|
| `Could not determine the Azure AD tenant` | Wrong org name, or the discovery probe is blocked | Check `azureDevOps.organization`; set `azureDevOps.tenantId` by hand |
| `Token tenant mismatch: got a token for tenant X` | `az` defaulted to another tenant | `az login --tenant <right-one> --allow-no-subscriptions` |
| `Could not get an Azure DevOps token` | Not signed in, or refresh token expired | Re-run `az login` as above |
| HTTP 203 with HTML in the body | A request lost the `X-TFS-FedAuthRedirect` header | Bug — all calls in `src/ado.js` must send it |
| HTTP 401 on a valid-looking token | Correct tenant, no ADO access | Confirm the account can open the org in a browser |

The scanner validates the token's `tid` claim locally before its first call, so a
wrong-tenant token is reported as a precise, actionable message rather than a
bare 401.

### D. The MCP server is optional

An Azure DevOps MCP server, if present, lets the assistant answer ad-hoc
questions in chat ("why was this item flagged?"). It is **not** part of the
sweep and its absence never blocks a run.

It cannot be: `node src/index.js` is a child process with its own REST client,
while MCP tools belong to the assistant. The MCP server holds its token in memory
under its own client ID, with no on-disk cache the scanner could read. Two
different credentials, by construction — a healthy MCP server does nothing for
the scanner, and a missing one costs it nothing.

### Never do these

- **Never report hygiene findings** sourced from anything other than a live,
  authenticated ADO query. Do not fabricate.
- **Never pass `--send`** unless the user explicitly asks to send.
- **Never ask the user for a PAT.** `az login` covers every supported platform
  and leaves no secret on disk. (`ADO_PAT` exists solely as a CI escape hatch.)

---

## Golden rules

0. **Confirm the prerequisites first (Step 0).** Offer to help set them up rather than routing around them.
1. **Never pass `--send` unless the user explicitly asks to send.** Default to dry run, show the results, let them decide.
2. **Always show the report before sending.**
3. **Never invent work items.** If the ADO query fails, say so and stop.
4. **Nothing flagged means nothing sent.** Silence is a valid result.
5. **Use the report template below verbatim.** Same four sections, same order, every time.
6. **When posting one consolidated Teams group message, tag every owner.** Use real Teams mentions, not just owner display names.

---

## THE REPORT TEMPLATE

Every report — chat or Teams — uses exactly these four sections in this order.

### 1. Header

```
ADO Hygiene Report — <SEMESTER> (<month range>)
<date> · Scope: <team> · <N> scanned · <N> flagged (<N>%) · <N> clean · DRY RUN
Current sprint: <name> (<dates>)
```

### 2. Findings

Every flagged item, most-severe first:

| # | Item | Type / State | Sprint | Owner | Issue |

- `Item` = `#ID` linked to ADO, then the title
- `Sprint` = Current / Past / Future / — (none)
- `Owner` = display name, or *none* for unowned. In a consolidated Teams group message, render each owned row with a real Teams mention in this cell.
- Highlight urgent rows (unassigned + near due date)

### 3. Breakdown

| Issue | Count |

Sorted descending.

### 4. Action items

Bullets — only genuinely urgent or decision-requiring items. Typically 1–3. If nothing is urgent, say so plainly.

### Not in the routine report

Include **only when asked**, or when the underlying config changed: rules table,
scope / area-path breakdown, "in flight" matrix, exemptions, routing table,
config reference, CLI flags.

---

## Commands

```bash
cd "<SKILL_ROOT>"

node src/index.js                          # live scan, dry run  ← default
node src/index.js --semester CY26-H1       # specific semester
node src/index.js --manager "Name" --team "Team Name"
node src/index.js --areas "Path1;Path2"    # override area paths
node src/index.js --fixture <file>         # offline / captured data
node src/index.js --send                   # ONLY on explicit request
node test/run.js                           # 56 tests
```

PowerShell: use `2>&1` when capturing — Node writes progress to stderr.

Read results:

```powershell
$j = [IO.File]::ReadAllText("<SKILL_ROOT>\out\findings.json") | ConvertFrom-Json
$j.findings | ForEach-Object { "$($_.id)|$($_.type)|$($_.owner.name)|$($_.gaps.detail -join '; ')" }
```

Work item URL: `https://<org>.visualstudio.com/<Project>/_workitems/edit/<ID>`

---

## Configuration — `config/config.json`

| Key | Purpose |
|---|---|
| `manager.displayName` / `.email` | Whose org is swept |
| `azureDevOps.team` | **Drives scope** — area paths read from this ADO team |
| `azureDevOps.areaPaths` | Explicit override; empty = auto-resolve from team |
| `azureDevOps.semester` | `"auto"` or `"CY26-H2"` |
| `rules.*` | `enabled` plus per-rule thresholds |
| `routing.excludePeople` | Never nudged |
| `routing.groupChatId` | Where unowned items post |
| `safety.dryRun` | `true` by default |

Scope precedence: explicit `areaPaths` → live ADO team lookup → cached copy.

On a fresh install `areaPathsCache` is empty, so the **first run must be live**
(or use `--areas`). After one successful live run the cache populates.

---

## The rules

| Rule | Fires when | Applies to |
|---|---|---|
| `missingDueDate` | No Target Date | Features only |
| `unassigned` | No owner | In flight, or due within `dueSoonDays` (30) |
| `emptyDescription` | Under 15 chars after HTML stripping | User Stories / PBIs, except buckets |
| `blankAcceptance` | Under 10 chars | User Stories in flight |
| `noChildTasks` | No children | User Stories in flight |
| `missingHours` | Estimate / Remaining blank; Completed only once Active | Tasks in flight |
| `noParent` | No parent link | All except Key Result, Epic |
| `duplicateTitle` | Same title **within same area path** | Titles 12+ chars |
| `rootAreaPath` | Area Path at project root | All |
| `notInSprint` | In flight, parked at semester root | Leaf items |
| `staleActive` | Active, untouched 14+ days | **Disabled** |

**In flight** = state is `Active`/`Committed`/`In Progress` **OR** iteration is the current or a past sprint — **and not** a future sprint.

### Exemptions

- Descriptions on **Features, Epics, OKRs, Tasks** — only User Stories specify the work
- **Bucket containers** — Feature/Epic with children, not itself in a sprint
- **Cross-crew same titles** — different area paths; two crews sharing work is intentional
- **Future-sprint work** — not groomed yet, correctly
- **Unscheduled backlog** with no near deadline
- **Closed / Completed / Removed**
- **Staleness** — `ChangedDate` moves on any edit

---

## Routing

Native `--send` delivery DMs only the person in `Assigned To`. Never infer from
parent or creator. Unowned items go to the group chat, clustered by parent. One
consolidated message per person per run.

Sending uses a Microsoft Graph token obtained the same way as the ADO one
(`az account get-access-token`), so `--send` has the same prerequisite as a live
scan. Alternatively the assistant can deliver the generated messages with
`workiq_send_chat_message`, which needs no extra credential.

### WorkIQ group delivery with owner tags

When Conditional Access blocks `--send` and the assistant delivers one group
message with `workiq_send_chat_message`, owner tagging is required:

1. Resolve the target chat with `workiq_search_chats` and use only an exact topic
   match.
2. Match every finding owner to a chat member by email first, then display name.
3. In the Findings table, put `<at id="N">Display Name</at>` in the `Owner` cell
   for each owned item and pass a matching `mentions` array to
   `workiq_send_chat_message`. Reuse the same mention id for the same owner
   throughout the message.
4. If any owned finding cannot be matched to a chat member, do not send. Report
   the unmatched owner(s) so the chat membership or routing can be fixed.
5. Leave ownerless items as `<i>none</i>` and do not mention anyone for them.

---

## Output

```
out/
  summary.txt / summary.html    run summary
  findings.csv                  Excel-friendly
  findings.json                 full structured output
  messages/dm-<Person>.html     what each person receives
  messages/_group-chat.html     unowned-items post
  run.log                       scheduled-run history
```

---

## Scheduling

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-task.ps1 -Send
```

Every 3 days at 09:00, weekends skipped by `scripts/run.ps1`. Unattended runs
rely on the cached `az login` refresh token, so sign in once interactively first.

---

## Common requests

| User says | Do |
|---|---|
| "run the hygiene sweep" | `node src/index.js`, report using the template |
| "check last semester" | `--semester CY26-H1` |
| "check <name>'s team" | `--manager "Name" --team "Team Name"` |
| "stop nagging X" | Add to `routing.excludePeople` with a reason, re-run |
| "too noisy" | Disable the loudest rule or narrow `appliesToTypes` |
| "what rules are you using" | Show the rules table — it is not in the routine report |
| "send it" | Confirm recipients, then use `--send` only when Graph token delivery works; otherwise deliver one WorkIQ group message with owner mentions |
| "schedule it" | `scripts/register-task.ps1` |

---

## If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| `Could not get an Azure DevOps token` | Not signed in | `az login --tenant <id> --allow-no-subscriptions` (Step 0A) |
| `Token tenant mismatch` | `az` defaulted to the wrong tenant | Re-run `az login` with the tenant from Step 0B |
| `HTTP 401` | Token expired / wrong org | Re-authenticate; check `organization` |
| `HTTP 404` on team settings | Team name mismatch | Copy from ADO Project Settings → Teams |
| `No scope available for team` | Fresh install, no cache, live lookup failed | Run live once, or set `areaPaths` / `--areas` |
| `Refusing to run: cached scope belongs to...` | Changed `team`, live lookup unavailable | Authenticate, or set `areaPaths` explicitly |
| `0 work items` | Semester or scope wrong | Check `--semester`, confirm area paths |
| Everything flagged | Rule too broad | Narrow `appliesToTypes` or set `inFlightOnly` |

On failure, report the error and stop. Do not fabricate findings.

# ADO Hygiene Sweep

**ADO hygiene, routed to the people who can actually fix it.**

DPG IDC Mystery Box Challenge — *Operation Crowd*

---

## The problem

Manual ADO backlog hygiene bottlenecked behind two people — solved with an AI
automation that routes each finding to its owner.

---

## The impact

Backlog hygiene is a recurring manual tax. Every two weeks a manager and a team
lead sit down for an hour and comb the same backlog for missing owners, absent
due dates, empty descriptions and unestimated tasks — then chase each person
individually.

| | |
|---|---|
| Cadence | 1 hour, every 2 weeks |
| People in the room | 2 (manager + team lead) |
| Cycles per year | 26 |
| **Cost** | **52 hours ≈ 6 working days per team, per year** |

And it scales linearly: every additional team pays the same tax again.

ADO Hygiene Sweep removes that meeting. The review stops being a meeting and
becomes a message — cleanup happens in parallel, done by the people who own the
work, with nobody triaging on their behalf.

What it buys back:

- **~6 working days a year, per team**, returned to the manager and lead.
- **Parallel cleanup** instead of a serial queue — every owner fixes only their
  own items, at the same time.
- **No chasing.** Each person is told exactly what is wrong and how to fix it,
  once per run, in one message.
- **Nothing falls through.** Ownerless work is surfaced to the team to be
  claimed rather than quietly rotting in the backlog.

---

## The mystery, decoded

> **Scenario** — A hundred people are trying to get through a single doorway.
> **Mission** — Get everyone through.
> **Constraint** — The doorway can't get any wider.

Here is the same shape in our backlog:

| The metaphor | Our reality |
|---|---|
| A hundred people | ~140 open work items in the org, every one of them somebody's to fix |
| The single doorway | A manager and a lead, manually reviewing all of it before every shiproom |
| Can't widen the doorway | You can't buy more lead-hours, and nobody wants another process meeting |

The instinct is to make the reviewer faster. That's trying to widen the doorway, and it doesn't work — the queue just moves.

**ADO Hygiene Sweep stops routing the crowd through one door.** Every item is delivered straight to the one person who can clear it, in parallel. The reviewer stops being a bottleneck because the queue never forms.

It doesn't make the doorway wider. It makes the flow through it orderly, continuous, and one-at-a-time-per-person.

---

## What it does

Every 3 days, on working days:

1. **Resolves scope** — asks Azure DevOps which area paths the configured manager's team owns. Not a hardcoded list, so it survives reorgs.
2. **Scans** every open work item in that scope.
3. **Flags** hygiene gaps — 10 rules, each with a plain-English fix.
4. **Finds the owner** from `Assigned To` only.
5. **Delivers a compact team-chat report** through WorkIQ when Conditional Access blocks native Graph sending, tagging every owner with a real Teams mention.
6. **Keeps ownerless items in the same team-chat report** as `<none>` so someone can claim them.

If nothing is flagged, it sends nothing. Silence is a valid result.

---

## Real output

A live, calibrated run against one manager's org:

```
ADO HYGIENE SWEEP — <Manager>'s org
18 Sept 2026, 11:24 IST   [DRY RUN — nothing sent]

  Scanned 141   Flagged 18 (13%)   Clean 118
  People nudged 5   Ownerless -> group 1

BY ISSUE TYPE
  No due date                     10  ██████████████████████
  Missing hours                    4  █████████
  Empty description                3  ███████
  Blank acceptance criteria        2  ████
  Unassigned                       1  ██
```

**13% flagged, not 90%.** An earlier, uncalibrated version flagged most of the
backlog — which is the same as flagging nothing, because people mute it. The
current rule set is deliberately conservative (see below), so every line in the
report is something a human would agree needs fixing.

Out-of-scope items are excluded before the rules ever run: the sweep only looks
at the area paths the configured ADO team actually owns, so another crew's
backlog is never swept or nudged about.

The routine team-chat report uses the four-section template from `SKILL.md`:
Header, Findings table, Breakdown, Action items. Each work item ID is linked to
ADO, each owned row tags the owner with a Teams mention, and ownerless items stay
as `<none>`.

---

## Why it doesn't get muted

The hard part was never detection — it was trust. A hygiene bot that cries wolf
is muted within a week, and a muted bot is worse than no bot.

- **Grooming rules only fire once work is in flight.** A `New` item in the
  backlog isn't neglected, it's a backlog item.
- **Hour fields are state-aware.** Asking for `Completed Work` on a task that
  hasn't started is noise.
- **Weak signals ship disabled.** `staleActive` is off: `ChangedDate` moves on
  any edit, so "untouched" doesn't reliably mean "abandoned".
- **Cross-team duplicates are treated as intentional.** Two crews tracking the
  same work under their own area paths is a convention, not a mistake.
- **Clean runs say nothing at all.** No "all clear" spam.
- **Findings come only from a live authenticated scan.** A failed query stops
  the run rather than inventing work items.
- **Only `Assigned To` earns a nudge.** Ownerless items are surfaced to the
  group to be claimed, never blamed on whoever happened to create them.

---

## The hygiene rules

| Rule | Fires when | Scoped to |
|---|---|---|
| `noParent` | No parent link | All except Key Result, Epic |
| `emptyDescription` | Description under 15 chars after HTML stripping | User Stories / PBIs only |
| `missingHours` | Estimate / Remaining / Completed missing | In-flight Tasks |
| `unassigned` | No `Assigned To` | In flight, or due within 30 days |
| `duplicateTitle` | Another item has the same normalised title | Titles 12+ chars |
| `staleActive` | `Active` but untouched 14+ days | Active only — **off by default** |
| `rootAreaPath` | Area Path left at project root | All |
| `notInSprint` | In flight but parked at semester root | In-flight leaf items |
| `blankAcceptance` | No acceptance criteria | In-flight User Stories / PBIs |
| `noChildTasks` | No children broken out | In-flight User Stories / PBIs |

**Why the noise calibration matters** — see [Why it doesn't get muted](#why-it-doesnt-get-muted) above. In short: in-flight gating, state-aware fields, and dropping weak signals took the flag rate from ~90% down to 13%.

Every rule is toggleable in `config/config.json`. Turn off what your team doesn't care about.

---

## Configuration

Everything about *who* and *what* lives in `config/config.json`.

```jsonc
{
  "manager": {
    "displayName": "Manager Display Name",   // change this, the scope follows
    "email": "manager@example.com"
  },
  "azureDevOps": {
    "organization": "example-org",
    "project": "Sample Project",
    "team": "Your ADO Team Name"             // scope is read from this team's area paths
  },
  "routing": {
    "groupChatName": "Your Team Group Chat",
    "summaryRecipient": "you@example.com",
    "maxItemsPerMessage": 12
  },
  "schedule": { "everyNDays": 3, "timeOfDay": "09:00", "workingDaysOnly": true },
  "safety": { "dryRun": true }
}
```

Or override at the command line:

```bash
node src/index.js --manager "Priya Sharma" --team "Priya S Crew"
```

---

## Usage

```bash
# Dry run against captured data — no auth, no network, nothing sent
node src/index.js --fixture fixtures/enterprise-cloud-cy26h2.json

# Dry run against live ADO
node src/index.js

# Native delivery, only when Microsoft Graph token delivery works
node src/index.js --send

# Tests
node test/run.js
```

Dry run writes everything to `out/`:

```
out/
  summary.txt              run summary, plain text
  summary.html             run summary, Teams-ready
  findings.csv             every flagged item, spreadsheet-friendly
  findings.json            full structured output
  messages/
    dm-Jane-Doe.html   exactly what each person would receive
    _group-chat.html       the ownerless post
```

**Read `out/findings.json` and `out/messages/` before sending anything.** In
Scout, prefer a WorkIQ group-chat post with owner mentions when Conditional
Access blocks the Graph token used by `--send`.

---

## Safety

Nagging bots get muted, and a muted bot is worse than no bot. The guard rails:

1. **`dryRun: true` is the default.** Delivery requires an explicit send step.
2. **Nothing flagged means nothing sent.** No "all clear" spam.
3. **Consolidated delivery.** Never one message per item.
4. **Failures are reported, not retried.** A retry loop turns one nudge into ten.
5. **A broken ADO query stops the run.** It never invents work items — it tells you the sweep failed and exits non-zero.

---

## Auth

| Purpose | Primary | Escape hatch |
|---|---|---|
| Azure DevOps | `az account get-access-token` | `ADO_PAT` env var (CI only) |
| Microsoft Graph native `--send` | `az account get-access-token` | `GRAPH_TOKEN` env var (CI only) |
| Scout delivery | `workiq_send_chat_message` | none |

```bash
# discover the org's tenant, then sign in against it
curl -sI https://dev.azure.com/<org>/_apis/connectionData \
  -H 'X-TFS-FedAuthRedirect: Suppress' | grep -i x-vss-resourcetenant
az login --tenant <tenant-id> --allow-no-subscriptions
```

`az login` is the supported path on every platform. A PAT expires, has to be
stored somewhere, and outlives your session — use one only where interactive
sign-in is impossible.

---

## Scheduling

```powershell
# Every 3 days at 09:00, working days only
powershell -File scripts/register-task.ps1
```

For Scout automation, schedule the dry-run scan and deliver findings with
`workiq_send_chat_message` to the exact team chat, passing a `mentions` array for
every owner. Use `node src/index.js --send` from a scheduler only in tenants
where Microsoft Graph token delivery is allowed.

---

## Design notes

**Scope is resolved, not hardcoded.** The obvious implementation is a list of area paths in config. That list is wrong the moment someone reorgs. ADO Hygiene Sweep asks ADO for the team's *current* area paths on every run, and caches the answer so offline runs behave identically.

**Owner resolution is intentionally strict.** Only `Assigned To` is treated as
the accountable owner. Inferring from parent owner or creator causes noisy,
accusatory nudges, so unassigned items stay ownerless and are surfaced to the
team chat for claiming.

**Fixture mode exists so this is demonstrable.** Captured ADO snapshots can be
kept locally under `fixtures/`, but real backlog snapshots are not redistributed.
The repository keeps only safe fixture metadata such as `fixtures/iterations.json`.

---

## Project layout

```
src/
  index.js     CLI orchestrator
  scope.js     manager -> ADO team -> area paths
  ado.js       Azure DevOps REST client, WIQL paging, batch fetch
  rules.js     hygiene rules engine (pure, no I/O)
  digest.js    findings -> Teams messages
  notify.js    Graph delivery with guard rails
test/run.js    56 tests, no framework
config/        configuration
fixtures/      real captured ADO data
```

`rules.js` is pure functions over a normalised shape — no network, no side effects — so every rule is unit-testable.

---

## Tests

```
$ node test/run.js

56 passed, 0 failed
```

The tests cover scope resolution, rule calibration, strict owner routing, digest
generation, and failure guards. If a private captured backlog fixture is absent,
that one block is skipped.

---

## Team

Built for the DPG IDC Mystery Box Challenge, CY26.

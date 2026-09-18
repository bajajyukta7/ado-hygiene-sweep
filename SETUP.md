# Setting up the ADO Hygiene Sweep

A step-by-step guide for someone who has never run this before.
Expect about 15 minutes.

> 📺 **Prefer it interactive?** The same walkthrough is on VibeHub as a
> [Setup Lab](https://vibehub.microsoft.com/app/yuktabajaj-adohygienesweep) — presenter
> mode for running it live in front of a room, self-guided mode with checklists and
> saved progress.

---

## What you are setting up

This tool scans Azure DevOps every few days, finds work items with hygiene gaps
(no owner, no due date, no description), and prepares consolidated Teams-ready
reports. In Scout automation, findings are delivered as one compact group-chat
message with each owner tagged. Anything nobody owns stays marked as ownerless
in that same report.

It does not write to Azure DevOps. It only reads, and it only sends Teams
messages — and even that is off until you explicitly turn it on.

---

## Step 1 — Check your prerequisites

```bash
node --version    # need v18 or newer
az --version
```

**Missing something?**

| Missing | Windows | macOS / Linux |
|---|---|---|
| Node.js | `winget install OpenJS.NodeJS.LTS` | `brew install node` |
| Azure CLI | `winget install Microsoft.AzureCLI` | `brew install azure-cli` |

Close and reopen your terminal after installing, or the new commands won't be on
your PATH.

---

## Step 2 — Get the code

The skill folder *is* the project — `src/`, `config/` and `test/` sit beside
`SKILL.md`. Drop it in your assistant's skills directory (on Scout that is
`~/.scout/m-skills/ado-hygiene-skill`) and `cd` into it.

No `npm install` needed — there are zero runtime dependencies, deliberately.
Fewer moving parts, nothing to keep patched.

---

## Step 3 — Prove it works before touching any credentials

```bash
node test/run.js
```

You should see `56 passed, 0 failed` (one block reports `skip  fixture not
present` — that is expected, see below).

The tests read `config/config.sample.json`, never your own `config/config.json`,
so they give the same result on a fresh clone as on a configured machine.

**No demo fixture is included.** The original bundled a snapshot of a real
team's backlog, which is not ours to redistribute. The suite skips that one
block when the file is absent; the remaining tests cover the rules, routing and
digest logic in full.

**If the tests pass, the tool is fine.** Anything that fails later is
configuration or credentials, not the code.

---

## Step 4 — Sign in to Azure DevOps

The scanner authenticates with a token brokered by the Azure CLI. No Personal
Access Token, nothing secret on disk, and the same two commands on every
platform.

First, find the tenant behind your organization — don't guess it:

```bash
curl -sI https://dev.azure.com/<your-org>/_apis/connectionData \
  -H 'X-TFS-FedAuthRedirect: Suppress' | grep -i x-vss-resourcetenant
```

Then sign in against exactly that tenant:

```bash
az login --tenant <tenant-id> --allow-no-subscriptions
```

Two details that are easy to get wrong:

- **`--allow-no-subscriptions` is required.** Azure DevOps access does not need
  an Azure subscription, and without the flag `az login` fails outright for
  anyone who has ADO but no subscription in that tenant.
- **Always pass `--tenant`.** Without it, `az` uses your default subscription's
  home tenant. If you are a guest anywhere else you get a valid token for the
  *wrong* tenant, and ADO answers with an HTML sign-in page rather than a clean
  error.

You do not need to put the tenant in your config. The scanner performs the
discovery above automatically on every live run and caches the result. Set
`azureDevOps.tenantId` by hand only if your network blocks that probe.

Verify:

```bash
az account get-access-token \
  --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --query accessToken -o tsv
```

That GUID is the Azure DevOps first-party resource ID — the same in every
tenant. If a token prints, you are done.

> `ADO_PAT` is still honoured as an escape hatch for CI systems where
> interactive sign-in is impossible. Prefer `az login` everywhere else: a PAT
> expires, has to be stored somewhere, and grants access that outlives your
> session.

Read-only access is enough. The sweep never writes to ADO.

---

## Step 5 — Point it at your team

Open `config/config.json` and change these four values:

```jsonc
{
  "manager": {
    "displayName": "Your Manager Name",
    "email": "manager@example.com"
  },
  "azureDevOps": {
    "organization": "example-org",        // from your ADO URL
    "project": "Sample Project",
    "team": "Your Team Name"               // ← this one decides the scope
  }
}
```

**The `team` value is the important one.** ADO Hygiene Sweep asks Azure DevOps which
area paths that team owns and scans exactly those. It is not a hardcoded list,
so when the team reorganises, the sweep follows automatically.

To find your team name: open Azure DevOps → **Project Settings → Teams**.

> **Safety guard.** The config ships with a cached copy of the *original*
> team's area paths, used for offline runs. If you change `team` but the live
> lookup cannot run (not signed in yet), ADO Hygiene Sweep **refuses to start** rather
> than silently sweeping someone else's areas. You'll see:
>
> ```
> Refusing to run: cached scope belongs to "Previous Team Name"
> but the configured team is "Your Team".
> ```
>
> Fix it by signing in (Step 4) so the live lookup works, or by setting
> `azureDevOps.areaPaths` explicitly for your team.

> **Editing on Windows:** if you edit the config with PowerShell's
> `Set-Content`, it writes a UTF-8 BOM. ADO Hygiene Sweep strips it automatically, but
> plain editors like VS Code or Notepad are safer.

---

## Step 6 — First live scan (still safe)

```bash
node src/index.js
```

`dryRun` is `true` by default, so this reads ADO and writes draft messages to
disk. It sends nothing.

Expected output:

```
Resolving scope for <Manager> via team "<Team>"…
  scope source: ADO team settings (live)
    Project\Area\Path (+children)
  187 open work item(s)
  current sprint: Week 37 - 38

ADO HYGIENE SWEEP — <Manager>'s org
  Scanned 187   Flagged 24 (13%)   ...
```

**Troubleshooting**

| Error | Cause | Fix |
|---|---|---|
| `Could not get an Azure DevOps token` | Not signed in | `az login --tenant <id> --allow-no-subscriptions` |
| `Token tenant mismatch` | Signed in to the wrong tenant | Re-run `az login` with the tenant from Step 4 |
| `Refusing to run: cached scope belongs to...` | Changed `team` but live lookup unavailable | Sign in, or set `areaPaths` explicitly |
| `Could not parse <file>` | Malformed JSON | Check trailing commas; paths need `\\` not `\` |
| `HTTP 401` | Token expired or wrong org | Re-run `az login`; check `organization` |
| `HTTP 404` on team settings | Team name doesn't match | Copy it exactly from Project Settings → Teams |
| `0 open work items` | Scope or iteration mismatch | Check `semester` matches your current one |

---

## Step 7 — Read the drafts

This is the step people skip. Don't.

```
out/
  summary.txt              what the run found
  findings.csv             every flagged item, open in Excel
  messages/
    dm-Jane-Doe.html       exactly what Jane would receive
    _group-chat.html       the unowned-items post
```

Open two or three of the `dm-*.html` files in a browser and read them as if you
were the recipient. Ask yourself:

- Is every item genuinely that person's problem?
- Would this feel useful, or would it feel like nagging?
- Is anything flagged that your team simply doesn't care about?

**Tune before you send.** A digest people trust gets acted on; one that cries
wolf gets muted in a week, and you don't get a second first impression.

---

## Step 8 — Tune the rules

Everything lives in `config/config.json`. Set `"enabled": false` to switch a
rule off.

| Rule | Fires when | Default scope |
|---|---|---|
| `missingDueDate` | Feature has no Target Date | Features only |
| `unassigned` | No owner | In flight, or due within 30 days |
| `emptyDescription` | Description under 15 chars | User Stories / PBIs only |
| `blankAcceptance` | No acceptance criteria | User Stories in flight |
| `noChildTasks` | Story has no children | User Stories in flight |
| `missingHours` | Estimate / Remaining / Completed blank | Tasks in flight |
| `noParent` | No parent link | All except Key Result, Epic |
| `duplicateTitle` | Another item has the same title | Titles 12+ chars |
| `rootAreaPath` | Area Path left at project root | All |
| `notInSprint` | In flight but parked at semester root | Leaf items |
| `staleActive` | Active but untouched 14+ days | **Off by default** |

**Useful knobs:**

```jsonc
// How close a deadline must be before an unowned item is chased
"unassigned": { "enabled": true, "dueSoonDays": 30 }

// People who should never be nudged (other orgs, contractors, shared accounts)
"excludePeople": [
  { "name": "Jane Doe", "email": "jane@example.com", "reason": "Different org" }
]

// Cap items per message so nobody gets a wall of text
"maxItemsPerMessage": 12
```

Re-run after each change and re-read the drafts. Iterate until the output is
something you would be happy to receive yourself.

---

## Step 9 — Set the Teams destinations

```jsonc
"routing": {
  "groupChatName": "Your Team Chat",
  "groupChatId": "19:xxxxx@thread.v2",
  "summaryRecipient": "you@example.com"
}
```

**To find the group chat ID:** open the chat in Teams → **⋯ → Copy link**. The
ID is the part between `/chat/` and `/0?`, URL-decoded — it looks like
`19:abc123...@thread.v2`.

`summaryRecipient` is you. You get the run summary every time so you always know
what went out.

---

## Step 10 — Deliver for real

Only when the drafts look right:

```bash
node src/index.js --send
```

This native path asks for Microsoft Graph access on first use (`Chat.ReadWrite`).
Use it only in tenants where that token is allowed.

Output:

```
  sent -> Jane Doe (3 item(s))
  sent -> John Smith (2 item(s))
  sent -> Your Team Chat (1 ownerless)
  sent -> run summary to you@example.com

Delivered 4, failed 0, skipped 0.
```

> **Worth doing on the first real run:** temporarily set every recipient to
> yourself, send, and read the messages in Teams. It's the last chance to catch
> anything that reads wrong before your colleagues see it.

### Scout / WorkIQ delivery

If Conditional Access blocks the Graph token used by `--send`, keep the scan as a
dry run and deliver through Scout:

1. Run `node src/index.js 2>&1` with no `--send`.
2. Read `out/findings.json`.
3. Resolve the team chat with `workiq_search_chats` and require an exact
   `groupChatName` match.
4. Send one `workiq_send_chat_message` with `contentType: "html"`.
5. In the Findings table, tag every owner with `<at id="N">Display Name</at>`
   and pass the matching `mentions` array. Reuse the same mention id for the
   same owner throughout the message.
6. If any owner cannot be matched to a chat member by email or display name, do
   not send; fix the chat membership or routing first.

---

## Step 11 — Schedule it

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-task.ps1 -Send
```

Every 3 days at 09:00. Change with `-EveryNDays 7 -Time "08:30"`.
Leave off `-Send` to schedule it in dry-run mode first.

```powershell
Start-ScheduledTask -TaskName 'ADO Hygiene Sweep'    # run now
Unregister-ScheduledTask -TaskName 'ADO Hygiene Sweep'  # remove
```

**macOS / Linux**

```bash
crontab -e
# 09:00 on Mon, Thu, dry-run scan; delivery should be handled by Scout/WorkIQ
0 9 * * 1,4 cd /path/to/ado-hygiene-skill && /usr/bin/node src/index.js
```

---

## Safety summary

| Guard | Behaviour |
|---|---|
| Dry run by default | Nothing sends without an explicit delivery step |
| Silence on clean | Nothing flagged means nothing sent, no "all clear" spam |
| Consolidated delivery | One compact report per run, never one message per item |
| Owner tags | WorkIQ group delivery must mention every owner and leave ownerless items as `<none>` |
| No blind retries | A failed send is reported, not retried into a duplicate nag |
| Fails loudly | A broken ADO query stops the run rather than inventing data |
| Read-only on ADO | Never modifies a work item |

---

## Quick reference

```bash
node test/run.js                              # 56 tests
node src/index.js --fixture fixtures/*.json   # offline demo, no auth
node src/index.js                             # live scan, dry run
node src/index.js --send                      # native Graph delivery, if allowed
node src/index.js --manager "Name" --team "Team"   # override scope
```

---

## Adopting it for a different team

ADO Hygiene Sweep isn't hardcoded to one org. To point it somewhere else:

1. Change `manager` and `azureDevOps.team` in the config
2. Update `routing.groupChatId` to that team's chat
3. Clear `routing.excludePeople` — it's populated for the original team
4. Run in dry-run for a week and tune the rules to their conventions
5. Then enable an explicit delivery path: native `--send` where Graph token
   delivery works, or Scout/WorkIQ group delivery with owner mentions where it
   does not

Every team has different norms about what belongs in a description or when a due
date is required. The rules are configuration, not assumptions — expect to spend
the first week adjusting them.

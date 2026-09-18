'use strict';

/**
 * Turns raw findings into the messages people actually receive.
 *
 * Design rule: one consolidated message per person per run. Never one per item.
 * A nag that arrives 20 times gets muted; a nag that arrives once gets actioned.
 */

const RULE_LABELS = {
  noParent: 'No parent link',
  emptyDescription: 'Empty description',
  missingHours: 'Missing hours',
  missingDueDate: 'No due date',
  unassigned: 'Unassigned',
  duplicateTitle: 'Possible duplicate',
  staleActive: 'Stale while Active',
  rootAreaPath: 'Area Path at root',
  notInSprint: 'Not in a sprint',
  blankAcceptance: 'Blank acceptance criteria',
  noChildTasks: 'No child tasks',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** Group findings by resolved owner; unresolved go under the null key. */
function groupByOwner(findings) {
  const owned = new Map();
  const orphans = [];
  for (const f of findings) {
    if (!f.owner?.name) { orphans.push(f); continue; }
    const key = f.owner.email || f.owner.name;
    if (!owned.has(key)) {
      owned.set(key, { name: f.owner.name, email: f.owner.email, items: [] });
    }
    owned.get(key).items.push(f);
  }
  for (const g of owned.values()) g.items.sort((a, b) => b.score - a.score);
  return { owned, orphans };
}

function renderItemHtml(f) {
  const gaps = f.gaps.map((g) =>
    `<li>${esc(g.detail)}<br><span style="color:#666;font-size:12px;">${esc(g.fix)}</span></li>`
  ).join('');
  const inherited = f.owner?.source && f.owner.source !== 'Assigned To'
    ? ` <span style="color:#8a6d3b;font-size:12px;">(routed via ${esc(f.owner.source)})</span>`
    : '';
  // Both the id and the title are links — whichever the reader reaches for,
  // one click lands them on the item that needs fixing.
  return (
    `<li style="margin-bottom:10px;">` +
    `<a href="${esc(f.url)}"><b>#${f.id}</b></a> ` +
    `<span style="color:#666;">${esc(f.type)} · ${esc(f.state)}</span>${inherited}<br>` +
    `<a href="${esc(f.url)}" style="color:#0b5cab;text-decoration:none;">${esc(truncate(f.title, 110))}</a>` +
    `<ul style="margin:4px 0 0 0;">${gaps}</ul>` +
    `</li>`
  );
}

/** Plain-text rendering of one item, with the full URL on its own line. */
function renderItemText(f, n) {
  const lines = [];
  lines.push(`${n}. #${f.id}  [${f.type} · ${f.state}]`);
  lines.push(`   ${truncate(f.title, 100)}`);
  lines.push(`   ${f.url}`);
  for (const g of f.gaps) {
    lines.push(`     - ${g.detail}`);
    lines.push(`       → ${g.fix}`);
  }
  return lines.join('\n');
}

/** One person's DM. Leads with the count, then the specifics. */
function buildOwnerDigest(group, cfg, stamp) {
  const max = cfg.routing?.maxItemsPerMessage ?? 12;
  const shown = group.items.slice(0, max);
  const hidden = group.items.length - shown.length;
  const n = group.items.length;

  const html =
    `<p>Hi ${esc(group.name.split(' ')[0])} — quick ADO hygiene nudge ` +
    `(<b>${n}</b> work item${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a small fix).</p>` +
    `<ol>${shown.map(renderItemHtml).join('')}</ol>` +
    (hidden > 0 ? `<p><i>…and ${hidden} more. Full list in the run summary.</i></p>` : '') +
    `<p style="color:#666;font-size:12px;">Automated sweep for ${esc(cfg.manager.displayName)}'s org · ` +
    `${esc(stamp)} · reply here if something looks wrong.</p>`;

  const text =
    `Hi ${group.name.split(' ')[0]} — ADO hygiene nudge: ${n} item(s) need a small fix.\n\n` +
    shown.map((f, i) => renderItemText(f, i + 1)).join('\n\n') +
    (hidden > 0 ? `\n\n…and ${hidden} more.` : '');

  return { recipient: group.name, email: group.email, count: n, html, text };
}

/**
 * The one group post for items nobody owns.
 *
 * These arrive in batches — a grooming session that created twelve stories and
 * assigned none of them is one oversight, not twelve. Grouping by parent turns
 * a wall of fifty lines into a handful of claimable clusters.
 */
function buildGroupDigest(orphans, cfg, stamp, index) {
  if (!orphans.length) return null;

  const clusters = new Map();
  for (const f of orphans) {
    const key = f.parentId ? String(f.parentId) : '_none';
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(f);
  }

  const ordered = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);
  const blocks = [];

  for (const [key, items] of ordered) {
    const parent = key !== '_none' && index ? index.byId.get(Number(key)) : null;
    const heading = parent
      ? `<b>${esc(truncate(parent.title, 90))}</b> ` +
        `<span style="color:#666;">(#${key} · ${esc(parent.type || 'parent')})</span>`
      : `<b>No parent</b>`;

    if (items.length >= 3) {
      // A batch: summarise the shared problem, then list each item as its own
      // one-line link. Bare ids force a lookup; a title plus link does not.
      const gapKinds = [...new Set(items.flatMap((f) => f.gaps.map((g) => RULE_LABELS[g.rule] || g.rule)))];
      blocks.push(
        `<li style="margin-bottom:14px;">${heading}<br>` +
        `<span style="color:#a33;">${items.length} items — ${esc(gapKinds.join(', ').toLowerCase())}</span>` +
        `<ul style="margin:4px 0 0 0;">` +
        items.map((f) =>
          `<li style="margin-bottom:3px;">` +
          `<a href="${esc(f.url)}"><b>#${f.id}</b></a> ` +
          `<a href="${esc(f.url)}" style="color:#0b5cab;text-decoration:none;">${esc(truncate(f.title, 85))}</a>` +
          `</li>`
        ).join('') +
        `</ul></li>`
      );
    } else {
      blocks.push(
        `<li style="margin-bottom:14px;">${heading}` +
        `<ul style="margin:4px 0 0 0;">` +
        items.map((f) =>
          `<li><a href="${esc(f.url)}"><b>#${f.id}</b></a> ` +
          `<span style="color:#666;">${esc(f.type)}</span> — ` +
          `<a href="${esc(f.url)}" style="color:#0b5cab;text-decoration:none;">${esc(truncate(f.title, 80))}</a><br>` +
          `<span style="color:#666;font-size:12px;">${esc(f.gaps.map((g) => g.detail).join('; '))}</span></li>`
        ).join('') +
        `</ul></li>`
      );
    }
  }

  const html =
    `<p><b>${orphans.length} unassigned work item${orphans.length === 1 ? '' : 's'}</b> ` +
    `across ${clusters.size} area${clusters.size === 1 ? '' : 's'} — could someone pick these up?</p>` +
    `<ul>${blocks.join('')}</ul>` +
    `<p style="color:#666;font-size:12px;">Automated hygiene sweep for ` +
    `${esc(cfg.manager.displayName)}'s org · ${esc(stamp)}</p>`;

  const text =
    `${orphans.length} unassigned work items across ${clusters.size} areas.\n\n` +
    ordered.map(([key, items]) => {
      const parent = key !== '_none' && index ? index.byId.get(Number(key)) : null;
      const head = parent ? `${truncate(parent.title, 70)} (#${key})` : 'No parent';
      return `  ${head}  — ${items.length} item(s)\n` +
        items.map((f) => `    #${f.id}  ${truncate(f.title, 75)}\n      ${f.url}`).join('\n');
    }).join('\n\n');

  return {
    recipient: cfg.routing.groupChatName,
    chatId: cfg.routing.groupChatId,
    count: orphans.length,
    clusters: clusters.size,
    html,
    text,
  };
}

/** The run summary that goes back to whoever owns the automation. */
function buildRunSummary(result, plan, cfg, stamp) {
  const rules = Object.entries(result.byRule).sort((a, b) => b[1] - a[1]);
  const pct = result.scanned ? Math.round((result.flagged / result.scanned) * 100) : 0;

  const bar = (n, maxN) => {
    const w = maxN ? Math.max(1, Math.round((n / maxN) * 22)) : 0;
    return '█'.repeat(w);
  };
  const maxRule = rules.length ? rules[0][1] : 0;

  const html =
    `<p><b>ADO hygiene sweep — ${esc(cfg.manager.displayName)}'s org</b><br>` +
    `<span style="color:#666;">${esc(stamp)}${cfg.safety.dryRun ? ' · <b>DRY RUN — nothing sent</b>' : ''}</span></p>` +
    `<table cellpadding="6" style="border-collapse:collapse;">` +
    `<tr><td style="border:1px solid #ddd;">Scanned</td><td style="border:1px solid #ddd;"><b>${result.scanned}</b></td></tr>` +
    `<tr><td style="border:1px solid #ddd;">Flagged</td><td style="border:1px solid #ddd;"><b>${result.flagged}</b> (${pct}%)</td></tr>` +
    `<tr><td style="border:1px solid #ddd;">Clean</td><td style="border:1px solid #ddd;">${result.clean}</td></tr>` +
    `<tr><td style="border:1px solid #ddd;">People nudged</td><td style="border:1px solid #ddd;">${plan.owners.length}</td></tr>` +
    `<tr><td style="border:1px solid #ddd;">Ownerless → group</td><td style="border:1px solid #ddd;">${plan.group ? plan.group.count : 0}</td></tr>` +
    `</table>` +
    `<p><b>By issue type</b></p><ul>` +
    rules.map(([r, n]) => `<li>${esc(RULE_LABELS[r] || r)} — <b>${n}</b></li>`).join('') +
    `</ul>` +
    `<p><b>Who gets a nudge</b></p><ul>` +
    plan.owners.map((o) => `<li>${esc(o.recipient)} — ${o.count}</li>`).join('') +
    `</ul>`;

  const lines = [];
  lines.push(`ADO HYGIENE SWEEP — ${cfg.manager.displayName}'s org`);
  lines.push(stamp + (cfg.safety.dryRun ? '   [DRY RUN — nothing sent]' : ''));
  lines.push('');
  lines.push(`  Scanned ${result.scanned}   Flagged ${result.flagged} (${pct}%)   Clean ${result.clean}`);
  lines.push(`  People nudged ${plan.owners.length}   Ownerless -> group ${plan.group ? plan.group.count : 0}`);
  lines.push('');
  lines.push('BY ISSUE TYPE');
  for (const [r, n] of rules) {
    lines.push(`  ${(RULE_LABELS[r] || r).padEnd(30)} ${String(n).padStart(3)}  ${bar(n, maxRule)}`);
  }
  lines.push('');
  lines.push('WHO GETS A NUDGE');
  for (const o of plan.owners) {
    lines.push(`  ${o.recipient.padEnd(26)} ${String(o.count).padStart(3)} item(s)`);
  }
  if (plan.group) lines.push(`  ${('-> ' + plan.group.recipient).padEnd(26)} ${String(plan.group.count).padStart(3)} ownerless`);

  return { html, text: lines.join('\n') };
}

/** Compose the entire run: per-owner DMs, the group post, and the summary. */
function buildPlan(result, cfg, now = new Date()) {
  const stamp = now.toLocaleString('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
  }) + ' IST';

  const { owned, orphans } = groupByOwner(result.findings);
  const owners = [...owned.values()]
    .map((g) => buildOwnerDigest(g, cfg, stamp))
    .sort((a, b) => b.count - a.count);
  const group = buildGroupDigest(orphans, cfg, stamp, result.index);

  const plan = { owners, group, stamp };
  plan.summary = buildRunSummary(result, plan, cfg, stamp);
  return plan;
}

module.exports = { buildPlan, groupByOwner, buildOwnerDigest, buildGroupDigest, buildRunSummary, RULE_LABELS };

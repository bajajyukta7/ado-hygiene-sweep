'use strict';

/**
 * Turnstile hygiene rules engine.
 *
 * Pure functions over a normalised work-item shape. No network, no side effects,
 * so the whole rule set is unit-testable against fixtures.
 */

const IN_FLIGHT_DEFAULT = ['Active', 'Committed', 'In Progress'];

/**
 * A "bucket" is a container, not a deliverable — a Feature or Epic whose job is
 * to group the real work underneath it ("KTLO", "Customer Asks", "Analytics").
 * There is nothing to describe beyond the title, so demanding a description on
 * one is noise that never goes away.
 *
 * Detected structurally rather than by title: it holds children, and it is not
 * itself scheduled into a sprint.
 */
function isBucket(item, index, cfg) {
  const types = cfg.rules?.emptyDescription?.bucketTypes || ['Feature', 'Epic', 'Key Result'];
  if (!types.includes(item.type)) return false;
  if (!index.childCount.has(item.id)) return false;
  const iter = item.iterationPath || '';
  return !/Week \d/.test(iter);
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseTitle(title) {
  if (!title) return '';
  return String(title).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * ADO identity fields come in two shapes:
 *   - live REST: an object, { displayName, uniqueName, ... }
 *   - captured fixtures: a flattened string, "Name <email>"
 * Both are accepted so live runs and fixture runs resolve owners identically.
 */
function personName(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') {
    const name = raw.displayName || raw.uniqueName || raw.name || null;
    return name ? String(name).replace(/\s*<.*$/, '').trim() || null : null;
  }
  return String(raw).replace(/\s*<.*$/, '').trim() || null;
}

function personEmail(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') {
    const mail = raw.uniqueName || raw.mailAddress || raw.email || null;
    if (mail && String(mail).includes('@')) return String(mail).trim();
    const inner = String(raw.displayName || '').match(/<([^>]+)>/);
    return inner ? inner[1] : null;
  }
  const m = String(raw).match(/<([^>]+)>/);
  return m ? m[1] : null;
}

/** Turn a raw ADO work item into the flat shape the rules operate on. */
function normalise(item) {
  const f = item.fields || {};
  const val = (k) => {
    const v = f[k];
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    return v;
  };
  return {
    id: Number(item.id),
    type: val('System.WorkItemType'),
    title: val('System.Title'),
    state: val('System.State'),
    areaPath: val('System.AreaPath'),
    iterationPath: val('System.IterationPath'),
    assignedToRaw: val('System.AssignedTo'),
    createdByRaw: val('System.CreatedBy'),
    parentId: val('System.Parent') ? Number(val('System.Parent')) : null,
    description: stripHtml(val('System.Description')),
    acceptanceCriteria: stripHtml(val('Microsoft.VSTS.Common.AcceptanceCriteria')),
    targetDate: val('Microsoft.VSTS.Scheduling.TargetDate'),
    startDate: val('Microsoft.VSTS.Scheduling.StartDate'),
    stateChangeDate: val('Microsoft.VSTS.Common.StateChangeDate'),
    changedDate: val('System.ChangedDate'),
    originalEstimate: val('Microsoft.VSTS.Scheduling.OriginalEstimate'),
    remainingWork: val('Microsoft.VSTS.Scheduling.RemainingWork'),
    completedWork: val('Microsoft.VSTS.Scheduling.CompletedWork'),
  };
}

/** Pre-compute cross-item facts: child counts and duplicate-title clusters. */
function buildIndex(items, cfg) {
  const childCount = new Map();
  const byId = new Map();
  for (const it of items) byId.set(it.id, it);
  for (const it of items) {
    if (it.parentId) childCount.set(it.parentId, (childCount.get(it.parentId) || 0) + 1);
  }

  const minChars = cfg?.rules?.duplicateTitle?.minTitleChars ?? 12;
  // Two crews tracking the same work under their own area paths is deliberate,
  // so by default only titles colliding inside one area path count as duplicates.
  const sameAreaOnly = cfg?.rules?.duplicateTitle?.sameAreaPathOnly !== false;
  const groups = new Map();
  for (const it of items) {
    const title = normaliseTitle(it.title);
    if (title.length < minChars) continue;
    const key = sameAreaOnly ? `${it.areaPath || ''}||${title}` : title;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it.id);
  }
  const duplicates = new Map();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) duplicates.set(id, ids.filter((x) => x !== id));
  }

  return { byId, childCount, duplicates };
}

function appliesTo(rule, type) {
  if (rule.appliesToTypes && !rule.appliesToTypes.includes(type)) return false;
  if (rule.exemptTypes && rule.exemptTypes.includes(type)) return false;
  return true;
}

/**
 * Evaluate every enabled rule for one work item.
 * Returns an array of { rule, severity, detail, fix } gap objects.
 */
function evaluate(item, index, cfg, now = new Date(), calendar = null) {
  const R = cfg.rules;
  const inFlightStates = cfg.inFlightStates || IN_FLIGHT_DEFAULT;
  const isActive = inFlightStates.includes(item.state);

  // Sprint phase drives what we can fairly expect. A story sitting in a sprint
  // that has not started yet is not ungroomed — it is early.
  const phase = calendar ? calendar.phase(item.iterationPath, now) : null;
  const inSprint = phase
    ? (phase === 'current' || phase === 'past')
    : !!(item.iterationPath &&
        item.iterationPath !== cfg.azureDevOps.iterationRoot &&
        /Week \d/.test(item.iterationPath));

  // "In flight" = the team has committed to it, so it must be fully groomed.
  // Explicitly excludes work parked in a future sprint.
  const inFlight = (isActive || inSprint) && phase !== 'future';

  const gaps = [];
  const add = (rule, severity, detail, fix) => gaps.push({ rule, severity, detail, fix });

  if (R.noParent?.enabled && appliesTo(R.noParent, item.type) && !item.parentId) {
    add('noParent', 'high', 'No parent link',
      'Link it to its Feature/Epic so it rolls up in the shiproom view.');
  }

  if (R.emptyDescription?.enabled && appliesTo(R.emptyDescription, item.type) &&
      item.description.length < (R.emptyDescription.minChars ?? 15) &&
      !(R.emptyDescription.exemptBuckets !== false && isBucket(item, index, cfg))) {
    add('emptyDescription', 'medium', 'Empty description',
      'Add a couple of lines on what and why — the title alone will not survive handover.');
  }

  if (R.missingHours?.enabled && appliesTo(R.missingHours, item.type) &&
      (!R.missingHours.inFlightOnly || inFlight)) {
    const missing = [];
    if (item.originalEstimate == null) missing.push('Original Estimate');
    if (item.remainingWork == null) missing.push('Remaining Work');
    // Completed Work is only meaningful once the task has actually started —
    // asking for it on a New task is noise, and noise gets the bot muted.
    if (isActive && item.completedWork == null) missing.push('Completed Work');
    if (missing.length) {
      add('missingHours', 'medium', `Missing hours: ${missing.join(', ')}`,
        'Fill the hour fields so burndown and capacity stay honest.');
    }
  }

  if (R.unassigned?.enabled && appliesTo(R.unassigned, item.type) && !item.assignedToRaw) {
    // Backlog work does not need an owner yet. It needs one once the team has
    // committed to it, or once its due date is close enough to matter.
    const horizon = R.unassigned.dueSoonDays ?? 30;
    const daysToDue = item.targetDate
      ? Math.ceil((new Date(item.targetDate) - now) / 86400000)
      : null;
    const dueSoon = daysToDue !== null && daysToDue <= horizon;

    if (inFlight) {
      add('unassigned', 'high', 'Unassigned',
        'Set an owner, or move it out of the sprint if nobody is picking it up.');
    } else if (dueSoon) {
      const when = daysToDue < 0
        ? `${Math.abs(daysToDue)} days overdue`
        : `due in ${daysToDue} days`;
      add('unassigned', 'high', `Unassigned and ${when}`,
        'Deadline is close and nobody owns it — assign it or move the date.');
    }
    // Otherwise: unscheduled, no near deadline. Leave it alone.
  }

  if (R.missingDueDate?.enabled && appliesTo(R.missingDueDate, item.type) && !item.targetDate) {
    add('missingDueDate', 'high', 'No due date set',
      'Set a Target Date so it can be tracked against a commitment.');
  }

  if (R.duplicateTitle?.enabled && index.duplicates.has(item.id)) {
    const others = index.duplicates.get(item.id);
    add('duplicateTitle', 'medium',
      `Possible duplicate of ${others.map((x) => '#' + x).join(', ')}`,
      'Merge or close the redundant copy so effort is not double-counted.');
  }

  if (R.staleActive?.enabled && isActive && item.changedDate) {
    const days = Math.floor((now - new Date(item.changedDate)) / 86400000);
    if (days >= (R.staleActive.thresholdDays ?? 14)) {
      add('staleActive', 'high', `Active but untouched for ${days} days`,
        'Update the state, or move it back to New if it is not actually being worked.');
    }
  }

  if (R.rootAreaPath?.enabled &&
      (!item.areaPath || item.areaPath === cfg.azureDevOps.project)) {
    add('rootAreaPath', 'medium', 'Area Path left at project root',
      'Set a real area path so it reaches the right team backlog.');
  }

  if (R.notInSprint?.enabled && appliesTo(R.notInSprint, item.type) &&
      (!R.notInSprint.inFlightOnly || inFlight) && !inSprint && phase !== 'future') {
    add('notInSprint', 'medium', 'In flight but parked at the semester root, not a sprint',
      'Move it into the current bi-weekly iteration.');
  }

  if (R.blankAcceptance?.enabled && appliesTo(R.blankAcceptance, item.type) &&
      (!R.blankAcceptance.inFlightOnly || inFlight) &&
      item.acceptanceCriteria.length < (R.blankAcceptance.minChars ?? 10)) {
    add('blankAcceptance', 'medium', 'Blank acceptance criteria',
      'Write what "done" means before the work starts, not after.');
  }

  if (R.noChildTasks?.enabled && appliesTo(R.noChildTasks, item.type) &&
      !index.childCount.has(item.id)) {
    const changedStateAt = item.stateChangeDate ? new Date(item.stateChangeDate) : null;
    const daysInState = changedStateAt && !Number.isNaN(changedStateAt.getTime())
      ? Math.floor((now - changedStateAt) / 86400000)
      : null;
    const graceDays = R.noChildTasks.graceDays ?? 3;
    const eligible = !R.noChildTasks.inFlightOnly ||
      (isActive && daysInState !== null && daysInState >= graceDays);

    if (eligible) {
      add('noChildTasks', 'medium', 'No child tasks broken out',
        'Break it into tasks so progress is visible before the sprint ends.');
    }
  }

  return gaps;
}

/** Walk the configured resolution chain until an owner is found. */
function resolveOwner(item, index, cfg) {
  const order = cfg.routing?.ownerResolutionOrder || ['assignedTo'];
  for (const strategy of order) {
    let raw = null;
    let source = null;
    if (strategy === 'assignedTo') {
      raw = item.assignedToRaw; source = 'Assigned To';
    } else if (strategy === 'parentOwner' && item.parentId) {
      const parent = index.byId.get(item.parentId);
      raw = parent?.assignedToRaw; source = 'Parent owner';
    } else if (strategy === 'createdBy') {
      raw = item.createdByRaw; source = 'Created By';
    }
    if (raw) {
      return { name: personName(raw), email: personEmail(raw), source };
    }
  }
  return { name: null, email: null, source: 'unresolved' };
}

/** People configured out of the roster never receive a nudge. */
function isExcluded(owner, cfg) {
  const list = cfg.routing?.excludePeople || [];
  if (!list.length || !owner) return false;
  const name = (owner.name || '').toLowerCase();
  const mail = (owner.email || '').toLowerCase();
  return list.some((p) =>
    (p.email && mail && p.email.toLowerCase() === mail) ||
    (p.name && name && p.name.toLowerCase() === name)
  );
}

/** Run the full sweep. Returns findings plus roll-up stats. */
function scan(rawItems, cfg, now = new Date(), calendar = null) {
  const items = rawItems.map(normalise);
  const index = buildIndex(items, cfg);

  const findings = [];
  const excluded = [];
  for (const item of items) {
    const gaps = evaluate(item, index, cfg, now, calendar);
    if (!gaps.length) continue;
    const owner = resolveOwner(item, index, cfg);

    if (isExcluded(owner, cfg)) {
      excluded.push({ id: item.id, owner: owner.name });
      continue;
    }

    findings.push({
      id: item.id,
      type: item.type,
      title: item.title,
      state: item.state,
      parentId: item.parentId,
      iterationPath: item.iterationPath,
      targetDate: item.targetDate,
      owner,
      gaps,
      score: gaps.reduce((s, g) => s + (g.severity === 'high' ? 2 : 1), 0),
      url: `https://${cfg.azureDevOps.organization}.visualstudio.com/` +
           `${encodeURIComponent(cfg.azureDevOps.project)}/_workitems/edit/${item.id}`,
    });
  }

  findings.sort((a, b) => b.score - a.score || a.id - b.id);

  const byRule = {};
  for (const f of findings) {
    for (const g of f.gaps) byRule[g.rule] = (byRule[g.rule] || 0) + 1;
  }

  return {
    scanned: items.length,
    flagged: findings.length,
    clean: items.length - findings.length - excluded.length,
    excluded,
    byRule,
    findings,
    index,
  };
}

module.exports = {
  scan, evaluate, normalise, buildIndex, resolveOwner, isBucket, isExcluded,
  stripHtml, normaliseTitle, personName, personEmail,
};

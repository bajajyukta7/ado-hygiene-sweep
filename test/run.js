'use strict';

/**
 * Turnstile test suite. Plain Node, no framework — runs anywhere.
 *   node test/run.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { scan, normalise, buildIndex, evaluate, resolveOwner, isBucket } = require('../src/rules');
const { inScope, applyScope, applyStateFilter, applySemester } = require('../src/scope');
const { loadCalendar } = require('../src/sprints');
const { buildPlan, groupByOwner } = require('../src/digest');

// Tests pin to the sample config, never the user's personal config.json, so the
// suite gives the same result on a fresh clone as it does on a configured machine.
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'config.sample.json'), 'utf8'));

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  let result;
  try {
    result = fn();
  } catch (err) {
    failed++; console.log(`  FAIL  ${name}\n        ${err.message}`);
    return;
  }
  if (result && typeof result.then === 'function') {
    // Collect async tests so the runner can await them before exiting —
    // otherwise process.exit fires first and they are silently skipped.
    pending.push(result.then(
      () => { passed++; console.log(`  pass  ${name}`); },
      (err) => { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
    ));
    return;
  }
  passed++; console.log(`  pass  ${name}`);
}

function wi(id, fields) {
  return { id, fields: { 'System.Id': id, ...fields } };
}

const NOW = new Date('2026-09-17T00:00:00Z');

console.log('\nscope');

test('exact path matches, child path does not when includeChildren is false', () => {
  const s = [{ path: 'A\\B', includeChildren: false }];
  assert.strictEqual(inScope('A\\B', s), true);
  assert.strictEqual(inScope('A\\B\\C', s), false);
});

test('child path matches when includeChildren is true', () => {
  const s = [{ path: 'A\\B', includeChildren: true }];
  assert.strictEqual(inScope('A\\B\\C', s), true);
});

test('prefix lookalike is not treated as a child', () => {
  const s = [{ path: 'A\\Delivery', includeChildren: true }];
  assert.strictEqual(inScope('A\\DeliveryParity', s), false);
});

test('applyScope filters out-of-org items', () => {
  const items = [
    wi(1, { 'System.AreaPath': 'EC\\CloudPath\\Delivery' }),
    wi(2, { 'System.AreaPath': 'EC\\CloudPath\\Monitoring' }),
  ];
  const kept = applyScope(items, [{ path: 'EC\\CloudPath\\Delivery', includeChildren: false }]);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].id, 1);
});

test('closed work is never nagged about', () => {
  const items = [
    wi(1, { 'System.State': 'Active', 'System.WorkItemType': 'Task' }),
    wi(2, { 'System.State': 'Closed', 'System.WorkItemType': 'Task' }),
    wi(3, { 'System.State': 'Completed', 'System.WorkItemType': 'Task' }),
    wi(4, { 'System.State': 'New', 'System.WorkItemType': 'Objective' }),
  ];
  const kept = applyStateFilter(items, cfg);
  assert.deepStrictEqual(kept.map((k) => k.id), [1],
    'closed states and excluded types must be dropped before the rules run');
});

test('refuses to run when cached scope belongs to another team', async () => {
  const { resolveScope } = require('../src/scope');
  const wrongTeam = {
    ...cfg,
    azureDevOps: {
      ...cfg.azureDevOps,
      team: 'Someone Else Crew',
      areaPaths: [],
      areaPathsCacheTeam: 'Cached Owner Crew',
      areaPathsCache: [{ path: 'EC\\CloudPath\\Delivery', includeChildren: true }],
    },
  };
  let threw = false;
  try {
    await resolveScope(null, wrongTeam, { live: false });
  } catch (err) {
    threw = true;
    assert.ok(/Refusing to run/.test(err.message));
    assert.ok(/Cached Owner Crew/.test(err.message), 'error should name the cached team');
  }
  assert.ok(threw, 'silently sweeping another team\'s areas is worse than failing');
});

test('fails loudly when no scope can be resolved at all', async () => {
  const { resolveScope } = require('../src/scope');
  const noScope = {
    ...cfg,
    azureDevOps: {
      ...cfg.azureDevOps,
      team: 'Unconfigured Crew',
      areaPaths: [],
      areaPathsCacheTeam: '',
      areaPathsCache: [],
    },
  };
  let threw = false;
  try {
    await resolveScope(null, noScope, { live: false });
  } catch (err) {
    threw = true;
    assert.ok(/No scope available/.test(err.message));
  }
  assert.ok(threw, 'a fresh install with no cache must fail rather than scan nothing');
});

test('an explicit areaPaths override bypasses the team guard', async () => {
  const { resolveScope } = require('../src/scope');
  const overridden = {
    ...cfg,
    azureDevOps: {
      ...cfg.azureDevOps,
      team: 'Someone Else Crew',
      areaPaths: [{ path: 'EC\\Their\\Area', includeChildren: true }],
    },
  };
  const scope = await resolveScope(null, overridden, { live: false });
  assert.strictEqual(scope.entries.length, 1);
  assert.ok(/override/.test(scope.source));
});

console.log('\nrules');

test('unassigned item in the current sprint is flagged', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Parent': 9,
    'System.IterationPath': cfg.azureDevOps.iterationRoot + '\\CY26-H2-Q3\\Week 37 - 38',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  assert.ok(gaps.some((g) => g.rule === 'unassigned'));
});

test('assigned item is not flagged as unassigned', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'Task', 'System.State': 'New',
    'System.AssignedTo': 'Ada Lovelace <ada@example.com>', 'System.Parent': 9,
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  assert.ok(!gaps.some((g) => g.rule === 'unassigned'));
});

test('Task is exempt from the description rule', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'Task', 'System.State': 'New',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  assert.ok(!gaps.some((g) => g.rule === 'emptyDescription'));
});

test('User Story with no description is flagged', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'User Story', 'System.State': 'New',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  assert.ok(gaps.some((g) => g.rule === 'emptyDescription'));
});

test('Features, Epics, OKRs and Tasks never need a description', () => {
  for (const type of ['Feature', 'Epic', 'Key Result', 'Objective', 'Task']) {
    const items = [normalise(wi(1, {
      'System.WorkItemType': type, 'System.State': 'Active',
      'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
      'System.IterationPath': cfg.azureDevOps.iterationRoot + '\\CY26-H2-Q3\\Week 37 - 38',
      'Microsoft.VSTS.Scheduling.TargetDate': '2026-10-01T00:00:00Z',
    }))];
    const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
    assert.ok(!gaps.some((g) => g.rule === 'emptyDescription'),
      `${type} should be exempt from the description rule`);
  }
});

console.log('\ndue dates');

test('a Feature with no due date is flagged', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'Feature', 'System.State': 'Active',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  assert.ok(gaps.some((g) => g.rule === 'missingDueDate'));
});

test('a Feature with a due date is not flagged', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'Feature', 'System.State': 'Active',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'Microsoft.VSTS.Scheduling.TargetDate': '2026-12-01T00:00:00Z',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  assert.ok(!gaps.some((g) => g.rule === 'missingDueDate'));
});

test('only Features are asked for a due date', () => {
  for (const type of ['User Story', 'Task', 'Epic', 'Key Result']) {
    const items = [normalise(wi(1, {
      'System.WorkItemType': type, 'System.State': 'New',
      'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    }))];
    const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
    assert.ok(!gaps.some((g) => g.rule === 'missingDueDate'),
      `${type} should not be asked for a due date`);
  }
});

console.log('\nunassigned is deadline-aware');

test('backlog work with no sprint and no deadline is left alone', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'User Story', 'System.State': 'New',
    'System.Parent': 9, 'System.Description': 'Properly written description here.',
    'Microsoft.VSTS.Common.AcceptanceCriteria': 'Given when then.',
    'System.IterationPath': cfg.azureDevOps.iterationRoot,
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  assert.ok(!gaps.some((g) => g.rule === 'unassigned'),
    'unscheduled backlog does not need an owner yet');
});

test('unassigned IS flagged when the due date is within 30 days', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'User Story', 'System.State': 'New',
    'System.Parent': 9, 'System.Description': 'Properly written description here.',
    'Microsoft.VSTS.Common.AcceptanceCriteria': 'Given when then.',
    'System.IterationPath': cfg.azureDevOps.iterationRoot,
    'Microsoft.VSTS.Scheduling.TargetDate': '2026-10-05T00:00:00Z',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  const hit = gaps.find((g) => g.rule === 'unassigned');
  assert.ok(hit, 'a deadline 18 days out with no owner should be flagged');
  assert.ok(/due in \d+ days/.test(hit.detail), `expected a countdown, got: ${hit.detail}`);
});

test('unassigned is NOT flagged when the due date is far out', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'User Story', 'System.State': 'New',
    'System.Parent': 9, 'System.Description': 'Properly written description here.',
    'Microsoft.VSTS.Common.AcceptanceCriteria': 'Given when then.',
    'System.IterationPath': cfg.azureDevOps.iterationRoot,
    'Microsoft.VSTS.Scheduling.TargetDate': '2027-06-01T00:00:00Z',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  assert.ok(!gaps.some((g) => g.rule === 'unassigned'));
});

test('an overdue unassigned item reports how late it is', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'User Story', 'System.State': 'New',
    'System.Parent': 9, 'System.Description': 'Properly written description here.',
    'Microsoft.VSTS.Common.AcceptanceCriteria': 'Given when then.',
    'System.IterationPath': cfg.azureDevOps.iterationRoot,
    'Microsoft.VSTS.Scheduling.TargetDate': '2026-08-01T00:00:00Z',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  const hit = gaps.find((g) => g.rule === 'unassigned');
  assert.ok(hit && /overdue/.test(hit.detail), `expected overdue wording, got: ${hit && hit.detail}`);
});

test('in-flight work still needs an owner regardless of due date', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'User Story', 'System.State': 'Active',
    'System.Parent': 9, 'System.Description': 'Properly written description here.',
    'Microsoft.VSTS.Common.AcceptanceCriteria': 'Given when then.',
    'System.IterationPath': cfg.azureDevOps.iterationRoot + '\\CY26-H2-Q3\\Week 37 - 38',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  assert.ok(gaps.some((g) => g.rule === 'unassigned'));
});

console.log('\nidentity shapes');

test('live REST identity objects resolve to a real owner, not [object Object]', () => {
  const item = normalise(wi(1, {
    'System.WorkItemType': 'Feature', 'System.State': 'Active',
    'System.Title': 'Live shaped identity', 'System.Parent': 9,
    'System.AssignedTo': {
      displayName: 'Ada Lovelace',
      uniqueName: 'ada@example.com',
      id: '00000000-0000-0000-0000-000000000001',
    },
  }));
  const owner = resolveOwner(item, buildIndex([item], cfg), cfg);
  assert.strictEqual(owner.name, 'Ada Lovelace');
  assert.strictEqual(owner.email, 'ada@example.com');
});

test('two distinct identity objects do not collapse into one owner', () => {
  const mk = (id, name, mail) => wi(id, {
    'System.WorkItemType': 'Feature', 'System.State': 'Active',
    'System.Title': `Feature ${id} needing a target date`, 'System.Parent': 9,
    'System.AreaPath': 'EC\\CloudPath\\Delivery',
    'System.AssignedTo': { displayName: name, uniqueName: mail },
  });
  const result = scan([mk(1, 'Ada Lovelace', 'ada@x.com'), mk(2, 'Grace Murray', 'grace@x.com')], cfg, NOW);
  const plan = buildPlan(result, cfg, NOW);
  const names = new Set(result.findings.map((f) => f.owner.name));
  assert.strictEqual(names.size, 2, 'each identity must stay its own owner');
  assert.ok(!JSON.stringify(plan).includes('[object Object]'));
});

test('flattened fixture identity strings still work', () => {
  const item = normalise(wi(1, {
    'System.WorkItemType': 'Feature', 'System.State': 'Active',
    'System.Title': 'Fixture shaped identity', 'System.Parent': 9,
    'System.AssignedTo': 'Ada Lovelace <ada@example.com>',
  }));
  const owner = resolveOwner(item, buildIndex([item], cfg), cfg);
  assert.strictEqual(owner.name, 'Ada Lovelace');
  assert.strictEqual(owner.email, 'ada@example.com');
});

console.log('\nroster exclusions');

test('excluded people are dropped, not rerouted to the group', () => {
  const raw = [
    wi(1, {
      'System.WorkItemType': 'Feature', 'System.State': 'Active',
      'System.Title': 'Excluded persons feature', 'System.Parent': 9,
      'System.AreaPath': 'EC\\CloudPath\\Delivery',
      'System.AssignedTo': 'Grace Hopper <grace.hopper@example.com>',
    }),
    wi(2, {
      'System.WorkItemType': 'Feature', 'System.State': 'Active',
      'System.Title': 'Included persons feature', 'System.Parent': 9,
      'System.AreaPath': 'EC\\CloudPath\\Delivery',
      'System.AssignedTo': 'Ada Lovelace <ada@x.com>',
    }),
  ];
  const result = scan(raw, cfg, NOW);
  assert.strictEqual(result.flagged, 1, 'only the non-excluded person should be flagged');
  assert.strictEqual(result.findings[0].owner.name, 'Ada Lovelace');
  assert.strictEqual(result.excluded.length, 1);
  assert.strictEqual(result.excluded[0].owner, 'Grace Hopper');

  const plan = buildPlan(result, cfg, NOW);
  const everyone = JSON.stringify(plan);
  assert.ok(!everyone.includes('Grace'), 'excluded person must not appear anywhere in the plan');
});

test('html is stripped before the description length check', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'User Story', 'System.State': 'New',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'System.Description': '<div><p>&nbsp;</p></div>',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  assert.ok(gaps.some((g) => g.rule === 'emptyDescription'),
    'whitespace-only html should still count as empty');
});

test('missing hours only applies to in-flight Tasks', () => {
  const idle = [normalise(wi(1, {
    'System.WorkItemType': 'Task', 'System.State': 'New',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'System.IterationPath': cfg.azureDevOps.iterationRoot,
  }))];
  assert.ok(!evaluate(idle[0], buildIndex(idle, cfg), cfg, NOW).some((g) => g.rule === 'missingHours'));

  const live = [normalise(wi(2, {
    'System.WorkItemType': 'Task', 'System.State': 'Active',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'System.IterationPath': cfg.azureDevOps.iterationRoot + '\\CY26-H2-Q3\\Week 37 - 38',
  }))];
  assert.ok(evaluate(live[0], buildIndex(live, cfg), cfg, NOW).some((g) => g.rule === 'missingHours'));
});

test('Completed Work is not demanded on a task that has not started', () => {
  const notStarted = [normalise(wi(1, {
    'System.WorkItemType': 'Task', 'System.State': 'New',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'System.IterationPath': cfg.azureDevOps.iterationRoot + '\\CY26-H2-Q3\\Week 37 - 38',
    'Microsoft.VSTS.Scheduling.OriginalEstimate': 8,
    'Microsoft.VSTS.Scheduling.RemainingWork': 8,
  }))];
  const gaps = evaluate(notStarted[0], buildIndex(notStarted, cfg), cfg, NOW);
  assert.ok(!gaps.some((g) => g.rule === 'missingHours'),
    'a sprint-committed but unstarted task with estimates should be silent');

  const started = [normalise(wi(2, {
    'System.WorkItemType': 'Task', 'System.State': 'Active',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'System.IterationPath': cfg.azureDevOps.iterationRoot + '\\CY26-H2-Q3\\Week 37 - 38',
    'System.ChangedDate': '2026-09-16T00:00:00Z',
    'Microsoft.VSTS.Scheduling.OriginalEstimate': 8,
    'Microsoft.VSTS.Scheduling.RemainingWork': 8,
  }))];
  const startedGaps = evaluate(started[0], buildIndex(started, cfg), cfg, NOW);
  assert.ok(startedGaps.some((g) => g.rule === 'missingHours' && /Completed Work/.test(g.detail)),
    'once Active, Completed Work is expected');
});

test('stale only fires for Active items past the threshold', () => {
  // staleActive ships disabled; enable it locally so the rule logic stays covered.
  const staleCfg = { ...cfg, rules: { ...cfg.rules, staleActive: { enabled: true, thresholdDays: 14 } } };
  const mk = (state, iso) => normalise(wi(1, {
    'System.WorkItemType': 'Task', 'System.State': state,
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'System.ChangedDate': iso,
  }));
  const old = '2026-08-01T00:00:00Z';
  const activeOld = mk('Active', old);
  assert.ok(evaluate(activeOld, buildIndex([activeOld], staleCfg), staleCfg, NOW).some((g) => g.rule === 'staleActive'));

  const newOld = mk('New', old);
  assert.ok(!evaluate(newOld, buildIndex([newOld], staleCfg), staleCfg, NOW).some((g) => g.rule === 'staleActive'),
    'a New item sitting in the backlog is not stale, it is just a backlog item');

  const activeFresh = mk('Active', '2026-09-16T00:00:00Z');
  assert.ok(!evaluate(activeFresh, buildIndex([activeFresh], staleCfg), staleCfg, NOW).some((g) => g.rule === 'staleActive'));
});

test('staleActive is disabled in shipped config', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'Task', 'System.State': 'Active',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'System.ChangedDate': '2026-01-01T00:00:00Z',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  assert.ok(!gaps.some((g) => g.rule === 'staleActive'),
    'shipped config should not emit stale findings');
});

test('duplicate titles are matched after normalisation', () => {
  const items = [
    wi(1, { 'System.Title': 'Enable Geneva replication for EU', 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9 }),
    wi(2, { 'System.Title': 'enable geneva REPLICATION for eu!!', 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9 }),
  ].map(normalise);
  const idx = buildIndex(items, cfg);
  assert.ok(evaluate(items[0], idx, cfg, NOW).some((g) => g.rule === 'duplicateTitle'));
  assert.ok(evaluate(items[1], idx, cfg, NOW).some((g) => g.rule === 'duplicateTitle'));
});

test('short titles are not duplicate-matched', () => {
  const items = [
    wi(1, { 'System.Title': 'Fix', 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9 }),
    wi(2, { 'System.Title': 'Fix', 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9 }),
  ].map(normalise);
  const idx = buildIndex(items, cfg);
  assert.ok(!evaluate(items[0], idx, cfg, NOW).some((g) => g.rule === 'duplicateTitle'));
});

test('a fully clean item produces no gaps', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'Task', 'System.State': 'Active',
    'System.AssignedTo': 'A <a@x.com>', 'System.CreatedBy': 'A <a@x.com>',
    'System.Parent': 9,
    'System.AreaPath': 'EC\\CloudPath\\Delivery',
    'System.IterationPath': cfg.azureDevOps.iterationRoot + '\\CY26-H2-Q3\\Week 37 - 38',
    'System.ChangedDate': '2026-09-16T00:00:00Z',
    'Microsoft.VSTS.Scheduling.OriginalEstimate': 8,
    'Microsoft.VSTS.Scheduling.RemainingWork': 4,
    'Microsoft.VSTS.Scheduling.CompletedWork': 4,
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW);
  assert.deepStrictEqual(gaps, [], 'clean item should be silent, got: ' + JSON.stringify(gaps));
});

test('bucket containers are exempt from the description rule', () => {
  // A Feature that holds children and is not itself in a sprint = a container.
  const items = [
    wi(1, {
      'System.WorkItemType': 'Feature', 'System.State': 'Active',
      'System.Title': 'KTLO', 'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 99,
      'System.IterationPath': cfg.azureDevOps.iterationRoot,
    }),
    wi(2, { 'System.Parent': 1, 'System.WorkItemType': 'User Story', 'System.State': 'New', 'System.AssignedTo': 'A <a@x.com>' }),
  ].map(normalise);
  const idx = buildIndex(items, cfg);
  assert.ok(isBucket(items[0], idx, cfg), 'Feature with children and no sprint is a bucket');
  assert.ok(!evaluate(items[0], idx, cfg, NOW).some((g) => g.rule === 'emptyDescription'));
});

test('a childless Feature is not a bucket', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'Feature', 'System.State': 'Active',
    'System.Title': 'Real deliverable', 'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 99,
    'System.IterationPath': cfg.azureDevOps.iterationRoot,
  }))];
  const idx = buildIndex(items, cfg);
  assert.ok(!isBucket(items[0], idx, cfg), 'no children means it is not a container');
});

test('a Feature scheduled into a sprint is real work, not a bucket', () => {
  const items = [
    wi(1, {
      'System.WorkItemType': 'Feature', 'System.State': 'Active',
      'System.Title': 'Scheduled feature', 'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 99,
      'System.IterationPath': cfg.azureDevOps.iterationRoot + '\\CY26-H2-Q3\\Week 37 - 38',
    }),
    wi(2, { 'System.Parent': 1, 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.AssignedTo': 'A <a@x.com>' }),
  ].map(normalise);
  const idx = buildIndex(items, cfg);
  assert.ok(!isBucket(items[0], idx, cfg), 'being in a sprint means it is committed work');
});

console.log('\nsprint awareness');

const CAL = loadCalendar([
  { name: 'Week 35 - 36', path: 'EC\\It\\Week 35 - 36', startDate: '2026-08-26T00:00:00Z', finishDate: '2026-09-08T00:00:00Z' },
  { name: 'Week 37 - 38', path: 'EC\\It\\Week 37 - 38', startDate: '2026-09-09T00:00:00Z', finishDate: '2026-09-22T00:00:00Z' },
  { name: 'Week 39 - 40', path: 'EC\\It\\Week 39 - 40', startDate: '2026-09-23T00:00:00Z', finishDate: '2026-10-06T00:00:00Z' },
]);

test('calendar classifies past, current and future sprints', () => {
  assert.strictEqual(CAL.phase('EC\\It\\Week 35 - 36', NOW), 'past');
  assert.strictEqual(CAL.phase('EC\\It\\Week 37 - 38', NOW), 'current');
  assert.strictEqual(CAL.phase('EC\\It\\Week 39 - 40', NOW), 'future');
  assert.strictEqual(CAL.phase('EC\\It', NOW), 'none');
  assert.strictEqual(CAL.current(NOW).name, 'Week 37 - 38');
});

test('a story in a FUTURE sprint is not asked for child tasks', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'User Story', 'System.State': 'New',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'System.Description': 'A properly written description of the work.',
    'Microsoft.VSTS.Common.AcceptanceCriteria': 'Given when then, spelled out.',
    'System.IterationPath': 'EC\\It\\Week 39 - 40',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW, CAL);
  assert.ok(!gaps.some((g) => g.rule === 'noChildTasks'),
    'next sprint has not been groomed yet, and that is fine');
});

test('a story with no sprint at all is not asked for child tasks', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'User Story', 'System.State': 'New',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'System.Description': 'A properly written description of the work.',
    'Microsoft.VSTS.Common.AcceptanceCriteria': 'Given when then, spelled out.',
    'System.IterationPath': 'EC\\It',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW, CAL);
  assert.ok(!gaps.some((g) => g.rule === 'noChildTasks'),
    'unscheduled backlog is allowed to be rough');
});

test('a New story in the CURRENT sprint is not asked for child tasks', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'User Story', 'System.State': 'New',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'System.Description': 'A properly written description of the work.',
    'Microsoft.VSTS.Common.AcceptanceCriteria': 'Given when then, spelled out.',
    'System.IterationPath': 'EC\\It\\Week 37 - 38',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW, CAL);
  assert.ok(!gaps.some((g) => g.rule === 'noChildTasks'),
    'sprint membership alone should not trigger child-task nudges');
});

test('an Active story inside the grace period is not asked for child tasks', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'User Story', 'System.State': 'Active',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'System.Description': 'A properly written description of the work.',
    'Microsoft.VSTS.Common.AcceptanceCriteria': 'Given when then, spelled out.',
    'Microsoft.VSTS.Common.StateChangeDate': '2026-09-15T00:00:00Z',
    'System.IterationPath': 'EC\\It\\Week 37 - 38',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW, CAL);
  assert.ok(!gaps.some((g) => g.rule === 'noChildTasks'),
    'newly-active stories get the configured grace period before being chased');
});

test('an Active story past the grace period is asked for child tasks', () => {
  const items = [normalise(wi(1, {
    'System.WorkItemType': 'User Story', 'System.State': 'Active',
    'System.AssignedTo': 'A <a@x.com>', 'System.Parent': 9,
    'System.Description': 'A properly written description of the work.',
    'Microsoft.VSTS.Common.AcceptanceCriteria': 'Given when then, spelled out.',
    'Microsoft.VSTS.Common.StateChangeDate': '2026-09-13T00:00:00Z',
    'System.IterationPath': 'EC\\It\\Week 37 - 38',
  }))];
  const gaps = evaluate(items[0], buildIndex(items, cfg), cfg, NOW, CAL);
  assert.ok(gaps.some((g) => g.rule === 'noChildTasks'),
    'stories Active for at least graceDays should be broken down');
});

console.log('\nsemester resolution');

const { AdoClient } = require('../src/ado');
const SEM_CLIENT = new AdoClient('org', 'proj');
const SEM_ITERS = [
  { name: 'Week 25 - 26', path: 'EC\\Bi-Weekly\\CY26\\CY26-H1\\Q2\\Week 25 - 26', startDate: '2026-06-17T00:00:00Z', finishDate: '2026-06-30T00:00:00Z' },
  { name: 'Week 37 - 38', path: 'EC\\Bi-Weekly\\CY26\\CY26-H2\\Q3\\Week 37 - 38', startDate: '2026-09-09T00:00:00Z', finishDate: '2026-09-22T00:00:00Z' },
  { name: 'Week 39 - 40', path: 'EC\\Bi-Weekly\\CY26\\CY26-H2\\Q3\\Week 39 - 40', startDate: '2026-09-23T00:00:00Z', finishDate: '2026-10-06T00:00:00Z' },
];

test('auto picks the semester containing today', () => {
  const sem = SEM_CLIENT.resolveSemester(SEM_ITERS, 'auto', NOW);
  assert.strictEqual(sem.name, 'CY26-H2');
  assert.strictEqual(sem.path, 'EC\\Bi-Weekly\\CY26\\CY26-H2');
  assert.ok(/auto/.test(sem.source));
});

test('auto rolls over when the date moves into the next semester', () => {
  const earlier = SEM_CLIENT.resolveSemester(SEM_ITERS, 'auto', new Date('2026-06-20T00:00:00Z'));
  assert.strictEqual(earlier.name, 'CY26-H1',
    'a June date should resolve to H1 without any config change');
});

test('an explicit semester name overrides auto-detection', () => {
  const sem = SEM_CLIENT.resolveSemester(SEM_ITERS, 'CY26-H1', NOW);
  assert.strictEqual(sem.name, 'CY26-H1');
  assert.strictEqual(sem.path, 'EC\\Bi-Weekly\\CY26\\CY26-H1');
});

test('a full semester path is accepted verbatim', () => {
  const sem = SEM_CLIENT.resolveSemester(SEM_ITERS, 'EC\\Bi-Weekly\\CY26\\CY26-H2', NOW);
  assert.strictEqual(sem.path, 'EC\\Bi-Weekly\\CY26\\CY26-H2');
});

test('items outside the chosen semester are filtered out', () => {
  const items = [
    wi(1, { 'System.IterationPath': 'EC\\Bi-Weekly\\CY26\\CY26-H2\\Q3\\Week 37 - 38' }),
    wi(2, { 'System.IterationPath': 'EC\\Bi-Weekly\\CY26\\CY26-H1\\Q2\\Week 25 - 26' }),
    wi(3, { 'System.IterationPath': 'EC\\Bi-Weekly\\CY26\\CY26-H2' }),
  ];
  const kept = applySemester(items, 'EC\\Bi-Weekly\\CY26\\CY26-H2');
  assert.deepStrictEqual(kept.map((k) => k.id), [1, 3]);
});

console.log('\nowner routing');

test('assignedTo wins over creator', () => {
  const items = [normalise(wi(1, {
    'System.AssignedTo': 'Ada <ada@x.com>', 'System.CreatedBy': 'Bob <bob@x.com>',
  }))];
  const o = resolveOwner(items[0], buildIndex(items, cfg), cfg);
  assert.strictEqual(o.email, 'ada@x.com');
  assert.strictEqual(o.source, 'Assigned To');
});

test('unassigned item is NOT blamed on the parent owner', () => {
  const items = [
    wi(1, { 'System.Parent': 2 }),
    wi(2, { 'System.AssignedTo': 'Ada <ada@x.com>' }),
  ].map(normalise);
  const o = resolveOwner(items[0], buildIndex(items, cfg), cfg);
  assert.strictEqual(o.name, null,
    'owning the parent does not make you the owner of an unassigned child');
  assert.strictEqual(o.source, 'unresolved');
});

test('unassigned item is NOT blamed on its creator', () => {
  const items = [normalise(wi(1, { 'System.CreatedBy': 'Bob <bob@x.com>' }))];
  const o = resolveOwner(items[0], buildIndex(items, cfg), cfg);
  assert.strictEqual(o.name, null, 'filing a work item is not the same as owning it');
  assert.strictEqual(o.source, 'unresolved');
});

test('fallback chain still works when explicitly configured', () => {
  const fallbackCfg = {
    ...cfg,
    routing: { ...cfg.routing, ownerResolutionOrder: ['assignedTo', 'parentOwner', 'createdBy'] },
  };
  const items = [
    wi(1, { 'System.Parent': 2 }),
    wi(2, { 'System.AssignedTo': 'Ada <ada@x.com>' }),
  ].map(normalise);
  const o = resolveOwner(items[0], buildIndex(items, fallbackCfg), fallbackCfg);
  assert.strictEqual(o.source, 'Parent owner');
});

test('truly ownerless items report unresolved', () => {
  const items = [normalise(wi(1, {}))];
  const o = resolveOwner(items[0], buildIndex(items, cfg), cfg);
  assert.strictEqual(o.name, null);
  assert.strictEqual(o.source, 'unresolved');
});

console.log('\ndigest');

test('each person gets exactly one message', () => {
  const mk = (id) => ({
    id, type: 'Task', state: 'New', url: '#', score: 2,
    gaps: [{ rule: 'unassigned', detail: 'x', fix: 'y', severity: 'high' }],
    owner: { name: 'Ada', email: 'ada@x.com', source: 'Assigned To' },
  });
  const { owned } = groupByOwner([mk(1), mk(2)]);
  assert.strictEqual(owned.size, 1);
  assert.strictEqual([...owned.values()][0].items.length, 2);
});

test('ownerless items route to the group, not to a DM', () => {
  const findings = [{
    id: 3, type: 'Task', state: 'New', url: '#', score: 2,
    gaps: [{ rule: 'unassigned', detail: 'x', fix: 'y', severity: 'high' }],
    owner: { name: null, email: null, source: 'unresolved' },
  }];
  const { owned, orphans } = groupByOwner(findings);
  assert.strictEqual(owned.size, 0);
  assert.strictEqual(orphans.length, 1);
});

test('a clean run produces no messages at all', () => {
  const plan = buildPlan({ scanned: 10, flagged: 0, clean: 10, byRule: {}, findings: [] }, cfg, NOW);
  assert.strictEqual(plan.owners.length, 0);
  assert.strictEqual(plan.group, null);
});

test('every item in every message carries a clickable link', () => {
  const mk = (id, ownerName) => ({
    id, type: 'Task', state: 'New', parentId: 500,
    title: `Item ${id} that needs attention`,
    url: `https://example-org.visualstudio.com/Sample%20Project/_workitems/edit/${id}`,
    score: 2,
    gaps: [{ rule: 'unassigned', detail: 'Unassigned', fix: 'Set an owner.', severity: 'high' }],
    owner: ownerName
      ? { name: ownerName, email: 'ada@x.com', source: 'Assigned To' }
      : { name: null, email: null, source: 'unresolved' },
  });

  const findings = [mk(101, 'Ada'), mk(102, 'Ada'), mk(201), mk(202), mk(203), mk(204)];
  const index = { byId: new Map([[500, { id: 500, title: 'Parent bucket', type: 'Feature' }]]) };
  const plan = buildPlan({ scanned: 6, flagged: 6, clean: 0, byRule: {}, findings, index }, cfg, NOW);

  for (const owner of plan.owners) {
    for (const f of [101, 102]) {
      assert.ok(owner.html.includes(`_workitems/edit/${f}`), `DM html missing link for #${f}`);
      assert.ok(owner.text.includes(`_workitems/edit/${f}`), `DM text missing link for #${f}`);
    }
  }

  assert.ok(plan.group, 'ownerless items should produce a group post');
  for (const id of [201, 202, 203, 204]) {
    assert.ok(plan.group.html.includes(`_workitems/edit/${id}`), `group html missing link for #${id}`);
    assert.ok(plan.group.text.includes(`_workitems/edit/${id}`), `group text missing link for #${id}`);
  }
  // Batched clusters must still name each item, not just its id.
  assert.ok(plan.group.html.includes('Item 201 that needs attention'),
    'batched cluster should show titles, not bare ids');
});

console.log('\nend to end (real captured data)');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'enterprise-cloud-cy26h2.json');
if (fs.existsSync(fixturePath)) {
  const captured = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  test('scope filter removes out-of-org area paths', () => {
    const scoped = applyScope(captured, cfg.azureDevOps.areaPathsCache);
    assert.ok(scoped.length > 0 && scoped.length < captured.length);
    for (const it of scoped) {
      assert.ok(inScope(it.fields['System.AreaPath'], cfg.azureDevOps.areaPathsCache));
    }
  });

  test('full sweep runs and every finding carries at least one gap', () => {
    const scoped = applyScope(captured, cfg.azureDevOps.areaPathsCache);
    const result = scan(scoped, cfg, NOW);
    assert.strictEqual(result.scanned, scoped.length);
    assert.strictEqual(result.flagged + result.clean + result.excluded.length, result.scanned,
      'every scanned item is flagged, clean, or excluded — nothing vanishes');
    for (const f of result.findings) {
      assert.ok(f.gaps.length > 0, `#${f.id} flagged with no gaps`);
      assert.ok(f.url.includes(String(f.id)));
    }
  });

  test('nobody on the exclusion roster appears in the real sweep', () => {
    const scoped = applyScope(captured, cfg.azureDevOps.areaPathsCache);
    const result = scan(scoped, cfg, NOW);
    const plan = buildPlan(result, cfg, NOW);
    for (const person of cfg.routing.excludePeople || []) {
      assert.ok(!plan.owners.some((o) => o.recipient === person.name),
        `${person.name} is on the exclusion roster but still received a digest`);
    }
  });

  test('plan covers every finding exactly once', () => {
    const scoped = applyScope(captured, cfg.azureDevOps.areaPathsCache);
    const result = scan(scoped, cfg, NOW);
    const plan = buildPlan(result, cfg, NOW);
    const routed = plan.owners.reduce((s, o) => s + o.count, 0) + (plan.group ? plan.group.count : 0);
    assert.strictEqual(routed, result.flagged,
      `routed ${routed} but flagged ${result.flagged} — every item must land somewhere, exactly once`);
  });
} else {
  console.log('  skip  fixture not present');
}

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
});

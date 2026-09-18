#!/usr/bin/env node
'use strict';

/**
 * Turnstile — ADO hygiene sweep.
 *
 * Operation Crowd, decoded: the backlog is the crowd, the single reviewer is the
 * doorway. You cannot widen the doorway, so you stop queueing everyone at it —
 * each item is routed straight to the person who can clear it.
 *
 * Usage:
 *   node src/index.js                      live scan, dry-run per config
 *   node src/index.js --fixture <file>     scan captured data (no auth needed)
 *   node src/index.js --manager "Name" --team "Team"
 *   node src/index.js --send               actually deliver messages
 */

const fs = require('fs');
const path = require('path');
const { AdoClient } = require('./ado');
const { scan } = require('./rules');
const { buildPlan } = require('./digest');
const { applyScope, applyStateFilter, applySemester, resolveScope } = require('./scope');
const { loadCalendar } = require('./sprints');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = { flags: new Set(), opts: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args.opts[key] = next; i++; }
      else args.flags.add(key);
    }
  }
  return args;
}

function loadConfig(args) {
  const file = args.opts.config || path.join(ROOT, 'config', 'config.json');
  let cfg;
  try {
    // Strip a UTF-8 BOM: editing config in PowerShell or Notepad adds one,
    // and JSON.parse rejects it with a message that names no file.
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    cfg = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Config not found at ${file}`);
    }
    throw new Error(
      `Could not parse ${file}\n` +
      `  ${err.message}\n` +
      `  Check for a trailing comma or an unescaped backslash — paths need double backslashes, e.g. "Sample Project\\\\CloudPath\\\\Delivery".`
    );
  }
  cfg.$configFile = file;
  if (args.opts.manager) cfg.manager.displayName = args.opts.manager;
  if (args.opts.team) cfg.azureDevOps.team = args.opts.team;
  if (args.opts.project) cfg.azureDevOps.project = args.opts.project;
  if (args.opts.semester) cfg.azureDevOps.semester = args.opts.semester;
  if (args.opts.areas) {
    cfg.azureDevOps.areaPaths = args.opts.areas.split(';')
      .map((s) => s.trim()).filter(Boolean)
      .map((p) => ({ path: p, includeChildren: true }));
  }
  if (args.flags.has('send')) cfg.safety.dryRun = false;
  if (args.flags.has('dry-run')) cfg.safety.dryRun = true;
  return cfg;
}

/** Strip the MCP provenance banners that wrap captured tool output. */
function readFixture(file) {
  let raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  raw = raw.replace(/^<<[0-9a-f]+>>.*$/gm, '').replace(/^<<\/[0-9a-f]+>>.*$/gm, '');
  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s === -1) throw new Error(`No JSON array found in fixture ${file}`);
  return JSON.parse(raw.slice(s, e + 1));
}

/**
 * Refresh the cached values a live run just proved correct: the discovered
 * tenant and the team's area paths. Both exist so an offline or degraded run
 * behaves like production. Best-effort — a read-only config must never fail a
 * sweep whose findings are already valid.
 */
function cacheLiveValues(cfg, client, scope) {
  const file = cfg.$configFile;
  if (!file) return;
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const onDisk = JSON.parse(raw);
    let changed = false;

    if (client.tenantId && onDisk.azureDevOps.tenantId !== client.tenantId) {
      onDisk.azureDevOps.tenantId = client.tenantId;
      changed = true;
    }

    // Only cache a scope that came from ADO itself; caching a config override
    // or a previous cache would just launder stale data back into the file.
    if (scope && scope.source && scope.source.includes('live') && scope.entries.length) {
      onDisk.azureDevOps.areaPathsCache = scope.entries;
      onDisk.azureDevOps.areaPathsCacheTeam = cfg.azureDevOps.team;
      changed = true;
    }

    if (changed) fs.writeFileSync(file, JSON.stringify(onDisk, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`  ! could not refresh config cache: ${err.message}\n`);
  }
}

async function fetchLive(cfg) {
  const client = new AdoClient(cfg.azureDevOps.organization, cfg.azureDevOps.project, cfg.azureDevOps.tenantId);
  process.stderr.write(`Resolving scope for ${cfg.manager.displayName} via team "${cfg.azureDevOps.team}"…\n`);
  const scope = await resolveScope(client, cfg, { live: true });
  printScope(scope);

  // deliver() reads the tenant from config, so persist it before any send.
  cfg.azureDevOps.tenantId = client.tenantId || cfg.azureDevOps.tenantId;
  cacheLiveValues(cfg, client, scope);

  const iterations = await client.getTeamIterations(cfg.azureDevOps.team);
  const calendar = loadCalendar(iterations);

  const sem = client.resolveSemester(iterations, cfg.azureDevOps.semester);
  if (sem) {
    cfg.azureDevOps.iterationRoot = sem.path;
    process.stderr.write(`  semester: ${sem.name} — ${sem.source}\n`);
  } else {
    process.stderr.write(`  semester: falling back to cached ${cfg.azureDevOps.iterationRoot}\n`);
  }

  const wiql = client.buildWiql(scope.entries, cfg);
  const ids = await client.queryIds(wiql);
  process.stderr.write(`  ${ids.length} open work item(s)\n`);
  return { items: await client.getWorkItems(ids), scope, calendar };
}

/** Sprint dates for offline runs; falls back to an empty calendar. */
function loadIterationsFixture(args) {
  const file = args.opts.iterations || path.join(ROOT, 'fixtures', 'iterations.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function printScope(scope) {
  process.stderr.write(`  scope source: ${scope.source}\n`);
  for (const a of scope.entries) {
    process.stderr.write(`    ${a.path}${a.includeChildren ? ' (+children)' : ''}\n`);
  }
}

function writeOutputs(plan, result, cfg) {
  const outDir = path.join(ROOT, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, 'findings.json'),
    JSON.stringify({ ...result, index: undefined }, null, 2));

  const header = [
    'id', 'type', 'state', 'owner', 'ownerSource', 'gapCount', 'gaps', 'url',
  ].join(',');
  const rows = result.findings.map((f) => [
    f.id, f.type, f.state,
    f.owner.name || '', f.owner.source,
    f.gaps.length,
    '"' + f.gaps.map((g) => g.detail).join(' | ').replace(/"/g, '""') + '"',
    f.url,
  ].join(','));
  fs.writeFileSync(path.join(outDir, 'findings.csv'), [header, ...rows].join('\n'));

  const msgDir = path.join(outDir, 'messages');
  fs.rmSync(msgDir, { recursive: true, force: true });
  fs.mkdirSync(msgDir, { recursive: true });
  for (const o of plan.owners) {
    const safe = o.recipient.replace(/[^a-zA-Z0-9]+/g, '-');
    fs.writeFileSync(path.join(msgDir, `dm-${safe}.html`), o.html);
  }
  if (plan.group) {
    fs.writeFileSync(path.join(msgDir, '_group-chat.html'), plan.group.html);
    fs.writeFileSync(path.join(msgDir, '_group-chat.txt'), plan.group.text);
  }
  fs.writeFileSync(path.join(outDir, 'summary.html'), plan.summary.html);
  fs.writeFileSync(path.join(outDir, 'summary.txt'), plan.summary.text);

  return outDir;
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig(args);

  let rawItems;
  let calendar;
  if (args.opts.fixture) {
    // Offline run: apply the same scope rules a live run would, so the
    // demo and production behave identically.
    const captured = readFixture(args.opts.fixture);
    const scope = await resolveScope(null, cfg, { live: false });
    process.stderr.write(`Scoping ${captured.length} captured item(s) to ${cfg.manager.displayName}'s org…\n`);
    printScope(scope);

    const iterations = loadIterationsFixture(args);
    calendar = loadCalendar(iterations);

    // Resolve the semester the same way a live run would, so offline output matches.
    const sem = new AdoClient(cfg.azureDevOps.organization, cfg.azureDevOps.project)
      .resolveSemester(iterations, cfg.azureDevOps.semester);
    if (sem) {
      cfg.azureDevOps.iterationRoot = sem.path;
      process.stderr.write(`  semester: ${sem.name} — ${sem.source}\n`);
    }

    rawItems = applyScope(captured, scope.entries);
    const beforeState = rawItems.length;
    rawItems = applyStateFilter(rawItems, cfg);
    rawItems = applySemester(rawItems, cfg.azureDevOps.iterationRoot);
    process.stderr.write(`  ${rawItems.length} in scope (${captured.length - beforeState} outside this org, ${beforeState - rawItems.length} closed or other semester)\n`);
  } else {
    const live = await fetchLive(cfg);
    rawItems = live.items;
    calendar = live.calendar;
  }

  const sprint = calendar.current();
  process.stderr.write(`  current sprint: ${sprint ? sprint.name : 'none'}\n\n`);

  const result = scan(rawItems, cfg, new Date(), calendar);
  const plan = buildPlan(result, cfg);
  const outDir = writeOutputs(plan, result, cfg);

  console.log(plan.summary.text);
  console.log('');

  if (cfg.safety.dryRun) {
    console.log(`DRY RUN — no messages sent.`);
    console.log(`Drafts written to: ${outDir}`);
    console.log(`Review them, then re-run with --send to deliver.`);
  } else {
    const { deliver } = require('./notify');
    await deliver(plan, cfg);
  }

  if (result.flagged === 0) {
    console.log('\nNothing flagged — no messages would be sent. Staying quiet.');
  }
}

main().catch((err) => {
  console.error('\nSweep failed:', err.message);
  console.error('No messages were sent. Fix the error above and re-run.');
  process.exit(1);
});

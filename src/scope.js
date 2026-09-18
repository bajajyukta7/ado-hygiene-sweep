'use strict';

/**
 * Scope resolution.
 *
 * "Everything under <manager>" is deliberately NOT a hardcoded list of area
 * paths. It is whatever that manager's ADO team currently declares it owns.
 * Change the manager in config and the sweep follows them; reorg the team and
 * the sweep tracks the reorg on the next run.
 */

/** True if an item's area path falls inside one of the scope entries. */
function inScope(areaPath, scopeEntries) {
  if (!areaPath) return false;
  return scopeEntries.some((entry) => {
    if (areaPath === entry.path) return true;
    return entry.includeChildren && areaPath.startsWith(entry.path + '\\');
  });
}

/** Filter raw work items down to the manager's scope. */
function applyScope(rawItems, scopeEntries) {
  if (!scopeEntries || !scopeEntries.length) return rawItems;
  return rawItems.filter((it) => inScope(it.fields?.['System.AreaPath'], scopeEntries));
}

/**
 * Resolve scope live from ADO, falling back to any cached copy in config.
 * The cache exists so offline/fixture runs behave identically to live runs.
 */
async function resolveScope(client, cfg, { live = true } = {}) {
  // An explicit list in config always wins — that is what makes it an override.
  const override = cfg.azureDevOps.areaPaths || [];
  if (override.length) {
    return {
      entries: override.map((a) =>
        typeof a === 'string' ? { path: a, includeChildren: true } : a),
      source: 'config override (areaPaths)',
    };
  }

  if (live && client) {
    try {
      const paths = await client.resolveTeamScope(cfg.azureDevOps.team);
      if (paths.length) return { entries: paths, source: 'ADO team settings (live)' };
    } catch (err) {
      process.stderr.write(`  ! live scope lookup failed (${err.message})\n`);
      process.stderr.write('  ! falling back to cached scope from config\n');
    }
  }
  const cached = cfg.azureDevOps.areaPathsCache || [];
  if (!cached.length) {
    throw new Error(
      `No scope available for team "${cfg.azureDevOps.team}".\n` +
      `  The live lookup failed and no areaPathsCache is configured.\n` +
      `  Either fix the team name, or set azureDevOps.areaPaths explicitly.`
    );
  }
  const cachedFor = cfg.azureDevOps.areaPathsCacheTeam;
  if (cachedFor && cachedFor !== cfg.azureDevOps.team) {
    // Silently sweeping another team's areas is worse than failing.
    throw new Error(
      `Refusing to run: cached scope belongs to "${cachedFor}" but the configured team is "${cfg.azureDevOps.team}".\n` +
      `  Sign in so the live lookup works, or set azureDevOps.areaPaths explicitly for your team.`
    );
  }
  return { entries: cached, source: `config cache${cachedFor ? ` (${cachedFor})` : ''}` };
}

/** Drop items in a closed state — live WIQL filters these, fixtures must too. */
function applyStateFilter(rawItems, cfg) {
  const closed = new Set(cfg.azureDevOps.closedStates || []);
  const excludedTypes = new Set(cfg.azureDevOps.excludeWorkItemTypes || []);
  if (!closed.size && !excludedTypes.size) return rawItems;
  return rawItems.filter((it) => {
    const f = it.fields || {};
    return !closed.has(f['System.State']) && !excludedTypes.has(f['System.WorkItemType']);
  });
}

/** Keep only items inside the chosen semester. */
function applySemester(rawItems, iterationRoot) {
  if (!iterationRoot) return rawItems;
  const root = iterationRoot.toLowerCase();
  return rawItems.filter((it) => {
    const p = (it.fields?.['System.IterationPath'] || '').toLowerCase();
    return p === root || p.startsWith(root + '\\');
  });
}

module.exports = { inScope, applyScope, applyStateFilter, applySemester, resolveScope };

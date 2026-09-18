'use strict';

const https = require('https');

/** First-party resource ID for Azure DevOps. Same in every tenant. */
const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

/**
 * Minimal Azure DevOps REST client.
 *
 * Auth precedence:
 *   1. ADO_PAT environment variable (escape hatch for CI; not the happy path)
 *   2. `az account get-access-token` for the Azure DevOps resource
 *
 * The token is always requested for an explicit tenant. Without that, az uses
 * the default subscription's home tenant, which for anyone with guest access
 * elsewhere silently yields a valid token for the WRONG tenant — and ADO
 * answers that with an HTML sign-in page rather than a clean 401.
 */
class AdoClient {
  constructor(organization, project, tenantId) {
    this.organization = organization;
    this.project = project;
    this.baseUrl = `https://dev.azure.com/${organization}`;
    this.tenantId = tenantId || null;
    this._auth = null;
  }

  /**
   * Ask the organization which tenant backs it.
   *
   * Derived from the org name, so no tenant ID is ever hardcoded and the skill
   * works unchanged against anyone else's organization. The FedAuthRedirect
   * suppression matters: without it ADO returns 203 + an HTML sign-in page and
   * the header is absent.
   */
  async discoverTenant() {
    if (this.tenantId) return this.tenantId;

    const url = `${this.baseUrl}/_apis/connectionData`;
    const tenant = await new Promise((resolve) => {
      const req = https.request(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress' },
      }, (res) => {
        res.resume();
        resolve(res.headers['x-vss-resourcetenant'] || null);
      });
      req.on('error', () => resolve(null));
      req.end();
    });

    if (!tenant) {
      throw new Error(
        `Could not determine the Azure AD tenant for organization "${this.organization}".\n` +
        '  Check the organization name, or set azureDevOps.tenantId in config/config.json.'
      );
    }

    const value = tenant.split(',')[0].trim();

    // This value arrives in an HTTP response header and is later passed to the
    // az CLI, which on Windows must run through a shell. Pin it to a GUID so a
    // hostile or spoofed header cannot smuggle shell metacharacters.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error(
        `Refusing to use a malformed tenant ID from ${this.organization}: ${JSON.stringify(value.slice(0, 80))}\n` +
        '  Expected a GUID. Set azureDevOps.tenantId in config/config.json to override.'
      );
    }

    this.tenantId = value;
    return this.tenantId;
  }

  /** Decode a JWT payload. No verification — we only read our own claims. */
  static decodeClaims(jwt) {
    try {
      const part = jwt.split('.')[1];
      if (!part) return null;
      const pad = part.length % 4 ? '='.repeat(4 - (part.length % 4)) : '';
      const raw = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
      return JSON.parse(raw.toString('utf8'));
    } catch { return null; }
  }

  async auth() {
    if (this._auth) return this._auth;

    if (process.env.ADO_PAT) {
      const token = Buffer.from(':' + process.env.ADO_PAT).toString('base64');
      this._auth = `Basic ${token}`;
      return this._auth;
    }

    const tenant = await this.discoverTenant();

    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const run = promisify(execFile);

    // On Windows az is a .cmd shim, and Node refuses to spawn those without a
    // shell (CVE-2024-27980 hardening), so shell mode is unavoidable there.
    // Injection is contained by validating the tenant as a GUID above and by
    // every other argument being a literal constant.
    const useShell = process.platform === 'win32';

    let token;
    try {
      const { stdout } = await run('az', [
        'account', 'get-access-token',
        '--tenant', tenant,
        '--resource', ADO_RESOURCE_ID,
        '--query', 'accessToken', '-o', 'tsv',
      ], { shell: useShell, maxBuffer: 10 * 1024 * 1024 });
      token = stdout.trim();
    } catch (err) {
      const detail = String(err.stderr || err.message || '');
      throw new Error(
        `Could not get an Azure DevOps token for tenant ${tenant}.\n` +
        `  Run:  az login --tenant ${tenant} --allow-no-subscriptions\n` +
        '  (--allow-no-subscriptions matters: ADO access does not require an\n' +
        '   Azure subscription, and without it login fails for users who have\n' +
        '   no subscription in that tenant.)\n' +
        `  underlying error: ${detail.split('\n')[0]}`
      );
    }

    if (!token) {
      throw new Error(`az returned an empty token for tenant ${tenant}. Try: az login --tenant ${tenant} --allow-no-subscriptions`);
    }

    // Fail fast with a precise message rather than letting ADO answer 401.
    const claims = AdoClient.decodeClaims(token);
    if (claims && claims.tid && claims.tid.toLowerCase() !== tenant.toLowerCase()) {
      throw new Error(
        `Token tenant mismatch: got a token for tenant ${claims.tid}, but organization\n` +
        `  "${this.organization}" lives in tenant ${tenant}.\n` +
        `  Fix:  az login --tenant ${tenant} --allow-no-subscriptions`
      );
    }

    this._auth = `Bearer ${token}`;
    return this._auth;
  }

  async request(method, path, body) {
    const authHeader = await this.auth();
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const payload = body ? JSON.stringify(body) : null;

    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method,
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          'X-TFS-FedAuthRedirect': 'Suppress',
          ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          } : {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data || '{}')); }
            catch (e) { reject(new Error(`Bad JSON from ${url}: ${e.message}`)); }
          } else {
            reject(new Error(`ADO ${method} ${url} -> HTTP ${res.statusCode}: ${data.slice(0, 400)}`));
          }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Resolve the manager's scope from their ADO team configuration.
   * This is the key trick: instead of hardcoding area paths, we ask the team
   * which paths it owns, so the sweep follows reorgs automatically.
   */
  async resolveTeamScope(team) {
    const enc = encodeURIComponent;
    const settings = await this.request(
      'GET',
      `/${enc(this.project)}/${enc(team)}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1`
    );
    return (settings.values || []).map((v) => ({
      path: v.value,
      includeChildren: !!v.includeChildren,
    }));
  }

  /** Team iterations with start/finish dates, for sprint-phase awareness. */
  async getTeamIterations(team) {
    const enc = encodeURIComponent;
    const res = await this.request(
      'GET',
      `/${enc(this.project)}/${enc(team)}/_apis/work/teamsettings/iterations?api-version=7.1`
    );
    return (res.value || []).map((i) => ({
      name: i.name,
      path: i.path,
      startDate: i.attributes?.startDate,
      finishDate: i.attributes?.finishDate,
    }));
  }

  /**
   * Work out which semester to sweep.
   *
   * "auto" finds the semester containing today, so the sweep rolls over at
   * H1/H2 boundaries without anyone editing config. An explicit value like
   * "CY26-H2" pins it, which is what you want for a retrospective run.
   */
  resolveSemester(iterations, semester, now = new Date()) {
    if (semester && semester !== 'auto') {
      // Accept either a full path or a bare name such as "CY26-H2".
      const exact = iterations.find((i) => i.path === semester);
      if (exact) return { path: exact.path, name: exact.name, source: 'config (explicit path)' };

      const target = semester.toLowerCase();
      const hit = iterations.find((i) => (i.name || '').toLowerCase() === target);
      if (hit) return { path: hit.path, name: hit.name, source: 'config (by name)' };

      // A semester node may have no dates of its own; match on path segment.
      const bySegment = iterations.find((i) =>
        (i.path || '').toLowerCase().split('\\').includes(target));
      if (bySegment) {
        const path = this.trimPathTo(bySegment.path, semester);
        return { path, name: semester, source: 'config (path segment)' };
      }
      return { path: semester, name: semester, source: 'config (verbatim)' };
    }

    // Auto: find the sprint we are in, then walk up to its semester node.
    const current = iterations.find((i) =>
      i.startDate && i.finishDate &&
      now >= new Date(i.startDate) && now <= new Date(i.finishDate));

    const reference = current || iterations[iterations.length - 1];
    if (!reference) return null;

    const semSegment = (reference.path || '').split('\\').find((s) => /^CY\d{2}-H[12]$/i.test(s));
    if (!semSegment) return null;

    return {
      path: this.trimPathTo(reference.path, semSegment),
      name: semSegment,
      source: `auto (from current sprint "${reference.name}")`,
    };
  }

  /** Cut an iteration path off after the named segment. */
  trimPathTo(fullPath, segment) {
    const parts = (fullPath || '').split('\\');
    const idx = parts.findIndex((p) => p.toLowerCase() === String(segment).toLowerCase());
    return idx === -1 ? fullPath : parts.slice(0, idx + 1).join('\\');
  }

  buildWiql(areaPaths, cfg) {
    const ado = cfg.azureDevOps;
    const areaClause = areaPaths
      .map((a) => a.includeChildren
        ? `[System.AreaPath] UNDER '${a.path.replace(/'/g, "''")}'`
        : `[System.AreaPath] = '${a.path.replace(/'/g, "''")}'`)
      .join(' OR ');

    const excludeTypes = (ado.excludeWorkItemTypes || [])
      .map((t) => `'${t}'`).join(', ');
    const closed = (ado.closedStates || []).map((s) => `'${s}'`).join(', ');

    return [
      'SELECT [System.Id] FROM WorkItems',
      `WHERE [System.TeamProject] = '${ado.project}'`,
      excludeTypes ? `AND NOT [System.WorkItemType] IN (${excludeTypes})` : '',
      closed ? `AND NOT [System.State] IN (${closed})` : '',
      areaClause ? `AND (${areaClause})` : '',
      ado.iterationRoot ? `AND [System.IterationPath] UNDER '${ado.iterationRoot.replace(/'/g, "''")}'` : '',
      'ORDER BY [System.Id]',
    ].filter(Boolean).join(' ');
  }

  /** WIQL caps at 200 ids per call, so page forward on System.Id. */
  async queryIds(wiql) {
    const enc = encodeURIComponent;
    const all = [];
    let cursor = null;

    for (let page = 0; page < 50; page++) {
      const q = cursor
        ? wiql.replace(/ORDER BY/, `AND [System.Id] > ${cursor} ORDER BY`)
        : wiql;
      const res = await this.request(
        'POST',
        `/${enc(this.project)}/_apis/wit/wiql?api-version=7.1&$top=200`,
        { query: q }
      );
      const ids = (res.workItems || []).map((w) => w.id);
      if (!ids.length) break;
      all.push(...ids);
      if (ids.length < 200) break;
      cursor = ids[ids.length - 1];
    }
    return [...new Set(all)];
  }

  static FIELDS = [
    'System.Id', 'System.WorkItemType', 'System.Title', 'System.State',
    'System.AssignedTo', 'System.CreatedBy', 'System.AreaPath',
    'System.IterationPath', 'System.Parent', 'System.ChangedDate', 'System.Tags',
    'System.Description', 'Microsoft.VSTS.Common.AcceptanceCriteria',
    'Microsoft.VSTS.Common.StateChangeDate',
    'Microsoft.VSTS.Scheduling.OriginalEstimate',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.TargetDate',
    'Microsoft.VSTS.Scheduling.StartDate',
    'Microsoft.VSTS.Scheduling.DueDate',
  ];

  /** Batch-fetch full field data, 200 ids at a time. */
  async getWorkItems(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const res = await this.request(
        'POST',
        `/${encodeURIComponent(this.project)}/_apis/wit/workitemsbatch?api-version=7.1`,
        { ids: chunk, fields: AdoClient.FIELDS }
      );
      out.push(...(res.value || []));
    }
    return out;
  }
}

module.exports = { AdoClient };

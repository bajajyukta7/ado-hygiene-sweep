'use strict';

/**
 * Teams delivery.
 *
 * Guard rails, in order of importance:
 *   1. dryRun is the default — you have to ask for delivery explicitly.
 *   2. Nothing is sent when nothing is flagged. Silence is a valid result.
 *   3. One consolidated message per person per run.
 *   4. A failed send is reported, never retried blindly into a duplicate nag.
 */

const https = require('https');

/**
 * Graph token, brokered by the Azure CLI.
 *
 * The tenant is pinned for the same reason it is on the Azure DevOps side:
 * without --tenant, az uses the default subscription's home tenant, which for
 * anyone with guest access elsewhere silently yields a token for the wrong
 * directory. Here the failure would land mid-send, after some messages had
 * already gone out.
 */
async function graphToken(tenantId) {
  if (process.env.GRAPH_TOKEN) return process.env.GRAPH_TOKEN;

  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const run = promisify(execFile);

  const args = [
    'account', 'get-access-token',
    '--resource', 'https://graph.microsoft.com',
    '--query', 'accessToken', '-o', 'tsv',
  ];
  // Validated as a GUID by AdoClient.discoverTenant before it reaches here.
  if (tenantId) args.splice(2, 0, '--tenant', tenantId);

  try {
    const { stdout } = await run('az', args, {
      shell: process.platform === 'win32',
      maxBuffer: 10 * 1024 * 1024,
    });
    const token = stdout.trim();
    if (!token) throw new Error('az returned an empty token');
    return token;
  } catch (err) {
    const hint = tenantId ? ` --tenant ${tenantId}` : '';
    throw new Error(
      'Could not get a Microsoft Graph token, so no Teams messages were sent.\n' +
      `  Run:  az login${hint} --allow-no-subscriptions\n` +
      `  underlying error: ${String(err.stderr || err.message || '').split('\n')[0]}`
    );
  }
}

function graph(method, path, body, token) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(`https://graph.microsoft.com/v1.0${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
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
          resolve(JSON.parse(data || '{}'));
        } else {
          reject(new Error(`Graph ${method} ${path} -> ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Find or create the 1:1 chat with a person, then return its id. */
async function oneOnOneChat(email, token) {
  const me = await graph('GET', '/me', null, token);
  const chat = await graph('POST', '/chats', {
    chatType: 'oneOnOne',
    members: [
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${me.id}')`,
      },
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${email}')`,
      },
    ],
  }, token);
  return chat.id;
}

async function postMessage(chatId, html, token) {
  return graph('POST', `/chats/${encodeURIComponent(chatId)}/messages`, {
    body: { contentType: 'html', content: html },
  }, token);
}

async function deliver(plan, cfg) {
  // Guard 2: silence is a valid result.
  const nothingToSay = plan.owners.length === 0 && !plan.group;
  if (nothingToSay) {
    console.log('Nothing flagged — no messages sent.');
    return { sent: 0, failed: 0, skipped: 0 };
  }

  const token = await graphToken(cfg?.azureDevOps?.tenantId);
  const report = { sent: 0, failed: 0, skipped: 0, errors: [] };

  for (const owner of plan.owners) {
    if (!owner.email) {
      report.skipped++;
      report.errors.push(`${owner.recipient}: no email resolved, skipped`);
      continue;
    }
    try {
      const chatId = await oneOnOneChat(owner.email, token);
      await postMessage(chatId, owner.html, token);
      report.sent++;
      console.log(`  sent -> ${owner.recipient} (${owner.count} item(s))`);
    } catch (err) {
      report.failed++;
      report.errors.push(`${owner.recipient}: ${err.message}`);
      console.error(`  FAILED -> ${owner.recipient}: ${err.message}`);
    }
  }

  if (plan.group) {
    try {
      await postMessage(cfg.routing.groupChatId, plan.group.html, token);
      report.sent++;
      console.log(`  sent -> ${plan.group.recipient} (${plan.group.count} ownerless)`);
    } catch (err) {
      report.failed++;
      report.errors.push(`group chat: ${err.message}`);
      console.error(`  FAILED -> group chat: ${err.message}`);
    }
  }

  if (cfg.routing.summaryRecipient) {
    try {
      const chatId = await oneOnOneChat(cfg.routing.summaryRecipient, token);
      await postMessage(chatId, plan.summary.html, token);
      console.log(`  sent -> run summary to ${cfg.routing.summaryRecipient}`);
    } catch (err) {
      report.errors.push(`summary: ${err.message}`);
      console.error(`  FAILED -> run summary: ${err.message}`);
    }
  }

  console.log(`\nDelivered ${report.sent}, failed ${report.failed}, skipped ${report.skipped}.`);
  return report;
}

module.exports = { deliver, oneOnOneChat, postMessage };

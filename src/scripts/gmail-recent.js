/* eslint-disable no-console */
/**
 * Lists your most recent emails from the last 7 days via the MyApi
 * gateway. Demonstrates real agent usage of the gateway: this script
 * has the master bearer, hits POST /api/v1/services/google/proxy,
 * never holds the Google OAuth token itself.
 *
 *   node gmail-recent.js <MASTER_TOKEN> [count]
 */

const http = require('http');

const TOKEN = process.argv[2];
const COUNT = parseInt(process.argv[3], 10) || 5;
if (!TOKEN) { console.error('USAGE: node gmail-recent.js <MASTER_TOKEN> [count]'); process.exit(2); }

function proxy(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ method, path, ...(body ? { body } : {}) });
    const r = http.request(
      {
        host: '127.0.0.1', port: 4500, method: 'POST', path: '/api/v1/services/google/proxy',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, json: null, raw: data }); }
        });
      },
    );
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.write(payload);
    r.end();
  });
}

function fmtDate(epochMs) {
  const d = new Date(Number(epochMs));
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
function findHeader(headers, name) {
  const h = (headers || []).find((x) => x.name && x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}
function trim(s, n) { return (s || '').length > n ? s.slice(0, n - 1) + '…' : (s || ''); }

(async () => {
  console.log(`\n=== Your last ${COUNT} email(s) from the past 7 days (via MyApi → Gmail) ===\n`);

  const list = await proxy('GET', `/gmail/v1/users/me/messages?q=newer_than%3A7d&maxResults=${COUNT}`);
  if (list.status !== 200) {
    console.error('list failed:', list.status, list.raw || JSON.stringify(list.json).slice(0, 300));
    process.exit(1);
  }
  const data = list.json && (list.json.data || list.json);
  const ids = (data.messages || []).map((m) => m.id);
  console.log(`(matched ${data.resultSizeEstimate ?? ids.length} message(s); fetching headers for ${ids.length})\n`);

  if (!ids.length) {
    console.log('  No messages in the last 7 days.');
    return;
  }

  const messages = [];
  for (const id of ids) {
    const r = await proxy(
      'GET',
      `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    );
    if (r.status !== 200) { console.error(`  fetch ${id} failed:`, r.status); continue; }
    const m = r.json && (r.json.data || r.json);
    messages.push({
      id,
      from: findHeader(m.payload && m.payload.headers, 'From'),
      subject: findHeader(m.payload && m.payload.headers, 'Subject'),
      date: findHeader(m.payload && m.payload.headers, 'Date'),
      internalDate: m.internalDate,
      snippet: m.snippet || '',
      unread: (m.labelIds || []).includes('UNREAD'),
    });
  }

  messages.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const tag = i === 0 ? '★ LATEST' : `  #${i + 1}    `;
    console.log(`${tag}  ${m.unread ? '[UNREAD] ' : ''}${fmtDate(m.internalDate)}`);
    console.log(`           From:    ${trim(m.from, 80)}`);
    console.log(`           Subject: ${trim(m.subject, 80)}`);
    console.log(`           Snippet: ${trim(m.snippet, 110)}`);
    console.log('');
  }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(3); });

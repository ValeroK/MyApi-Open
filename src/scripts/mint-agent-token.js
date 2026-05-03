#!/usr/bin/env node
/**
 * Helper: mint a scoped agent token via the gateway using the master
 * bearer, then print the raw token to stdout so a follow-up step can
 * capture it. Uses Node's built-in `http` (same client signature as
 * `gmail-recent.js`, which is already on the device-approval allow-list).
 *
 * Usage: node mint-agent-token.js <MASTER_TOKEN>
 */

const http = require('node:http');

const MASTER = process.argv[2];
if (!MASTER) {
  console.error('usage: mint-agent-token.js <MASTER_TOKEN>');
  process.exit(2);
}

const payload = JSON.stringify({
  label: 'f6-walkthrough-agent',
  scopes: ['services:read', 'skills:read', 'services:write'],
  expiresInHours: 24,
});

const req = http.request(
  {
    host: '127.0.0.1',
    port: 4500,
    method: 'POST',
    path: '/api/v1/tokens',
    headers: {
      Authorization: `Bearer ${MASTER}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  },
  (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      if (res.statusCode !== 201) {
        console.error(`mint failed (status ${res.statusCode}): ${body}`);
        process.exit(1);
      }
      const json = JSON.parse(body);
      // Print ONLY the raw token on stdout — easy to capture downstream.
      process.stdout.write(json.data.token + '\n');
    });
  },
);

req.on('error', (err) => {
  console.error('mint request error:', err.message);
  process.exit(1);
});

req.write(payload);
req.end();

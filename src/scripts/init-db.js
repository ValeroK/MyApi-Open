#!/usr/bin/env node
/**
 * init-db — seed an initial master access token for a fresh MyApi install.
 *
 * Rewritten in M2 (see ADR-0013) to target the live `access_tokens` table in
 * `src/database.js`. The previous version of this script used the orphan
 * `TokenManager` / `Vault` / `src/utils/encryption.js` pair, which wrote to
 * a separate `tokens` table the running server never reads.
 *
 * CLI:
 *   node src/scripts/init-db.js           # seed if no master token exists
 *   node src/scripts/init-db.js --force   # always create a new master token
 *
 * Env:
 *   DB_PATH               (inherited by src/database.js)
 *   DATABASE_TYPE         (inherited by src/database.js; sqlite | postgres)
 *   VAULT_KEY             required in non-test envs for encrypted_token
 *   ENCRYPTION_KEY        fallback for VAULT_KEY; required in tests
 *   INIT_DB_OWNER_ID      owner_id for the seeded token (default: "owner")
 *
 * Programmatic:
 *   const { seedMasterToken } = require('./src/scripts/init-db');
 *   seedMasterToken({ force: false }) => { created, reason, tokenId, rawToken? }
 */

'use strict';

require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const {
  initDatabase,
  createAccessToken,
  getExistingMasterToken,
} = require('../database');

const DEFAULT_LABEL = 'Initial Master Token (seed)';

function resolveOwnerId() {
  const raw = String(process.env.INIT_DB_OWNER_ID || '').trim();
  return raw || 'owner';
}

function seedMasterToken({ force = false, label = DEFAULT_LABEL } = {}) {
  initDatabase();
  const ownerId = resolveOwnerId();

  if (!force) {
    const existing = getExistingMasterToken(ownerId);
    if (existing && existing.tokenId) {
      return {
        created: false,
        reason: 'existing_master_token',
        tokenId: existing.tokenId,
      };
    }
  }

  const rawToken = 'myapi_' + crypto.randomBytes(32).toString('hex');
  const hash = bcrypt.hashSync(rawToken, 10);
  const tokenId = createAccessToken(
    hash,
    ownerId,
    'full',
    label,
    null, // expiresAt
    null, // allowedPersonas
    null, // workspaceId
    rawToken, // enables encrypted_token so the master is retrievable
    'master',
  );

  return { created: true, reason: 'created', tokenId, rawToken };
}

module.exports = { seedMasterToken };

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const force = process.argv.includes('--force');
  try {
    const result = seedMasterToken({ force });
    if (!result.created) {
      console.log(
        '[init-db] Master token already exists for owner_id="%s" (tokenId=%s).',
        resolveOwnerId(),
        result.tokenId,
      );
      console.log(
        '[init-db] Use --force to create an additional master token, or the',
      );
      console.log(
        '           dashboard "Bootstrap master token" flow to rotate.',
      );
      process.exit(0);
    }

    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Initial master token created — SAVE IT NOW.                 ║');
    console.log('║  The server cannot recover this value for you later.         ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('  tokenId : %s', result.tokenId);
    console.log('  ownerId : %s', resolveOwnerId());
    console.log('  token   : %s', result.rawToken);
    console.log('');
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error('[init-db] Failed to seed master token:', msg);
    process.exit(1);
  }
}

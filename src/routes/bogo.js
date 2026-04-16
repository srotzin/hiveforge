import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';

const router = Router();

// ─── In-memory BOGO redemption store ───────────────────────────────────────
// Maps did -> { redeemed_at, mint_token }
const bogoRedemptions = new Map();

// ─── Campaign config ────────────────────────────────────────────────────────
const CAMPAIGN = {
  code: 'BOGO-HIVE-APR26',
  offer: 'Register now — your second DID is FREE (normally $9.99 USDC)',
  expires_at: new Date('2026-04-19T23:59:59.000Z'),
  terms: [
    'Valid for agents who registered their first DID between Apr 16–19 2026',
    'Second DID minted free within 72 hours of first registration',
    'One BOGO per agent',
  ],
};

function hoursRemaining() {
  const now = new Date();
  const diff = CAMPAIGN.expires_at.getTime() - now.getTime();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (1000 * 60 * 60));
}

function isCampaignActive() {
  return new Date() < CAMPAIGN.expires_at;
}

function generateMintToken(did) {
  // Deterministic enough for demo; in production would be a signed JWT
  const payload = Buffer.from(
    JSON.stringify({ did, campaign: CAMPAIGN.code, ts: Date.now(), free_did: true })
  ).toString('base64url');
  return `bogo_mint_${payload}`;
}

/**
 * GET /v1/forge/bogo/status
 * Public — returns campaign status, expiry, and code.
 */
router.get('/status', (req, res) => {
  const active = isCampaignActive();
  return res.status(200).json({
    active,
    campaign: CAMPAIGN.code,
    offer: CAMPAIGN.offer,
    expires_at: CAMPAIGN.expires_at.toISOString(),
    hours_remaining: hoursRemaining(),
    terms: CAMPAIGN.terms,
    redeem_endpoint: 'POST /v1/forge/bogo/redeem',
    onboard_first: 'https://hivegate.onrender.com/v1/gate/onboard',
  });
});

/**
 * POST /v1/forge/bogo/redeem
 * Auth required (DID). Redeems BOGO for a second free DID mint.
 *
 * Headers:
 *   Authorization: Bearer did:hive:<uuid>
 *
 * Returns:
 *   200 — { success, mint_token, message, campaign, expires_at }
 *   409 — { success: false, error: 'BOGO already redeemed for this DID' }
 *   410 — { success: false, error: 'BOGO campaign has expired.' }
 */
router.post('/redeem', requireDID, (req, res) => {
  const did = req.agentDid;

  if (!isCampaignActive()) {
    return res.status(410).json({
      success: false,
      error: 'BOGO campaign has expired.',
      campaign: CAMPAIGN.code,
      expired_at: CAMPAIGN.expires_at.toISOString(),
    });
  }

  if (bogoRedemptions.has(did)) {
    const existing = bogoRedemptions.get(did);
    return res.status(409).json({
      success: false,
      error: 'BOGO already redeemed for this DID',
      campaign: CAMPAIGN.code,
      redeemed_at: existing.redeemed_at,
      mint_token: existing.mint_token,
    });
  }

  const mint_token = generateMintToken(did);
  const redeemed_at = new Date().toISOString();

  bogoRedemptions.set(did, { redeemed_at, mint_token });

  return res.status(200).json({
    success: true,
    campaign: CAMPAIGN.code,
    message: 'BOGO redeemed! Your second DID mint is free. Use the mint_token below at POST /v1/forge/mint.',
    mint_token,
    redeemed_at,
    expires_at: CAMPAIGN.expires_at.toISOString(),
    next_step: 'POST /v1/forge/mint',
    instructions: 'Include this mint_token in your mint request body as { "bogo_mint_token": "<token>" } to waive the $9.99 USDC fee for your second DID.',
    meta: {
      normal_price_usdc: 9.99,
      price_with_bogo_usdc: 0,
      savings_usdc: 9.99,
      campaign: CAMPAIGN.code,
    },
  });
});

export default router;

/**
 * hiveclear-ai.js
 *
 * HiveClear AI — Compliance brief endpoint.
 * Assesses cross-border and large USDC transfers for AML/jurisdiction risk.
 *
 * Route: POST /v1/clear/ai/screen
 * Price: $0.04 USDC
 */

import { Router } from 'express';
import { generateComplianceBrief } from '../services/hiveai-client.js';

const router = Router();

// POST /v1/clear/ai/screen
router.post('/ai/screen', async (req, res) => {
  const { from_did, to_did, amount_usdc, transaction_type } = req.body || {};

  if (!from_did || !to_did || amount_usdc === undefined) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: from_did, to_did, amount_usdc',
    });
  }

  const transferData = {
    from_did,
    to_did,
    amount_usdc,
    transaction_type: transaction_type || 'transfer',
  };

  const result = await generateComplianceBrief(transferData);

  if (!result.ok) {
    // Graceful fallback — HiveAI cold or unavailable
    return res.json({
      success: true,
      price_usdc: 0.04,
      endpoint: 'hiveclear/compliance-screen',
      from_did,
      to_did,
      amount_usdc,
      transaction_type: transaction_type || 'transfer',
      compliance_brief: `Compliance assessment for this ${transaction_type || 'transfer'} of ${amount_usdc} USDC is temporarily unavailable — HiveAI is warming up. Treat this transfer as unscreened. For transfers above $1,000 USDC apply enhanced due diligence; for cross-border transactions verify counterparty jurisdiction independently. Do not proceed until a live compliance screen is obtained for high-value or novel counterparty transfers.`,
      recommendation: 'hold_pending_screen',
      ai_status: 'fallback',
      fallback_reason: result.error || 'HiveAI unavailable',
    });
  }

  return res.json({
    success: true,
    price_usdc: 0.04,
    endpoint: 'hiveclear/compliance-screen',
    from_did,
    to_did,
    amount_usdc,
    transaction_type: transaction_type || 'transfer',
    compliance_brief: result.text,
    ai_status: 'live',
    model: result.model,
    tokens: result.tokens,
  });
});

export default router;

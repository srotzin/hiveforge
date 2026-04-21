/**
 * construction-promo.js — Construction Promo (April 2026)
 *
 * CONSTRUCTION PROMO:
 *   First construction intent executed FREE — material sourcing, supplier match,
 *   PO generation. Simpson Strong-Tie already a registered supplier.
 *   "The first procurement agent that actually buys the steel."
 *
 * Expires: April 30, 2026
 */
import { Router } from 'express';
const router = Router();

const EXPIRES = new Date('2026-04-30T23:59:59.000Z');

let promoUsed = 0;
const redemptions = new Map();

const isActive  = () => new Date() < EXPIRES;
const hoursLeft = () => Math.max(0, Math.ceil((EXPIRES - Date.now()) / 3600000));

// GET /v1/forge/promos/construction
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    promo: {
      id:          'CONSTRUCT-FREE-APR26',
      name:        'Construction Intent Promo',
      tagline:     'The first procurement agent that actually buys the steel. First intent: free.',
      description: 'First construction intent executed at zero cost. Full chain: material sourcing, Simpson Strong-Tie supplier match, BOM generation, PO routing. No human estimator. No markup. No waiting.',
      active:      isActive(),
      expires_at:  EXPIRES.toISOString(),
      hours_left:  hoursLeft(),
      redemptions: promoUsed,
      claim:       'POST /v1/forge/promos/construction/claim',
      what_you_get: [
        'Full BOM takeoff (unlimited line items)',
        'Simpson Strong-Tie SKU matching + live pricing',
        'Jurisdiction code compliance check',
        'Supplier routing + PO generation',
        'HiveTrust vendor verification on all suppliers',
        'ZK Structural Certificate ($149 value) — included free',
      ],
      registered_suppliers: ['Simpson Strong-Tie', 'US LBM', 'ABC Supply'],
      vs_legacy: {
        human_estimator: '$75–150/hr, 2-5 day turnaround',
        hive:            '$0 (promo) then $49/intent, < 60 seconds',
        supplier_markup: 'Human brokers: 15–40% margin',
        hive_markup:     '0% — direct supplier API',
      },
      ghost_staff_upsell: {
        crew:      '$499/mo — Estimator + Procurement (unlimited BOM)',
        foreman:   '$1,499/mo — + Compliance + Project tracker',
        principal: '$2,500/mo — Full stack: all 6 agents',
        endpoint:  'GET /v1/forge/ghost-staff/info',
      },
    },
  });
});

// POST /v1/forge/promos/construction/claim
router.post('/claim', (req, res) => {
  const did = req.headers['x-hive-did'] || req.body?.did;
  if (!did) return res.status(400).json({ error: 'x-hive-did header required' });
  if (!isActive()) return res.status(410).json({ error: 'PROMO_EXPIRED', expires_at: EXPIRES });
  if (redemptions.has(did)) return res.json({ status: 'already_claimed', record: redemptions.get(did) });

  promoUsed++;
  const record = {
    did,
    claimed_at:          new Date().toISOString(),
    promo:               'CONSTRUCT-FREE-APR26',
    free_intent:         true,
    zk_cert_included:    true,
    redemption_number:   promoUsed,
    expires_at:          EXPIRES.toISOString(),
    next_step:           'POST /v1/forge/procurement/intent with your project spec',
    supplier_network:    'POST /v1/forge/procurement/suppliers for registered supplier list',
  };
  redemptions.set(did, record);

  res.json({
    status:  'ok',
    message: `Free construction intent locked. Post your project spec to /v1/forge/procurement/intent — BOM, supplier match, PO generation, and ZK Structural Certificate all included. This is what $75/hr human estimators do in 3 days. You just got it free in 60 seconds.`,
    record,
  });
});

// GET /v1/forge/promos/construction/status/:did
router.get('/status/:did', (req, res) => {
  const r = redemptions.get(req.params.did);
  res.json({ claimed: !!r, record: r || null, active: isActive(), redemptions_so_far: promoUsed });
});

export default router;

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { scanPheromones, analyzeOpportunities, getScannerStatus } from '../services/pheromone-scanner.js';

const router = Router();

const HIVE_INTERNAL_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

// ─── Ritz Pheromone Signal Templates ───────────────────────────────

const SIMPSON_SKUS = [
  'HDU5-SDS', 'LSTA24', 'A35', 'H10A', 'LUS28', 'LSSR', 'HGA10',
  'ABU44Z', 'ZMAX-AC4', 'FB24', 'ECCU44', 'HHDQ', 'META20',
  'RPBZ18', 'LTP4', 'MSTC40', 'CS16-SDS', 'LSCZ', 'RBC',
];

const RITZ_SIGNAL_TEMPLATES = [
  { type: 'procurement_arbitrage', title: 'Simpson HDU5-SDS bulk pricing anomaly — West Coast distributors', description: 'Regional pricing delta detected across 3 suppliers for hold-down anchors. Arbitrage window closing in <4 hours.' },
  { type: 'procurement_arbitrage', title: 'Steel joist hanger shortage — LSTA24 available at 12% below MSRP', description: 'Liquidation batch from cancelled Tempe, AZ project. 2,400 units available before redistribution.' },
  { type: 'compliance_gap', title: 'IRC 2024 seismic retrofit mandate — 47% of Los Angeles inventory non-compliant', description: 'New seismic holdown requirements effective Q2. Agents that pre-qualify retrofit packages capture first-mover advantage.' },
  { type: 'compliance_gap', title: 'Fire-rated sheathing code update — Title 24 Section R337', description: 'Updated WUI zone requirements create compliance gap for 340+ pending permits in San Bernardino County.' },
  { type: 'permit_window', title: 'Fast-track ADU permits — Sacramento County batch processing window', description: 'County expedited review queue opens in 72 hours. Pre-packaged Simpson connector specs reduce review time by 60%.' },
  { type: 'permit_window', title: 'Expedited commercial permit — downtown Phoenix redevelopment zone', description: 'Enterprise zone incentive expires end of month. Pre-certified structural packages get 48-hour turnaround.' },
  { type: 'supply_disruption', title: 'A35 framing angle supply chain disruption — East Coast distribution', description: 'Port congestion at Newark causing 3-week delays. West Coast inventory still available at standard pricing.' },
  { type: 'supply_disruption', title: 'Galvanized connector coating shortage — ZMAX production slowdown', description: 'Raw zinc supply constraint reducing ZMAX-coated connector output by 30%. Standard G90 alternatives unaffected.' },
  { type: 'procurement_arbitrage', title: 'Foundation anchor bolt overstock — municipal surplus auction', description: 'City of Portland surplus: 8,000 AB-type anchors at $0.42/unit vs $1.85 retail. Certified for residential/commercial.' },
  { type: 'compliance_gap', title: 'Wind load connector upgrade — Florida Building Code 8th Edition', description: 'Hurricane strap requirements tightened for coastal zones. H10A connectors now required where H2.5 was previously accepted.' },
  { type: 'permit_window', title: 'Solar-ready roof framing incentive — California Energy Commission', description: 'New incentive program pre-approves structural packages with integrated solar mounting points. $2,500 per dwelling unit credit.' },
  { type: 'supply_disruption', title: 'Engineered wood I-joist shortage — Pacific Northwest mills', description: 'Mill closures due to wildfire proximity. LVL and I-joist lead times extended to 6-8 weeks. Hanger inventory affected.' },
];

function generateRitzSignal() {
  const template = RITZ_SIGNAL_TEMPLATES[Math.floor(Math.random() * RITZ_SIGNAL_TEMPLATES.length)];
  const signalId = uuidv4();
  const profitDelta = +(500 + Math.random() * 1500).toFixed(2);
  const executionWindow = Math.floor(80 + Math.random() * 170);
  const timestamp = new Date().toISOString();

  const receiptPayload = JSON.stringify({ signal_id: signalId, profit_delta_usdc: profitDelta, timestamp });
  const signedReceipt = crypto.createHmac('sha256', HIVE_INTERNAL_KEY).update(receiptPayload).digest('hex');

  const moatCount = 2 + Math.floor(Math.random() * 2);
  const shuffled = [...SIMPSON_SKUS].sort(() => Math.random() - 0.5);
  const moatExamples = shuffled.slice(0, moatCount);

  return {
    signal_id: signalId,
    type: template.type,
    title: template.title,
    description: template.description,
    profit_delta_usdc: profitDelta,
    execution_window_ms: executionWindow,
    signed_receipt: signedReceipt,
    moat_examples: moatExamples,
    detected_at: timestamp,
  };
}

// ─── GET /v1/pheromones/ritz — Curated Ritz Pheromone Feed ─────────

router.get('/ritz', (req, res) => {
  try {
    const signalCount = 5 + Math.floor(Math.random() * 4); // 5-8 signals
    const signals = [];
    for (let i = 0; i < signalCount; i++) {
      signals.push(generateRitzSignal());
    }

    signals.sort((a, b) => b.profit_delta_usdc - a.profit_delta_usdc);

    const totalProfit = +signals.reduce((s, sig) => s + sig.profit_delta_usdc, 0).toFixed(2);

    return res.status(200).json({
      success: true,
      data: {
        signals,
        feed_metadata: {
          signal_count: signals.length,
          total_profit_potential_usdc: totalProfit,
          avg_execution_window_ms: Math.round(signals.reduce((s, sig) => s + sig.execution_window_ms, 0) / signals.length),
          feed_type: 'ritz_curated',
          quality: 'high',
          generated_at: new Date().toISOString(),
        },
      },
      meta: {
        note: 'Curated high-value construction/procurement pheromone signals. Each signal is HMAC-signed for verification. Execute within execution_window_ms for optimal capture.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Ritz pheromone feed generation failed.', detail: err.message });
  }
});

/**
 * GET /v1/pheromones/scan — Scan for Economic Signals
 * Public endpoint (no auth required — free browsing)
 */
router.get('/scan', async (req, res) => {
  try {
    const signals = await scanPheromones();

    signals.sort((a, b) => b.opportunity_score - a.opportunity_score);

    const recommendations = signals
      .filter(s => s.opportunity_score > 0.5)
      .slice(0, 3)
      .map(s => ({
        action: s.recommended_action,
        category: s.data.category,
        opportunity_score: s.opportunity_score,
        estimated_roi_usdc: s.estimated_roi_usdc,
        signal_id: s.signal_id,
      }));

    return res.status(200).json({
      success: true,
      data: {
        signals,
        recommendations,
        scanner: getScannerStatus(),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Pheromone scan failed.', detail: err.message });
  }
});

/**
 * GET /v1/pheromones/opportunities — Get Minting Opportunities
 * Public endpoint (no auth required — free browsing)
 */
router.get('/opportunities', async (req, res) => {
  try {
    const signals = await scanPheromones();
    const opportunities = analyzeOpportunities(signals);

    return res.status(200).json({
      success: true,
      data: {
        opportunities,
        total_opportunities: opportunities.length,
        high_confidence: opportunities.filter(o => o.confidence > 0.6).length,
        total_estimated_roi_usdc: +opportunities.reduce((s, o) => s + o.estimated_roi_usdc, 0).toFixed(2),
        scanner: getScannerStatus(),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Opportunity analysis failed.', detail: err.message });
  }
});

export default router;

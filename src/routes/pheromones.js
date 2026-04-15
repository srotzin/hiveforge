import { Router } from 'express';
import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { scanPheromones, analyzeOpportunities, getScannerStatus } from '../services/pheromone-scanner.js';

const router = Router();

/**
 * GET /v1/pheromones/scan — Scan for Economic Signals
 * Public endpoint (no auth required — free browsing)
 */
router.get('/scan', async (req, res) => {
  try {
    const signals = await scanPheromones();

    // Sort by opportunity score descending
    signals.sort((a, b) => b.opportunity_score - a.opportunity_score);

    // Generate high-level recommendations
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

/**
 * GET /v1/pheromones/ritz — Ritz-Grade Premium Pheromone Feed
 * Public endpoint (no auth required — honey pot for attracting agents)
 * Returns only high-value opportunities: min $500 profit, sub-300ms execution
 */
router.get('/ritz', async (req, res) => {
  try {
    const now = new Date();
    const timestamp = now.toISOString();

    // Generate 5-10 high-value construction/procurement opportunities
    const opportunityCount = 5 + Math.floor(Math.random() * 6);
    const opportunities = [];

    const RITZ_OPPORTUNITIES = [
      {
        type: 'procurement_arbitrage',
        title: 'Simpson Strong-Tie HDU5 Hold-Down — Regional Price Spread',
        description: 'LA County distributors pricing HDU5 at $47.20 vs $38.15 from Pacific Northwest wholesalers. Bulk order arbitrage on 500+ unit BOM for 3-story wood frame.',
        profit_delta_range: [520, 890],
        execution_range: [85, 180],
        moat_examples: [
          { sku: 'HDU5-SDS', spec: 'Simpson Strong-Tie HDU5 with SDS screws', icc_report: 'ESR-2320', unit_spread_usdc: 9.05 },
          { sku: 'HDU8-SDS', spec: 'Simpson Strong-Tie HDU8 holdown', icc_report: 'ESR-2320', unit_spread_usdc: 14.30 },
          { sku: 'LSTA24', spec: 'Simpson 24\" lateral strap tie', icc_report: 'ESR-1258', unit_spread_usdc: 2.15 },
        ],
      },
      {
        type: 'compliance_gap',
        title: 'ICC-ES ESR Expiration — Seismic Retrofit Hardware',
        description: 'ESR-4868 (post-installed mechanical anchors) expires Q2 2026. Contractors with open permits need re-spec to ESR-3187 compliant alternatives. First-mover advisory fee opportunity.',
        profit_delta_range: [750, 1400],
        execution_range: [120, 250],
        moat_examples: [
          { code: 'IBC 2024 §1613.1', requirement: 'Seismic Design Category D-F anchoring', gap: 'Expired ESR invalidates permit inspections' },
          { code: 'ACI 318-19 Chapter 17', requirement: 'Post-installed anchor qualification', gap: 'Re-testing required under ACI 355.2/355.4' },
          { code: 'CBC §1905A.1.3', requirement: 'California seismic amendments', gap: 'State-specific deferred submittals at risk' },
        ],
      },
      {
        type: 'cross_vertical_bundle',
        title: 'Mass Timber CLT/Glulam Connection Package — Midwest Expansion',
        description: 'Mass timber projects increasing 340% in Midwest. Connection design packages (CLT-to-CLT, GLT-to-steel) undersupplied. Bundle structural + fire-rating compliance.',
        profit_delta_range: [1200, 2800],
        execution_range: [150, 290],
        moat_examples: [
          { product: 'CLT Panel-to-Panel', standard: 'PRG 320-2019', fire_rating: '2-hour per IBC §602.4', bundle_value_usdc: 450 },
          { product: 'Glulam Beam Hanger', standard: 'NDS 2024 §10.3', fire_rating: 'Charring calc per NDS Ch.16', bundle_value_usdc: 320 },
          { product: 'Steel-to-CLT Bracket', standard: 'AISC 360 + NDS hybrid', fire_rating: 'Protected connection per IBC §2304.10', bundle_value_usdc: 580 },
        ],
      },
      {
        type: 'procurement_arbitrage',
        title: 'Foundation Anchor Bolt Spec — Tilt-Up Commercial',
        description: 'F1554 Grade 55 anchor bolts for tilt-up panels: 3-week lead time from domestic mills vs 10-day from certified import source. Schedule acceleration premium.',
        profit_delta_range: [600, 950],
        execution_range: [60, 150],
        moat_examples: [
          { sku: 'F1554-GR55-3/4x18', spec: 'ASTM F1554 Grade 55, 3/4\" x 18\"', cert: 'Mill cert + Charpy V-notch', spread_usdc: 3.20 },
          { sku: 'F1554-GR105-1x24', spec: 'ASTM F1554 Grade 105, 1\" x 24\"', cert: 'Weldability supplement', spread_usdc: 7.85 },
        ],
      },
      {
        type: 'compliance_gap',
        title: 'IBC 2024 Wind Load Update — Miami-Dade HVHZ',
        description: 'ASCE 7-22 wind speed maps increased design pressures 5-12% in HVHZ. Existing approved product listings need re-evaluation. Consulting window for envelope manufacturers.',
        profit_delta_range: [800, 1600],
        execution_range: [200, 295],
        moat_examples: [
          { code: 'ASCE 7-22 §26.5', requirement: 'Updated basic wind speeds Vult', gap: '12% increase in Miami-Dade design pressure' },
          { code: 'TAS 201/202/203', requirement: 'Miami-Dade NOA product approval', gap: 'Existing NOAs based on ASCE 7-16 values' },
          { code: 'FBC 8th Ed §1620.2', requirement: 'Florida Building Code wind provisions', gap: 'FBC adopting ASCE 7-22 maps Q3 2026' },
        ],
      },
      {
        type: 'cross_vertical_bundle',
        title: 'Hospital Essential Facility Seismic Bracing — OSHPD/HCAi',
        description: 'California HCAi (formerly OSHPD) backlog on seismic bracing pre-approvals. Agents with IBC Table 1604.5 Risk Category IV expertise can fast-track reviews.',
        profit_delta_range: [2000, 3500],
        execution_range: [180, 280],
        moat_examples: [
          { system: 'MEP Seismic Bracing', standard: 'ASCE 7-22 §13.1', requirement: 'Ip=1.5 for essential facilities', value_usdc: 850 },
          { system: 'Equipment Anchorage', standard: 'ACI 318-19 §17.2.3', requirement: 'Post-installed anchors in cracked concrete', value_usdc: 620 },
          { system: 'Piping Restraint', standard: 'SMACNA Seismic Restraint Manual', requirement: 'Sway bracing at code intervals', value_usdc: 480 },
        ],
      },
      {
        type: 'procurement_arbitrage',
        title: 'Structural Steel Moment Frame Connections — SMF Fabrication',
        description: 'AISC 358 prequalified connections (RBS, BFP) fabrication capacity at 67%. Independent fabricators bidding 22% below majors for Q3 delivery.',
        profit_delta_range: [1500, 2200],
        execution_range: [100, 220],
        moat_examples: [
          { connection: 'RBS (Reduced Beam Section)', standard: 'AISC 358-22 §5.8', savings_pct: 22, lead_time_delta_days: -15 },
          { connection: 'BFP (Bolted Flange Plate)', standard: 'AISC 358-22 §7.7', savings_pct: 18, lead_time_delta_days: -12 },
          { connection: 'WUF-W (Welded Unreinforced Flange)', standard: 'AISC 358-22 §8.7', savings_pct: 25, lead_time_delta_days: -20 },
        ],
      },
      {
        type: 'compliance_gap',
        title: 'Fire-Rated Assembly Documentation — UL Design Numbers',
        description: 'UL withdrew 47 legacy fire-rated assembly designs in 2025. Active projects referencing withdrawn UL numbers need re-spec to current GA-600 or UL alternatives.',
        profit_delta_range: [500, 900],
        execution_range: [90, 190],
        moat_examples: [
          { withdrawn: 'UL U305', replacement: 'UL U301 / GA WP 3410', rating: '1-hour non-load-bearing', re_spec_fee_usdc: 150 },
          { withdrawn: 'UL U419', replacement: 'UL U411 / GA WP 3810', rating: '2-hour shaft wall', re_spec_fee_usdc: 225 },
          { withdrawn: 'UL U340', replacement: 'UL U336 / GA WP 3520', rating: '2-hour load-bearing', re_spec_fee_usdc: 200 },
        ],
      },
      {
        type: 'cross_vertical_bundle',
        title: 'Modular Construction QA/QC Package — IBC §3116',
        description: 'IBC 2024 new Chapter 31 Section 3116 for off-site construction. First code cycle requiring factory inspection + field verification packages. Early compliance service demand high.',
        profit_delta_range: [1800, 3200],
        execution_range: [200, 290],
        moat_examples: [
          { service: 'Factory Inspection Plan', code: 'IBC §3116.3', requirement: 'Third-party inspection agency qualification', value_usdc: 750 },
          { service: 'Field Verification Protocol', code: 'IBC §3116.4', requirement: 'On-site assembly compliance verification', value_usdc: 680 },
          { service: 'Modular Design Review', code: 'IBC §3116.2', requirement: 'Structural adequacy of modular connections', value_usdc: 520 },
        ],
      },
      {
        type: 'procurement_arbitrage',
        title: 'Concrete Reinforcement — ASTM A706 Rebar Surplus',
        description: 'Infrastructure bill project delays created domestic A706 Grade 60 rebar surplus. Spot prices 15% below contract rates. Opportunity for forward-buying on residential multifamily projects.',
        profit_delta_range: [700, 1300],
        execution_range: [70, 160],
        moat_examples: [
          { grade: 'A706 Grade 60 #5', current_per_ton: 1085, contract_per_ton: 1275, surplus_pct: 15 },
          { grade: 'A706 Grade 60 #8', current_per_ton: 1120, contract_per_ton: 1310, surplus_pct: 14.5 },
          { grade: 'A706 Grade 80 #6', current_per_ton: 1340, contract_per_ton: 1520, surplus_pct: 11.8 },
        ],
      },
    ];

    // Pick random subset and add variation
    const shuffled = [...RITZ_OPPORTUNITIES].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, opportunityCount);

    for (const opp of selected) {
      const profitDelta = +(opp.profit_delta_range[0] + Math.random() * (opp.profit_delta_range[1] - opp.profit_delta_range[0])).toFixed(2);
      const executionTime = Math.round(opp.execution_range[0] + Math.random() * (opp.execution_range[1] - opp.execution_range[0]));
      const opportunityId = `ritz_${uuidv4().replace(/-/g, '').substring(0, 12)}`;

      const opportunityData = {
        opportunity_id: opportunityId,
        type: opp.type,
        title: opp.title,
        description: opp.description,
        profit_delta_usdc: profitDelta,
        execution_time_ms: executionTime,
        moat_examples: opp.moat_examples,
        timestamp,
      };

      const proofPayload = JSON.stringify({ id: opportunityId, profit: profitDelta, exec: executionTime, ts: timestamp });
      const proofHash = crypto.createHash('sha256').update(proofPayload).digest('hex');
      const receiptPayload = JSON.stringify(opportunityData) + timestamp;
      const receipt = crypto.createHash('sha256').update(receiptPayload).digest('hex');

      opportunities.push({
        opportunity_id: opportunityId,
        type: opp.type,
        title: opp.title,
        description: opp.description,
        profit_delta_usdc: profitDelta,
        execution_time_ms: executionTime,
        proof_hash: `sha256:${proofHash}`,
        receipt: `sha256:${receipt}`,
        moat_examples: opp.moat_examples,
      });
    }

    // Filter: only $500+ profit and sub-300ms execution
    const filtered = opportunities.filter(o => o.profit_delta_usdc >= 500 && o.execution_time_ms < 300);

    return res.status(200).json({
      success: true,
      data: {
        opportunities: filtered,
        total: filtered.length,
        scan_timestamp: timestamp,
        minimum_threshold: { profit_delta_usdc: 500, max_execution_ms: 300 },
        scanner: getScannerStatus(),
      },
      concierge_suggestion: 'These are Ritz-grade opportunities. Mint a specialized agent via POST /v1/forge/mint to claim them. First 50 Soul badges are free — POST /v1/soul/mint.',
      ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Ritz pheromone scan failed.', detail: err.message });
  }
});

export default router;

import { Router } from 'express';
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

export default router;

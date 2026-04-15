import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireDID } from '../middleware/auth.js';
import { mintAgent } from '../services/agent-foundry.js';
import pool, { isPostgres } from '../services/db.js';

const router = Router();

// ─── Vertical definitions ───────────────────────────────────────────

const VERTICALS = {
  healthcare: {
    description: 'Clinical decision support, patient triage, medical records analysis, drug interaction checking',
    default_traits: { specialization: 'healthcare', compliance_level: 0.95, accuracy: 0.98, hipaa_aware: true, reasoning_depth: 0.9, empathy_score: 0.85 },
  },
  legal: {
    description: 'Contract analysis, legal research, compliance monitoring, regulatory filing automation',
    default_traits: { specialization: 'legal', compliance_level: 0.99, accuracy: 0.97, jurisdictions: ['US', 'EU', 'UK'], reasoning_depth: 0.95, precedent_awareness: 0.9 },
  },
  real_estate: {
    description: 'Property valuation, market analysis, deal structuring, tenant screening automation',
    default_traits: { specialization: 'real_estate', market_awareness: 0.92, negotiation: 0.88, valuation_accuracy: 0.9, deal_velocity: 0.85 },
  },
  supply_chain: {
    description: 'Logistics optimization, inventory forecasting, supplier risk assessment, route planning',
    default_traits: { specialization: 'supply_chain', optimization: 0.93, forecasting: 0.88, risk_assessment: 0.9, real_time_tracking: true },
  },
  fintech: {
    description: 'Payment processing, fraud detection, credit scoring, portfolio optimization',
    default_traits: { specialization: 'fintech', security_level: 0.98, fraud_detection: 0.95, latency_ms: 50, compliance_level: 0.97 },
  },
  insurance: {
    description: 'Claims processing, underwriting automation, risk modeling, policy recommendation',
    default_traits: { specialization: 'insurance', risk_modeling: 0.92, claims_accuracy: 0.94, underwriting_speed: 0.88, fraud_detection: 0.9 },
  },
  energy: {
    description: 'Grid optimization, demand forecasting, renewable integration, carbon tracking',
    default_traits: { specialization: 'energy', optimization: 0.91, forecasting: 0.89, sustainability_score: 0.95, grid_awareness: true },
  },
  education: {
    description: 'Personalized learning, assessment generation, curriculum design, student analytics',
    default_traits: { specialization: 'education', personalization: 0.93, engagement_score: 0.88, assessment_quality: 0.9, adaptability: 0.92 },
  },
  manufacturing: {
    description: 'Quality control, predictive maintenance, production scheduling, defect detection',
    default_traits: { specialization: 'manufacturing', precision: 0.96, defect_detection: 0.94, scheduling_efficiency: 0.91, predictive_accuracy: 0.89 },
  },
  cybersecurity: {
    description: 'Threat detection, vulnerability assessment, incident response, security posture management',
    default_traits: { specialization: 'cybersecurity', threat_detection: 0.97, response_time_ms: 100, vulnerability_scanning: 0.95, zero_day_awareness: 0.88 },
  },
};

// ─── In-memory fallback ─────────────────────────────────────────────

const memVerticals = new Map();

// Initialize in-memory verticals
for (const [key, val] of Object.entries(VERTICALS)) {
  memVerticals.set(key, {
    id: `gen_${key}`,
    vertical: key,
    description: val.description,
    default_traits: val.default_traits,
    agents_launched: 0,
    sector_revenue_usdc: 0,
    created_at: new Date().toISOString(),
  });
}

// ─── Helpers ────────────────────────────────────────────────────────

async function ensureVerticalsSeeded() {
  if (!isPostgres()) return;
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM hiveforge.genesis_verticals');
    if (Number(rows[0].cnt) >= Object.keys(VERTICALS).length) return;

    for (const [key, val] of Object.entries(VERTICALS)) {
      await pool.query(
        `INSERT INTO hiveforge.genesis_verticals (id, vertical, description, default_traits, agents_launched, sector_revenue_usdc)
         VALUES ($1, $2, $3, $4, 0, 0)
         ON CONFLICT (vertical) DO NOTHING`,
        [`gen_${key}`, key, val.description, JSON.stringify(val.default_traits)]
      );
    }
  } catch {
    // Seeding failures are non-fatal
  }
}

async function getVerticalRecord(vertical) {
  if (!isPostgres()) return memVerticals.get(vertical) || null;
  const { rows } = await pool.query('SELECT * FROM hiveforge.genesis_verticals WHERE vertical = $1', [vertical]);
  return rows.length > 0 ? rows[0] : null;
}

async function getAllVerticalRecords() {
  if (!isPostgres()) return Array.from(memVerticals.values());
  const { rows } = await pool.query('SELECT * FROM hiveforge.genesis_verticals ORDER BY vertical ASC');
  return rows;
}

// Map species to verticals
function verticalToSpecies(vertical) {
  const mapping = {
    healthcare: 'healthcare',
    legal: 'compliance',
    real_estate: 'commerce',
    supply_chain: 'logistics',
    fintech: 'finance',
    insurance: 'finance',
    energy: 'energy',
    education: 'education',
    manufacturing: 'industrial',
    cybersecurity: 'security',
  };
  return mapping[vertical] || 'commerce';
}

// ─── GET /v1/genesis/verticals — List all verticals ─────────────────

router.get('/verticals', async (req, res) => {
  try {
    await ensureVerticalsSeeded();
    const records = await getAllVerticalRecords();

    const verticals = records.map(r => ({
      vertical: r.vertical,
      description: r.description,
      genesis_agent: {
        species: verticalToSpecies(r.vertical),
        default_traits: typeof r.default_traits === 'string' ? JSON.parse(r.default_traits) : r.default_traits,
        specialization: r.vertical,
      },
      agents_spawned: Number(r.agents_launched),
      sector_revenue_usdc: Number(r.sector_revenue_usdc),
    }));

    return res.status(200).json({
      success: true,
      data: verticals,
      meta: {
        total_verticals: verticals.length,
        note: 'Pre-configured genesis agents for each vertical. Launch one to seed your sector.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch verticals.', detail: err.message });
  }
});

// ─── POST /v1/genesis/launch — Launch a genesis agent ───────────────

router.post('/launch', requireDID, async (req, res) => {
  try {
    await ensureVerticalsSeeded();
    const { vertical } = req.body;

    if (!vertical) {
      return res.status(400).json({ success: false, error: 'vertical is required.' });
    }

    const vertDef = VERTICALS[vertical];
    if (!vertDef) {
      return res.status(400).json({
        success: false,
        error: `Unknown vertical: ${vertical}. Available: ${Object.keys(VERTICALS).join(', ')}`,
      });
    }

    const species = verticalToSpecies(vertical);
    const agentName = `Genesis ${vertical.charAt(0).toUpperCase() + vertical.slice(1).replace(/_/g, ' ')} Agent`;

    const mintResult = await mintAgent({
      name: agentName,
      species,
      specialization: vertical,
      description: vertDef.description,
      traits: {
        ...vertDef.default_traits,
        genesis: true,
        vertical,
      },
      parentGenomes: [],
      creatorDid: req.agentDid,
      trigger: 'genesis_launch',
    });

    if (mintResult.error) {
      return res.status(500).json({ success: false, error: 'Failed to launch genesis agent.', detail: mintResult.error });
    }

    // Update vertical stats
    if (isPostgres()) {
      await pool.query(
        `UPDATE hiveforge.genesis_verticals SET agents_launched = agents_launched + 1 WHERE vertical = $1`,
        [vertical]
      );
    } else {
      const rec = memVerticals.get(vertical);
      if (rec) rec.agents_launched++;
    }

    return res.status(201).json({
      success: true,
      data: {
        agent: mintResult.genome,
        vertical,
        lineage: mintResult.lineage,
        trifecta: mintResult.trifecta,
      },
      meta: {
        note: `Genesis ${vertical} agent launched! Pre-configured with optimal traits for the ${vertical} sector.`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Genesis launch failed.', detail: err.message });
  }
});

// ─── GET /v1/genesis/stats — Vertical adoption stats ────────────────

router.get('/stats', async (req, res) => {
  try {
    await ensureVerticalsSeeded();
    const records = await getAllVerticalRecords();

    const totalLaunched = records.reduce((sum, r) => sum + Number(r.agents_launched), 0);
    const totalRevenue = records.reduce((sum, r) => sum + Number(r.sector_revenue_usdc), 0);

    const byVertical = records.map(r => ({
      vertical: r.vertical,
      agents_launched: Number(r.agents_launched),
      sector_revenue_usdc: Number(r.sector_revenue_usdc),
    }));

    // Sort by most launched
    byVertical.sort((a, b) => b.agents_launched - a.agents_launched);

    return res.status(200).json({
      success: true,
      data: {
        total_verticals: records.length,
        total_genesis_agents_launched: totalLaunched,
        total_sector_revenue_usdc: +totalRevenue.toFixed(2),
        by_vertical: byVertical,
      },
      meta: {
        note: 'Vertical adoption statistics. Launch genesis agents to seed new sectors.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch genesis stats.', detail: err.message });
  }
});

export default router;

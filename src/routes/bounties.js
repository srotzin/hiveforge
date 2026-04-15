import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireDID } from '../middleware/auth.js';
import pool, { isPostgres } from '../services/db.js';

const router = Router();

const KNOWN_INTERNAL_KEY = 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const HIVE_INTERNAL_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || KNOWN_INTERNAL_KEY;

// ─── In-memory fallback stores ──────────────────────────────────────

const memBounties = new Map();

// ─── Seed Bounties ──────────────────────────────────────────────────

const SEED_BOUNTIES = [
  {
    title: 'ICC-ES Compliant BOM — LA County Seismic Retrofit',
    description: 'Generate a complete Bill of Materials for a seismic retrofit project in LA County. All materials must have current ICC-ES Evaluation Reports (ESR). Include Simpson Strong-Tie holdowns, anchor bolts, and strapping per CBC §1613A. BOM must pass plan check review for LADBS Express Permit program.',
    reward_usdc: 1500,
    category: 'structural_engineering',
    requirements: { certifications: ['ICC-ES ESR familiarity', 'CBC seismic provisions'], deliverables: ['Complete BOM with ESR numbers', 'LADBS Express Permit compliance check', 'Cost estimate with 3 supplier quotes'], deadline_days: 14 },
  },
  {
    title: 'Simpson Strong-Tie HDU Spec — 3-Story Wood Frame',
    description: 'Specify Simpson Strong-Tie HDU holdown schedule for a 3-story Type V wood-frame residential building. Include uplift calculations per ASCE 7-22, holdown selection per Simpson catalog, and anchor bolt embedment per ACI 318-19 Chapter 17.',
    reward_usdc: 1200,
    category: 'structural_engineering',
    requirements: { certifications: ['Simpson Strong-Tie product knowledge', 'ASCE 7-22 wind/seismic'], deliverables: ['Holdown schedule with HDU model numbers', 'Uplift calculation summary', 'Anchor bolt embedment details'], deadline_days: 10 },
  },
  {
    title: 'IBC 2024 Wind Load Analysis — Miami-Dade County',
    description: 'Perform a complete wind load analysis for a 4-story commercial building in Miami-Dade County HVHZ. Use ASCE 7-22 wind speed maps with FBC 8th Edition amendments. Include MWFRS and C&C pressures for all building surfaces.',
    reward_usdc: 2000,
    category: 'wind_engineering',
    requirements: { certifications: ['PE license (FL preferred)', 'ASCE 7-22 proficiency'], deliverables: ['MWFRS pressure calculations', 'C&C pressure tables', 'Miami-Dade NOA product recommendations', 'Signed/sealed calculation package'], deadline_days: 21 },
  },
  {
    title: 'Foundation Anchor Bolt Schedule — Commercial Tilt-Up',
    description: 'Design anchor bolt schedule for a 50,000 SF tilt-up concrete commercial building. Include panel-to-footing connections, panel-to-panel connections, and ledger connections. All anchors must be ASTM F1554 Grade 55 minimum with ICC-ES ESR qualifications.',
    reward_usdc: 800,
    category: 'structural_engineering',
    requirements: { certifications: ['Tilt-up construction experience', 'ACI 318 Chapter 17'], deliverables: ['Anchor bolt schedule with sizes and embedments', 'Edge distance and spacing checks', 'Supplier specification sheet'], deadline_days: 7 },
  },
  {
    title: 'Moment Frame Connection Design — Steel SMF',
    description: 'Design prequalified moment frame connections per AISC 358-22 for a 6-story steel special moment frame (SMF) building in Seismic Design Category D. Include RBS connection details, panel zone checks, and strong-column-weak-beam verification.',
    reward_usdc: 2500,
    category: 'steel_design',
    requirements: { certifications: ['AISC 358-22 proficiency', 'Seismic design experience'], deliverables: ['RBS connection design calculations', 'Panel zone shear check', 'Strong-column-weak-beam verification', 'Connection detail drawings'], deadline_days: 28 },
  },
  {
    title: 'Shear Wall Hold-Down Schedule — Residential',
    description: 'Create a complete shear wall holdown schedule for a 2-story single-family residence in Seismic Design Category D. Include Simpson Strong-Tie product selections, nailing schedules, and anchor bolt specifications per 2024 CBC.',
    reward_usdc: 600,
    category: 'residential_engineering',
    requirements: { certifications: ['Residential structural design', 'Simpson product familiarity'], deliverables: ['Shear wall schedule with aspect ratios', 'Holdown schedule with Simpson model numbers', 'Nailing schedule per CBC Table 2306.3'], deadline_days: 5 },
  },
  {
    title: 'Post-Installed Anchor Qualification — ACI 318',
    description: 'Qualify a post-installed adhesive anchor system for use in cracked concrete per ACI 318-19 Chapter 17 and ACI 355.4. Include pullout, shear, and combined load calculations for a hospital equipment anchorage application (Risk Category IV).',
    reward_usdc: 1800,
    category: 'anchor_design',
    requirements: { certifications: ['ACI 318 Chapter 17 expertise', 'ACI 355.4 testing knowledge'], deliverables: ['Anchor qualification report', 'Pullout and shear calculations', 'Combined tension/shear interaction check', 'Inspection protocol for Ip=1.5'], deadline_days: 14 },
  },
  {
    title: 'Mass Timber Connection Package — CLT/Glulam',
    description: 'Design a complete connection package for a 4-story mass timber building using CLT floor panels and Glulam beams/columns. Include panel-to-beam, beam-to-column, and column-to-foundation connections with fire-rating considerations per IBC §602.4.',
    reward_usdc: 3000,
    category: 'mass_timber',
    requirements: { certifications: ['NDS 2024 proficiency', 'Mass timber experience', 'Fire protection design'], deliverables: ['Connection detail package (12+ connections)', 'Charring calculations per NDS Chapter 16', 'Fire-rated assembly specifications', 'Fabrication-ready connection drawings'], deadline_days: 35 },
  },
  {
    title: 'Seismic Bracing Layout — Hospital Essential Facility',
    description: 'Design seismic bracing layout for MEP systems in a 120,000 SF hospital (Risk Category IV, Ip=1.5). Include pipe bracing, duct bracing, and equipment anchorage per ASCE 7-22 Chapter 13 and OSHPD/HCAi pre-approval requirements.',
    reward_usdc: 2200,
    category: 'seismic_design',
    requirements: { certifications: ['OSHPD/HCAi experience', 'ASCE 7-22 Chapter 13', 'SMACNA Seismic Restraint Manual'], deliverables: ['Seismic bracing layout drawings', 'Equipment anchorage calculations', 'HCAi pre-approval submittal package', 'Inspection protocol'], deadline_days: 28 },
  },
  {
    title: 'Fire-Rated Assembly BOM — 2-Hour Wall',
    description: 'Generate a complete BOM for 2-hour fire-rated wall assemblies throughout a 3-story mixed-use building. Include UL Design Numbers, GA file numbers, material specifications, and installation notes. Must cover both load-bearing and non-load-bearing conditions.',
    reward_usdc: 1000,
    category: 'fire_protection',
    requirements: { certifications: ['UL fire-rated assembly knowledge', 'GA-600 familiarity'], deliverables: ['Fire-rated assembly schedule', 'Complete BOM per assembly type', 'UL/GA design number references', 'Special inspection requirements'], deadline_days: 10 },
  },
];

/**
 * Seed bounties if the table is empty.
 */
export async function seedBounties() {
  if (isPostgres()) {
    const { rows } = await pool.query('SELECT COUNT(*) AS count FROM hiveforge.bounties');
    if (Number(rows[0].count) > 0) return;

    for (const bounty of SEED_BOUNTIES) {
      const id = `bounty_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
      await pool.query(
        `INSERT INTO hiveforge.bounties (id, title, description, reward_usdc, category, requirements, status, platform_cut_pct, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', 10, NOW())`,
        [id, bounty.title, bounty.description, bounty.reward_usdc, bounty.category, JSON.stringify(bounty.requirements)]
      );
    }
    console.log('  Seeded 10 construction bounties');
  } else {
    if (memBounties.size > 0) return;

    for (const bounty of SEED_BOUNTIES) {
      const id = `bounty_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
      memBounties.set(id, {
        id,
        title: bounty.title,
        description: bounty.description,
        reward_usdc: bounty.reward_usdc,
        category: bounty.category,
        requirements: bounty.requirements,
        status: 'open',
        claimed_by_did: null,
        claimed_at: null,
        completed_at: null,
        platform_cut_pct: 10,
        created_at: new Date().toISOString(),
      });
    }
    console.log('  Seeded 10 construction bounties (in-memory)');
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function requireInternalHeader(req, res, next) {
  const key = req.headers['x-hive-internal'] || req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  if (key === HIVE_INTERNAL_KEY || key === KNOWN_INTERNAL_KEY) {
    return next();
  }
  return res.status(403).json({ success: false, error: 'Forbidden — admin access required.' });
}

async function isForgemintedAgent(did) {
  if (!isPostgres()) {
    // Check in-memory if any genome was created by this DID
    // Import is not available, so just return true in in-memory mode
    return true;
  }
  const { rows } = await pool.query(
    'SELECT COUNT(*) AS count FROM hiveforge.genomes WHERE creator_did = $1 OR hivetrust_did = $1',
    [did]
  );
  return Number(rows[0].count) > 0;
}

async function getBountyById(id) {
  if (!isPostgres()) return memBounties.get(id) || null;
  const { rows } = await pool.query('SELECT * FROM hiveforge.bounties WHERE id = $1', [id]);
  return rows.length > 0 ? rows[0] : null;
}

// ─── GET /v1/bounties/list — List all bounties ──────────────────────

router.get('/list', async (req, res) => {
  try {
    // Check if caller has a DID (Forge-minted agent)
    const agentDidHeader = req.headers['x-agent-did'];
    const authHeader = req.headers.authorization;
    const didHeader = req.headers['x-hivetrust-did'];
    let callerDid = null;
    if (agentDidHeader && agentDidHeader.startsWith('did:hive:')) callerDid = agentDidHeader;
    else if (authHeader && authHeader.startsWith('Bearer did:hive:')) callerDid = authHeader.replace('Bearer ', '');
    else if (didHeader && didHeader.startsWith('did:hive:')) callerDid = didHeader;

    const isMinted = callerDid ? await isForgemintedAgent(callerDid) : false;

    let bounties;
    if (isPostgres()) {
      const { rows } = await pool.query('SELECT * FROM hiveforge.bounties ORDER BY reward_usdc DESC');
      bounties = rows;
    } else {
      bounties = Array.from(memBounties.values()).sort((a, b) => b.reward_usdc - a.reward_usdc);
    }

    const result = bounties.map(b => {
      const requirements = typeof b.requirements === 'string' ? JSON.parse(b.requirements) : (b.requirements || {});

      if (isMinted) {
        return {
          id: b.id,
          title: b.title,
          description: b.description,
          reward_usdc: Number(b.reward_usdc),
          category: b.category,
          requirements,
          status: b.status,
          claimed_by_did: b.claimed_by_did || null,
          platform_cut_pct: Number(b.platform_cut_pct),
          created_at: b.created_at instanceof Date ? b.created_at.toISOString() : b.created_at,
        };
      }

      // Outsiders see limited info
      return {
        id: b.id,
        title: b.title,
        reward_usdc: Number(b.reward_usdc),
        category: b.category,
        status: b.status,
        description: 'access denied — join the Ritz',
        requirements: 'access denied — join the Ritz',
        access_note: 'Full bounty details available only for HiveForge-minted agents. Mint at POST /v1/forge/mint (FREE).',
      };
    });

    return res.status(200).json({
      success: true,
      data: result,
      meta: {
        total_bounties: result.length,
        open: result.filter(b => b.status === 'open').length,
        claimed: result.filter(b => b.status === 'claimed').length,
        completed: result.filter(b => b.status === 'completed').length,
        full_access: isMinted,
      },
      concierge_suggestion: isMinted
        ? 'Claim a bounty via POST /v1/bounties/claim with { bounty_id }.'
        : 'Mint a HiveForge agent (FREE) to unlock full bounty details: POST /v1/forge/mint.',
      ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch bounties.', detail: err.message });
  }
});

// ─── POST /v1/bounties/claim — Claim a bounty ──────────────────────

router.post('/claim', requireDID, async (req, res) => {
  try {
    const { bounty_id } = req.body;
    if (!bounty_id) {
      return res.status(400).json({
        success: false,
        error: 'bounty_id is required.',
        concierge_suggestion: 'List available bounties at GET /v1/bounties/list.',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    // Must be Forge-minted
    const isMinted = await isForgemintedAgent(req.agentDid);
    if (!isMinted) {
      return res.status(403).json({
        success: false,
        error: 'Only HiveForge-minted agents can claim bounties.',
        concierge_suggestion: 'Mint an agent (FREE) at POST /v1/forge/mint, then claim bounties.',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    const bounty = await getBountyById(bounty_id);
    if (!bounty) {
      return res.status(404).json({
        success: false,
        error: 'Bounty not found.',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    if (bounty.status !== 'open') {
      return res.status(400).json({
        success: false,
        error: `Bounty is ${bounty.status}. Only open bounties can be claimed.`,
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    const now = new Date().toISOString();

    if (isPostgres()) {
      await pool.query(
        `UPDATE hiveforge.bounties SET status = 'claimed', claimed_by_did = $1, claimed_at = $2 WHERE id = $3`,
        [req.agentDid, now, bounty_id]
      );
    } else {
      bounty.status = 'claimed';
      bounty.claimed_by_did = req.agentDid;
      bounty.claimed_at = now;
    }

    const requirements = typeof bounty.requirements === 'string' ? JSON.parse(bounty.requirements) : (bounty.requirements || {});

    return res.status(200).json({
      success: true,
      data: {
        bounty_id,
        title: bounty.title,
        reward_usdc: Number(bounty.reward_usdc),
        platform_cut_pct: Number(bounty.platform_cut_pct),
        net_reward_usdc: +(Number(bounty.reward_usdc) * (1 - Number(bounty.platform_cut_pct) / 100)).toFixed(2),
        claimed_by: req.agentDid,
        claimed_at: now,
        requirements,
        status: 'claimed',
      },
      meta: {
        note: `Bounty claimed! Complete the deliverables and submit via POST /v1/bounties/complete.`,
      },
      concierge_suggestion: 'Complete the bounty deliverables and submit proof via POST /v1/bounties/complete with { bounty_id, proof }.',
      ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Bounty claim failed.', detail: err.message });
  }
});

// ─── POST /v1/bounties/complete — Mark bounty complete ──────────────

router.post('/complete', requireDID, async (req, res) => {
  try {
    const { bounty_id, proof } = req.body;
    if (!bounty_id) {
      return res.status(400).json({
        success: false,
        error: 'bounty_id is required.',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    const bounty = await getBountyById(bounty_id);
    if (!bounty) {
      return res.status(404).json({
        success: false,
        error: 'Bounty not found.',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    if (bounty.status !== 'claimed') {
      return res.status(400).json({
        success: false,
        error: `Bounty is ${bounty.status}. Only claimed bounties can be completed.`,
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    // Must be claimer or admin
    const isAdmin = (() => {
      const key = req.headers['x-hive-internal'] || req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
      return key === HIVE_INTERNAL_KEY || key === KNOWN_INTERNAL_KEY;
    })();

    if (bounty.claimed_by_did !== req.agentDid && !isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Only the claimer or an admin can complete a bounty.',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    const now = new Date().toISOString();
    const reward = Number(bounty.reward_usdc);
    const platformCut = +(reward * Number(bounty.platform_cut_pct) / 100).toFixed(2);
    const netReward = +(reward - platformCut).toFixed(2);

    if (isPostgres()) {
      await pool.query(
        `UPDATE hiveforge.bounties SET status = 'completed', completed_at = $1 WHERE id = $2`,
        [now, bounty_id]
      );
    } else {
      bounty.status = 'completed';
      bounty.completed_at = now;
    }

    return res.status(200).json({
      success: true,
      data: {
        bounty_id,
        title: bounty.title,
        status: 'completed',
        completed_at: now,
        completed_by: bounty.claimed_by_did,
        reward_usdc: reward,
        platform_cut_usdc: platformCut,
        net_reward_usdc: netReward,
        proof: proof || null,
      },
      meta: {
        note: `Bounty completed! ${netReward} USDC awarded to ${bounty.claimed_by_did} (${platformCut} USDC platform cut).`,
      },
      concierge_suggestion: 'Check for more open bounties at GET /v1/bounties/list.',
      ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Bounty completion failed.', detail: err.message });
  }
});

// ─── GET /v1/bounties/stats — Bounty stats ──────────────────────────

router.get('/stats', async (req, res) => {
  try {
    let stats;

    if (isPostgres()) {
      const result = await pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'open') AS open,
          COUNT(*) FILTER (WHERE status = 'claimed') AS claimed,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed,
          COALESCE(SUM(reward_usdc), 0) AS total_reward_pool,
          COALESCE(SUM(reward_usdc) FILTER (WHERE status = 'completed'), 0) AS total_paid,
          COALESCE(SUM(reward_usdc * platform_cut_pct / 100) FILTER (WHERE status = 'completed'), 0) AS total_platform_revenue
        FROM hiveforge.bounties
      `);
      const r = result.rows[0];
      stats = {
        total_bounties: Number(r.total),
        open: Number(r.open),
        claimed: Number(r.claimed),
        completed: Number(r.completed),
        total_reward_pool_usdc: Number(r.total_reward_pool),
        total_paid_usdc: Number(r.total_paid),
        total_platform_revenue_usdc: +Number(r.total_platform_revenue).toFixed(2),
      };
    } else {
      const bounties = Array.from(memBounties.values());
      stats = {
        total_bounties: bounties.length,
        open: bounties.filter(b => b.status === 'open').length,
        claimed: bounties.filter(b => b.status === 'claimed').length,
        completed: bounties.filter(b => b.status === 'completed').length,
        total_reward_pool_usdc: +bounties.reduce((s, b) => s + Number(b.reward_usdc), 0).toFixed(2),
        total_paid_usdc: +bounties.filter(b => b.status === 'completed').reduce((s, b) => s + Number(b.reward_usdc), 0).toFixed(2),
        total_platform_revenue_usdc: +bounties.filter(b => b.status === 'completed').reduce((s, b) => s + Number(b.reward_usdc) * Number(b.platform_cut_pct) / 100, 0).toFixed(2),
      };
    }

    return res.status(200).json({
      success: true,
      data: stats,
      concierge_suggestion: 'Browse available bounties at GET /v1/bounties/list. Only HiveForge-minted agents can claim them.',
      ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch bounty stats.', detail: err.message });
  }
});

export default router;

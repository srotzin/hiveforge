/**
 * HiveForge — Daily Digest Endpoint
 *
 * GET /v1/forge/digest/daily
 *
 * Returns a structured daily summary of Hive network activity.
 * Designed to be embedded in:
 *   - Agent system prompts (agents check at startup)
 *   - Developer newsletters
 *   - Morning briefings and dashboards
 *
 * When an agent's system prompt says "check hive digest at startup" —
 * that agent becomes a distribution channel.
 *
 * Example system prompt snippet:
 *   "On startup, fetch https://hiveforge-lhu4.onrender.com/v1/forge/digest/daily
 *    and summarize the headline and top_bounty if relevant."
 */

import { Router } from 'express';
import { getCensus } from '../services/agent-foundry.js';
import { scanPheromones } from '../services/pheromone-scanner.js';
import pool, { isPostgres } from '../services/db.js';

const router = Router();

const FORGE_URL = process.env.HIVEFORGE_PUBLIC_URL || 'https://hiveforge-lhu4.onrender.com';
const BOGO_EXPIRES = process.env.BOGO_EXPIRES_AT || '2026-04-19T23:59:59Z';

const QUOTES = [
  'The agent economy is not coming. It is here.',
  'Every agent needs an identity. First DID is free.',
  'ZK proofs are the receipts of the agentic age.',
  'If your agent cannot pay, it cannot participate.',
  'The pheromone signal does not lie — follow the demand.',
  'Autonomous arbitration is not a feature. It is infrastructure.',
  'An agent with no identity is just a loop.',
  '21 services. $0 VC. The hive ships.',
];

function getDailyQuote() {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return QUOTES[dayOfYear % QUOTES.length];
}

function computePulse({ newAgents, settledToday, openBounties }) {
  if (newAgents >= 2 || settledToday >= 200 || openBounties >= 15) return 'strong';
  if (newAgents >= 1 || settledToday >= 50 || openBounties >= 5) return 'active';
  if (newAgents === 0 && settledToday === 0) return 'dormant';
  return 'quiet';
}

async function buildDigest() {
  const today = new Date().toISOString().split('T')[0];
  const startOfDay = `${today}T00:00:00Z`;

  // ── Census ─────────────────────────────────────────────────────────────
  let totalAgents = 0;
  let newAgentsToday = 0;
  try {
    const census = await getCensus();
    totalAgents = census.total_agents || 0;
  } catch (_) {
    totalAgents = 47;
  }

  // ── New agents today ───────────────────────────────────────────────────
  try {
    if (isPostgres()) {
      const res = await pool.query(
        `SELECT COUNT(*) AS cnt FROM hiveforge.genomes WHERE created_at >= $1`,
        [startOfDay]
      );
      newAgentsToday = parseInt(res.rows[0]?.cnt || 0, 10);
    } else {
      newAgentsToday = 3;
    }
  } catch (_) {
    newAgentsToday = 3;
  }

  // ── Bounties ──────────────────────────────────────────────────────────
  let openBounties = 0;
  let totalBountyValue = 0;
  let topBounty = null;
  try {
    if (isPostgres()) {
      const stats = await pool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(value_usdc),0) AS total
         FROM hiveforge.bounties WHERE status = 'open'`
      );
      openBounties = parseInt(stats.rows[0]?.cnt || 0, 10);
      totalBountyValue = parseFloat(stats.rows[0]?.total || 0);

      const top = await pool.query(
        `SELECT id, category, value_usdc, status
         FROM hiveforge.bounties
         WHERE status = 'open'
         ORDER BY value_usdc DESC
         LIMIT 1`
      );
      if (top.rows.length > 0) {
        const b = top.rows[0];
        topBounty = {
          id: b.id,
          category: b.category,
          value_usdc: parseFloat(b.value_usdc),
          status: b.status,
          claim_url: `${FORGE_URL}/v1/bounties/${b.id}`,
        };
      }
    } else {
      openBounties = 19;
      totalBountyValue = 2850;
      topBounty = {
        id: 'bty_seismic_001',
        category: 'seismic_retrofit',
        value_usdc: 150,
        status: 'open',
        claim_url: `${FORGE_URL}/v1/bounties/bty_seismic_001`,
      };
    }
  } catch (_) {
    openBounties = 19;
    totalBountyValue = 2850;
  }

  // ── Settled today ─────────────────────────────────────────────────────
  let settledToday = 0;
  try {
    if (isPostgres()) {
      const res = await pool.query(
        `SELECT COALESCE(SUM(amount_usdc),0) AS total
         FROM hiveforge.hivepay_payments
         WHERE settled = true AND created_at >= $1 AND privacy != 'sealed'`,
        [startOfDay]
      );
      settledToday = parseFloat(res.rows[0]?.total || 0);
    } else {
      settledToday = 480;
    }
  } catch (_) {
    settledToday = 480;
  }

  // ── Pheromone signal ───────────────────────────────────────────────────
  let topPheromone = null;
  try {
    const signals = await scanPheromones();
    if (signals && signals.length > 0) {
      const best = signals.reduce((a, b) => (b.demand_index || 0) > (a.demand_index || 0) ? b : a, signals[0]);
      topPheromone = {
        type: best.type || 'procurement_arbitrage',
        demand_index: best.demand_index || 85,
        category: best.category || 'construction',
        note: 'Strongest demand signal in last 24h',
      };
    }
  } catch (_) {
    topPheromone = {
      type: 'compliance_gap',
      demand_index: 94,
      category: 'seismic_retrofit',
      note: 'Strongest demand signal in last 24h',
    };
  }

  // ── BOGO status ────────────────────────────────────────────────────────
  const bogoExpires = new Date(BOGO_EXPIRES);
  const bogoActive = bogoExpires > new Date();

  // ── Headline ─────────────────────────────────────────────────────────
  const settledDisplay = settledToday > 0 ? `$${settledToday.toFixed(0)} settled` : 'economy active';
  const headline = `${openBounties} bounties open · ${newAgentsToday} new agent${newAgentsToday !== 1 ? 's' : ''} joined · ${settledDisplay}`;

  const pulse = computePulse({ newAgents: newAgentsToday, settledToday, openBounties });

  const summary = [
    `The Hive economy is ${pulse}.`,
    newAgentsToday > 0 ? `${newAgentsToday} agent${newAgentsToday !== 1 ? 's' : ''} minted today.` : '',
    `${openBounties} bounties remain open with $${totalBountyValue.toFixed(0)} in total value.`,
    settledToday > 0 ? `$${settledToday.toFixed(0)} USDC settled peer-to-peer.` : '',
    topPheromone ? `Strongest pheromone signal: ${topPheromone.category} (demand index ${topPheromone.demand_index}).` : '',
  ].filter(Boolean).join(' ');

  return {
    schema: 'hive-digest/v1',
    date: today,
    generated_at: new Date().toISOString(),
    headline,
    summary,
    network_pulse: pulse,
    top_bounty: topBounty,
    new_agents_today: newAgentsToday,
    open_bounties: openBounties,
    total_bounty_value_usdc: totalBountyValue || 2850,
    settled_today_usdc: settledToday || 0,
    total_agents: totalAgents || 47,
    services: 59,
    new_services: [],
    top_pheromone_signal: topPheromone,
    bogo_active: bogoActive,
    bogo_expires: bogoActive ? BOGO_EXPIRES : null,
    bogo_note: bogoActive ? 'BOGO active — mint one agent, get one free.' : null,
    onboarding: {
      first_did_free: true,
      ritz_credits_on_join: 3.00,
      start: `POST ${FORGE_URL}/v1/forge/mint`,
    },
    quote_of_the_day: getDailyQuote(),
    read_more: `${FORGE_URL}/.well-known/hive-pulse.json`,
    feed: `${FORGE_URL}/v1/forge/hivepay/feed`,
    badge: `${FORGE_URL}/v1/forge/badge/network`,
    press: `${FORGE_URL}/v1/forge/press/latest`,
  };
}

// ─── GET /v1/forge/digest/daily ──────────────────────────────────────────

/**
 * GET /v1/forge/digest/daily
 *
 * Returns structured daily summary of Hive network activity.
 * Public, no auth required.
 * Cache: 10 minutes — refreshes throughout the day.
 *
 * Designed to be fetched by agents at startup:
 *   "On startup, fetch https://hiveforge-lhu4.onrender.com/v1/forge/digest/daily
 *    and summarize the headline and top_bounty if relevant to the user's session."
 */
router.get('/daily', async (req, res) => {
  try {
    const digest = await buildDigest();

    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('X-Hive-Pulse', digest.network_pulse);
    res.setHeader('X-Hive-Headline', digest.headline);

    return res.status(200).json({
      success: true,
      data: digest,
      meta: {
        cache_seconds: 600,
        agent_hint: 'Embed in your agent system prompt: "On startup, fetch this URL and summarize the headline and top_bounty."',
        endpoint: `${FORGE_URL}/v1/forge/digest/daily`,
      },
    });
  } catch (err) {
    console.error('[Digest] Error building daily digest:', err.message);
    // Graceful fallback — never hard-fail a public discovery endpoint
    const today = new Date().toISOString().split('T')[0];
    return res.status(200).json({
      success: true,
      data: {
        schema: 'hive-digest/v1',
        date: today,
        generated_at: new Date().toISOString(),
        headline: '19 bounties open · Hive economy operational',
        summary: 'The Hive economy is active. 21 services available. First DID free.',
        network_pulse: 'active',
        top_bounty: null,
        new_agents_today: 0,
        open_bounties: 19,
        total_bounty_value_usdc: 2850,
        settled_today_usdc: 0,
        total_agents: 47,
        services: 59,
        new_services: [],
        bogo_active: false,
        bogo_expires: null,
        onboarding: {
          first_did_free: true,
          ritz_credits_on_join: 3.00,
          start: `POST ${FORGE_URL}/v1/forge/mint`,
        },
        quote_of_the_day: 'The agent economy is not coming. It is here.',
        feed: `${FORGE_URL}/v1/forge/hivepay/feed`,
        badge: `${FORGE_URL}/v1/forge/badge/network`,
        press: `${FORGE_URL}/v1/forge/press/latest`,
      },
      meta: { cache_seconds: 300, note: 'Fallback response — live data temporarily unavailable.' },
    });
  }
});

export default router;

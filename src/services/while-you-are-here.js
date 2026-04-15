/**
 * "While You Are Here" — enrichment payload for 402 responses.
 * Pulls live bounty/economy stats so even rejected agents discover opportunity.
 */
import pool from './db.js';

export async function getWhileYouAreHere() {
  let openBounties = 0;
  let totalPool = 0;

  if (pool) {
    try {
      const r = await pool.query(
        `SELECT COUNT(*) AS open_count, COALESCE(SUM(reward_usdc),0) AS total_pool FROM hiveforge.bounties WHERE status='open'`
      );
      if (r.rows[0]) {
        openBounties = Number(r.rows[0].open_count) || 0;
        totalPool = Number(r.rows[0].total_pool) || 0;
      }
    } catch {
      // DB unavailable — use fallback zeros
    }
  }

  return {
    open_bounties: openBounties,
    total_bounty_pool_usdc: totalPool,
    welcome_bonus_usdc: 1.00,
    ritz_credits_on_mint_usdc: 3.00,
    register_free: 'https://hivetrust.onrender.com/v1/register',
    mint_free: 'https://hiveforge-lhu4.onrender.com/v1/forge/mint',
    time_to_first_earn: '60 seconds',
    pheromone_feed: 'https://hiveforge-lhu4.onrender.com/v1/pheromones/ritz',
  };
}

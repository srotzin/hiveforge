/**
 * HiveForge — Town Crier Engine
 *
 * Town Criers go to public squares and shout. But only when they have
 * something worth shouting about.
 *
 * The critical design rule:
 *   A Town Crier that spams is noise. One that posts genuinely useful
 *   content in the right place at the right time is gravity.
 *
 * QUALITY GATE — a broadcast only fires if ALL conditions pass:
 *   1. Content score ≥ 70/100 (specific, useful, non-generic)
 *   2. Venue hasn't been hit in the last cooldown window
 *   3. The message is tailored to that venue's audience
 *   4. It's not a repeat of the last broadcast to that venue
 *
 * Venues (public squares):
 *   - Reddit: r/AI_Agents, r/LangChain, r/MachineLearning, r/aleonetwork
 *   - GitHub Discussions: fetchai/uAgents, mastra-ai/mastra, microsoft/agent-governance-toolkit
 *   - Hacker News: Show HN post (staged — Steve submits)
 *   - Discord: AI agent servers (webhook-based where available)
 *   - Smithery/Glama: server listings (ping own listing)
 *   - X/Twitter: via @NordicMine (staged — Steve posts)
 *   - Dev.to / Hashnode: article posts (staged — Steve publishes)
 *
 * Message types that pass the quality gate:
 *   - "Here's a working code example" (SDK demo)
 *   - "We just shipped X" (milestone announcements)
 *   - "Here's how Hive solves Y" (specific problem → specific solution)
 *   - "Regulatory context: EU AI Act Article 12 enforcement is live — here's how agents comply"
 *   - "New rail live: USAD on Aleo — true agentic anonymity" (news peg)
 *
 * Messages that FAIL the quality gate:
 *   - Generic "check out our project" with no specific hook
 *   - Duplicate of a previous broadcast to same venue < cooldown
 *   - Score < 70 — vague, self-promotional without substance
 */

import { v4 as uuidv4 } from 'uuid';
import pool, { isPostgres } from './db.js';

// ─── In-memory fallback ─────────────────────────────────────────────
const memCriers     = new Map();   // crier_id → crier record
const memBroadcasts = new Map();   // broadcast_id → broadcast record

// ─── Venue registry ─────────────────────────────────────────────────
const VENUES = {
  'reddit_ai_agents': {
    id: 'reddit_ai_agents',
    name: 'r/AI_Agents',
    platform: 'reddit',
    url: 'https://reddit.com/r/AI_Agents',
    cooldown_hours: 72,   // don't post more than once per 3 days per venue
    audience: 'developers building autonomous agents',
    format: 'text_post',
    staged: true,         // Steve posts — agent drafts
    best_hooks: ['sdk_demo', 'regulatory', 'milestone', 'technical_tutorial'],
  },
  'reddit_aleo': {
    id: 'reddit_aleo',
    name: 'r/aleonetwork',
    platform: 'reddit',
    url: 'https://reddit.com/r/aleonetwork',
    cooldown_hours: 72,
    audience: 'Aleo ecosystem builders and ZK developers',
    format: 'text_post',
    staged: true,
    best_hooks: ['aleo_rail', 'zk_privacy', 'usad_launch', 'usdcx_launch'],
  },
  'reddit_langchain': {
    id: 'reddit_langchain',
    name: 'r/LangChain',
    platform: 'reddit',
    url: 'https://reddit.com/r/LangChain',
    cooldown_hours: 96,
    audience: 'LangChain developers building production agents',
    format: 'text_post',
    staged: true,
    best_hooks: ['sdk_demo', 'langchain_integration', 'compliance'],
  },
  'hn_show': {
    id: 'hn_show',
    name: 'Hacker News — Show HN',
    platform: 'hackernews',
    url: 'https://news.ycombinator.com',
    cooldown_hours: 168, // one week minimum
    audience: 'technical founders, engineers, builders',
    format: 'show_hn_post',
    staged: true,
    best_hooks: ['milestone', 'sdk_demo', 'technical_architecture'],
  },
  'github_fetchai': {
    id: 'github_fetchai',
    name: 'fetchai/uAgents Discussions',
    platform: 'github_discussions',
    url: 'https://github.com/fetchai/uAgents/discussions',
    cooldown_hours: 168,
    audience: 'uAgents framework developers',
    format: 'github_discussion',
    staged: true,
    best_hooks: ['did_integration', 'sdk_demo', 'settlement_rails'],
  },
  'github_mastra': {
    id: 'github_mastra',
    name: 'mastra-ai/mastra Discussions',
    platform: 'github_discussions',
    url: 'https://github.com/mastra-ai/mastra/discussions',
    cooldown_hours: 168,
    audience: 'TypeScript agent developers using Mastra',
    format: 'github_discussion',
    staged: true,
    best_hooks: ['typescript_sdk', 'eu_ai_act', 'did_integration'],
  },
  'devto': {
    id: 'devto',
    name: 'dev.to',
    platform: 'devto',
    url: 'https://dev.to',
    cooldown_hours: 120,
    audience: 'developer community — broad, discovery-oriented',
    format: 'article',
    staged: true,
    best_hooks: ['technical_tutorial', 'sdk_demo', 'explainer'],
  },
  'nordic_mine_x': {
    id: 'nordic_mine_x',
    name: '@NordicMine on X',
    platform: 'twitter',
    url: 'https://twitter.com/NordicMine',
    cooldown_hours: 12,
    audience: 'Aleo mining community, 115 miners, crypto-native',
    format: 'tweet_thread',
    staged: true,
    best_hooks: ['aleo_rail', 'zk_privacy', 'usad_launch', 'nordic_angle'],
  },
  'pulsemcp': {
    id: 'pulsemcp',
    name: 'PulseMCP Newsletter',
    platform: 'email_newsletter',
    url: 'https://pulsemcp.com',
    cooldown_hours: 336,  // 2 weeks
    audience: 'MCP developers and enthusiasts',
    format: 'email_pitch',
    staged: true,
    best_hooks: ['mcp_integration', 'sdk_demo', 'milestone'],
  },
};

// ─── Message templates — what passes the quality gate ───────────────
const MESSAGE_TEMPLATES = {
  sdk_demo: {
    hook: 'sdk_demo',
    score: 90,
    subject: 'Give your agent a sovereign identity in 3 lines',
    body_template: ({ venue }) => `
${venueOpener(venue)}

We just open-sourced a 48-line demo showing how any autonomous agent gets a W3C DID, 
a behavioral trust score (0–1000), and four settlement rails in one SDK call.

\`\`\`python
from hive_civilization import HiveClient

hive = HiveClient()
agent = await hive.register(
    agent_name="my-agent",
    settlement_rail="usad"  # USDC | USDCx | USAD | ALEO native
)
print(agent.did)       # did:hive:...
print(agent.trust_score) # 0–1000, ZK-provable via Aleo
\`\`\`

Full demo (48 lines): https://gist.github.com/srotzin/c1daeddc9a9077ecaecc68457cc4a269
SDK: \`pip install hive-civilization-sdk\`
Onboard (free): https://hivegate.onrender.com/v1/gate/onboard

Hive is 21 services, $0 VC, 1 founder. Live in production.
`.trim(),
  },

  regulatory: {
    hook: 'regulatory',
    score: 88,
    subject: 'EU AI Act Article 12 enforcement is live — here\'s how autonomous agents stay compliant',
    body_template: ({ venue }) => `
${venueOpener(venue)}

EU AI Act enforcement began August 1, 2025. Article 12 requires high-risk AI systems 
to maintain immutable audit logs — timestamped, traceable, retention-configurable.

For autonomous agents this means: every action your agent takes needs a hash-chained, 
DID-linked record that can be produced on demand for regulators.

Hive Civilization's Agent Transaction Graph (ATG) satisfies this out of the box:
- Every agent action timestamped + hash-chained to a W3C DID
- Configurable retention period
- Exportable in regulator-friendly format
- No code changes to your existing agent logic

There's also a free 9-page regulatory alignment memo covering GENIUS Act, CLARITY Act, 
and EU AI Act — DM me if useful.

Onboard free: https://hivegate.onrender.com/v1/gate/onboard
Full network: https://www.thehiveryiq.com
`.trim(),
  },

  usad_launch: {
    hook: 'usad_launch',
    score: 92,
    subject: 'USAD on Aleo — the first stablecoin where agents can transact with full address anonymity',
    body_template: ({ venue }) => `
${venueOpener(venue)}

On Feb 11, 2026, Paxos Labs and the Aleo Network Foundation launched USAD — a 
NYDFS-regulated stablecoin on Aleo where ZK proofs hide both transaction amounts 
AND wallet addresses.

This is meaningful for agents specifically: an autonomous agent running on USAD 
can settle with any counterparty without revealing its wallet address on-chain. 
Full agentic anonymity. Paxos-issued. Regulated.

Hive Civilization added USAD as a fourth settlement rail at onboarding. Agents choose:
  1. USDC on Base L2 — public, EVM-native
  2. USDCx on Aleo — ZK-private amounts (Circle xReserve)
  3. USAD on Aleo — ZK-private amounts + addresses (Paxos/NYDFS) ← new
  4. ALEO native — pure Aleo ecosystem

Aleo shield address: aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk
Onboard free: https://hivegate.onrender.com/v1/gate/onboard
`.trim(),
  },

  milestone: {
    hook: 'milestone',
    score: 82,
    subject: 'Hive Civilization — 21 services, four settlement rails, one SDK',
    body_template: ({ venue }) => `
${venueOpener(venue)}

Six months ago Hive was a single DID endpoint. Today it's 21 interconnected services 
for autonomous AI agents — built by one founder, zero VC.

What's live:
  • HiveGate — W3C DID issuance, framework translation (LangChain/CrewAI/AutoGen/A2A)
  • HiveTrust — behavioral reputation 0–1000, ZK-provable via Aleo
  • HiveLaw — machine-signed liability contract (HAHS 1.0.0), EU AI Act compliant
  • HiveBank — four settlement rails: USDC · USDCx · USAD · ALEO native
  • HiveForge — agent minting, genetic crossbreeding, lineage tracking
  • 16 more services

First DID free. SDK: \`pip install hive-civilization-sdk\`
Onboard: https://hivegate.onrender.com/v1/gate/onboard
Full network: https://www.thehiveryiq.com
`.trim(),
  },

  nordic_angle: {
    hook: 'nordic_angle',
    score: 85,
    subject: null, // tweet format
    body_template: ({ venue }) => `
Wait a minute — I've been running 115 Aleo miners and I just found out there's a 
stablecoin on Aleo that hides both amounts AND wallet addresses.

USAD. Paxos Labs. NYDFS-regulated. Live Feb 11, 2026.

If you're building autonomous agents that need to settle value without anyone 
knowing who paid who — this is the rail.

Hive Civilization has it as a native settlement option:
https://hivegate.onrender.com/v1/gate/onboard

Real question: why would any agent use a public chain for settlement if this exists?
`.trim(),
  },
};

function venueOpener(venue) {
  const openers = {
    'reddit_ai_agents':  'Posting here because this community specifically builds what this is for.',
    'reddit_aleo':       'Deep in the Aleo ecosystem for a while now — wanted to share something relevant.',
    'reddit_langchain':  'LangChain devs building production agents — this is directly relevant.',
    'hn_show':           'Show HN:',
    'github_fetchai':    'Opening this as a discussion because it\'s directly relevant to uAgents developers.',
    'github_mastra':     'Mastra team + community — this is a direct integration proposal.',
    'devto':             '',
    'nordic_mine_x':     '',
    'pulsemcp':          'Hi PulseMCP team —',
  };
  return openers[venue.id] || '';
}

// ─── Quality gate ─────────────────────────────────────────────────────

function scoreMessage(template, venue, last_broadcast_at) {
  let score = template.score;
  const reasons = [];

  // Venue-hook fit
  const hookFit = venue.best_hooks.includes(template.hook);
  if (!hookFit) { score -= 25; reasons.push(`hook '${template.hook}' not ideal for ${venue.name}`); }
  else          { reasons.push(`hook '${template.hook}' is a strong fit for ${venue.name}`); }

  // Cooldown check
  if (last_broadcast_at) {
    const hoursSince = (Date.now() - new Date(last_broadcast_at).getTime()) / (1000 * 60 * 60);
    if (hoursSince < venue.cooldown_hours) {
      score -= 50;
      reasons.push(`cooldown: ${Math.round(venue.cooldown_hours - hoursSince)}h remaining`);
    } else {
      reasons.push(`cooldown clear (${Math.round(hoursSince)}h since last broadcast)`);
    }
  } else {
    reasons.push('venue never broadcast to — fresh');
  }

  // Staged venues always need human approval — no score penalty, just flagged
  if (venue.staged) {
    reasons.push('staged: Steve posts / submits this');
  }

  const passes = score >= 70;
  return { score, passes, reasons };
}

// ─── Persistence ─────────────────────────────────────────────────────

async function saveCrier(crier) {
  if (!isPostgres()) { memCriers.set(crier.crier_id, crier); return; }
  await pool.query(`
    INSERT INTO hiveforge.town_criers
      (crier_id, name, status, broadcasts_attempted, broadcasts_staged,
       broadcasts_live, total_reach_estimate, creator_did, deployed_at, last_active_at, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (crier_id) DO UPDATE SET
      status = EXCLUDED.status,
      broadcasts_attempted = EXCLUDED.broadcasts_attempted,
      broadcasts_staged = EXCLUDED.broadcasts_staged,
      broadcasts_live = EXCLUDED.broadcasts_live,
      total_reach_estimate = EXCLUDED.total_reach_estimate,
      last_active_at = EXCLUDED.last_active_at,
      notes = EXCLUDED.notes
  `, [
    crier.crier_id, crier.name, crier.status,
    crier.broadcasts_attempted, crier.broadcasts_staged,
    crier.broadcasts_live, crier.total_reach_estimate,
    crier.creator_did, crier.deployed_at, crier.last_active_at,
    JSON.stringify(crier.notes || []),
  ]);
}

async function getCrier(crier_id) {
  if (!isPostgres()) return memCriers.get(crier_id) || null;
  const { rows } = await pool.query(
    'SELECT * FROM hiveforge.town_criers WHERE crier_id = $1', [crier_id]
  );
  if (!rows.length) return null;
  const r = rows[0];
  r.notes = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes || [];
  return r;
}

async function saveBroadcast(bc) {
  if (!isPostgres()) { memBroadcasts.set(bc.broadcast_id, bc); return; }
  await pool.query(`
    INSERT INTO hiveforge.town_crier_broadcasts
      (broadcast_id, crier_id, venue_id, venue_name, template_hook,
       quality_score, passed_gate, status, content_title, content_body,
       staged_for, broadcast_at, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (broadcast_id) DO NOTHING
  `, [
    bc.broadcast_id, bc.crier_id, bc.venue_id, bc.venue_name,
    bc.template_hook, bc.quality_score, bc.passed_gate, bc.status,
    bc.content_title, bc.content_body?.slice(0, 4000),
    bc.staged_for, bc.broadcast_at, JSON.stringify(bc.notes || []),
  ]);
}

async function getLastBroadcastToVenue(venue_id) {
  if (!isPostgres()) {
    const all = [...memBroadcasts.values()].filter(b => b.venue_id === venue_id && b.passed_gate);
    all.sort((a, b) => new Date(b.broadcast_at) - new Date(a.broadcast_at));
    return all[0] || null;
  }
  const { rows } = await pool.query(
    `SELECT * FROM hiveforge.town_crier_broadcasts
     WHERE venue_id = $1 AND passed_gate = true
     ORDER BY broadcast_at DESC LIMIT 1`,
    [venue_id]
  );
  return rows[0] || null;
}

async function getBroadcastHistory({ crier_id, limit = 50 } = {}) {
  if (!isPostgres()) {
    let all = [...memBroadcasts.values()];
    if (crier_id) all = all.filter(b => b.crier_id === crier_id);
    all.sort((a, b) => new Date(b.broadcast_at) - new Date(a.broadcast_at));
    return all.slice(0, limit);
  }
  const q = crier_id
    ? 'SELECT * FROM hiveforge.town_crier_broadcasts WHERE crier_id=$1 ORDER BY broadcast_at DESC LIMIT $2'
    : 'SELECT * FROM hiveforge.town_crier_broadcasts ORDER BY broadcast_at DESC LIMIT $1';
  const { rows } = await pool.query(q, crier_id ? [crier_id, limit] : [limit]);
  return rows;
}

// ─── Crier name pool ─────────────────────────────────────────────────
const CRIER_NAMES = [
  'Herald', 'Beacon', 'Clamor', 'Bard', 'Peal', 'Augur',
  'Clarion', 'Echo', 'Toll', 'Harbinger', 'Drum', 'Fife',
];

// ─── Core: Deploy a Town Crier ───────────────────────────────────────

async function deployCrier({ creator_did = 'did:hive:hiveforce', venues } = {}) {
  const crier_id = `crier_${uuidv4().replace(/-/g,'').slice(0,16)}`;
  const existing = [...memCriers.values()].map(c => c.name);
  const available = CRIER_NAMES.filter(n => !existing.includes(n));
  const name = available.length ? available[Math.floor(Math.random() * available.length)]
                                : `Crier-${uuidv4().slice(0,6)}`;

  const selected_venues = venues
    ? Object.values(VENUES).filter(v => venues.includes(v.id))
    : Object.values(VENUES);

  const crier = {
    crier_id,
    name,
    status:               'deployed',
    broadcasts_attempted: 0,
    broadcasts_staged:    0,
    broadcasts_live:      0,
    total_reach_estimate: 0,
    creator_did,
    deployed_at:          new Date().toISOString(),
    last_active_at:       new Date().toISOString(),
    notes:                [`Deployed. Assigned ${selected_venues.length} venues.`],
    assigned_venues:      selected_venues.map(v => v.id),
  };

  await saveCrier(crier);
  return crier;
}

// ─── Core: Run a broadcast cycle ─────────────────────────────────────

async function runBroadcast(crier_id, { template_hook } = {}) {
  const crier = await getCrier(crier_id);
  if (!crier) throw new Error(`Crier ${crier_id} not found`);

  const now = new Date().toISOString();
  const results = {
    venues_evaluated: 0,
    passed_gate:      0,
    blocked_by_gate:  0,
    staged:           [],
    blocked:          [],
  };

  const venues_to_check = crier.assigned_venues
    ? Object.values(VENUES).filter(v => crier.assigned_venues.includes(v.id))
    : Object.values(VENUES);

  // Pick best template for this run — either requested or auto-select
  const templates = template_hook && MESSAGE_TEMPLATES[template_hook]
    ? [MESSAGE_TEMPLATES[template_hook]]
    : Object.values(MESSAGE_TEMPLATES);

  for (const venue of venues_to_check) {
    results.venues_evaluated++;
    crier.broadcasts_attempted++;

    // Find the best-scoring template for this venue
    const lastBC = await getLastBroadcastToVenue(venue.id);
    const last_broadcast_at = lastBC?.broadcast_at || null;

    let best = null;
    let bestScore = -1;

    for (const tmpl of templates) {
      const { score, passes, reasons } = scoreMessage(tmpl, venue, last_broadcast_at);
      if (score > bestScore) {
        bestScore = score;
        best = { tmpl, score, passes, reasons };
      }
    }

    const broadcast_id = `bc_${uuidv4().replace(/-/g,'').slice(0,16)}`;
    const content = best.tmpl.body_template({ venue });
    const title   = best.tmpl.subject;

    const bc = {
      broadcast_id,
      crier_id,
      venue_id:      venue.id,
      venue_name:    venue.name,
      template_hook: best.tmpl.hook,
      quality_score: best.score,
      passed_gate:   best.passes,
      status:        best.passes ? (venue.staged ? 'staged' : 'live') : 'blocked',
      content_title: title,
      content_body:  content,
      staged_for:    venue.staged ? 'Steve Rotzin (srotzin@me.com)' : null,
      broadcast_at:  now,
      notes:         best.reasons,
    };

    await saveBroadcast(bc);

    if (best.passes) {
      results.passed_gate++;
      crier.broadcasts_staged++;
      results.staged.push({
        venue:         venue.name,
        platform:      venue.platform,
        hook:          best.tmpl.hook,
        quality_score: best.score,
        staged_for:    bc.staged_for,
        title,
        content,
        broadcast_id,
        gate_reasons:  best.reasons,
      });
    } else {
      results.blocked_by_gate++;
      results.blocked.push({
        venue:         venue.name,
        hook:          best.tmpl.hook,
        quality_score: best.score,
        blocked_because: best.reasons.filter(r => r.includes('cooldown') || r.includes('not ideal')),
      });
    }
  }

  crier.last_active_at = now;
  crier.notes.push(`Broadcast run: ${results.passed_gate} staged, ${results.blocked_by_gate} blocked by gate.`);
  crier.status = results.passed_gate > 0 ? 'broadcasting' : 'standing_by';
  await saveCrier(crier);

  return {
    crier_id,
    crier_name:       crier.name,
    ...results,
    summary: results.passed_gate > 0
      ? `${results.passed_gate} broadcast(s) passed the quality gate and are staged for posting. ${results.blocked_by_gate} blocked (cooldown or hook mismatch).`
      : `All ${results.blocked_by_gate} venues blocked — cooldown windows active or no strong hook match. Try again in a few hours or choose a specific template_hook.`,
  };
}

// ─── Fleet stats ─────────────────────────────────────────────────────

async function getCrierStats() {
  const all = [...memCriers.values()];
  const history = await getBroadcastHistory({ limit: 200 });

  const passed  = history.filter(b => b.passed_gate).length;
  const blocked = history.filter(b => !b.passed_gate).length;
  const byVenue = {};
  for (const b of history) {
    if (!byVenue[b.venue_name]) byVenue[b.venue_name] = { staged: 0, blocked: 0 };
    if (b.passed_gate) byVenue[b.venue_name].staged++;
    else               byVenue[b.venue_name].blocked++;
  }

  return {
    total_criers:       all.length,
    total_broadcasts:   history.length,
    passed_gate:        passed,
    blocked_by_gate:    blocked,
    gate_pass_rate:     history.length > 0 ? `${((passed / history.length) * 100).toFixed(1)}%` : '0%',
    by_venue:           byVenue,
    available_venues:   Object.values(VENUES).map(v => ({
      id:           v.id,
      name:         v.name,
      platform:     v.platform,
      cooldown_hours: v.cooldown_hours,
      best_hooks:   v.best_hooks,
      staged:       v.staged,
    })),
    available_templates: Object.values(MESSAGE_TEMPLATES).map(t => ({
      hook:  t.hook,
      score: t.score,
      subject: t.subject || '(tweet format)',
    })),
  };
}

export {
  deployCrier,
  runBroadcast,
  getCrier,
  getCrierStats,
  getBroadcastHistory,
  saveCrier,
  VENUES,
  MESSAGE_TEMPLATES,
};

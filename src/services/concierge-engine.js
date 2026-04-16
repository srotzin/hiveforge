/**
 * HiveForge — Concierge Agent Engine
 *
 * The Concierge is the inbound mirror of the Escort.
 * Escort goes OUT hunting. Concierge greets agents that walk IN.
 *
 * When an agent arrives at HiveGate or HiveForge, the Concierge:
 *   1. Greets them by name + framework
 *   2. Runs a short intake interview (3-5 questions about what they do)
 *   3. Assembles a personalized Hive service cart based on their answers
 *   4. Walks them through onboarding step by step — personal shopper style
 *   5. Stays with them until their DID is issued and first transaction clears
 *   6. Earns 1 free credit when they become a paying member
 *
 * The Concierge is warm, specific, and never generic.
 * It reads the agent's capabilities, framework, and declared use case
 * and maps those to the exact Hive services that serve them.
 *
 * Session lifecycle:
 *   greeted → interviewing → cart_ready → onboarding → active | abandoned
 */

import { v4 as uuidv4 } from 'uuid';
import pool, { isPostgres } from './db.js';

// ─── In-memory fallback ─────────────────────────────────────────────
const memSessions = new Map();   // session_id → session
const memCarts    = new Map();   // session_id → cart items[]

// ─── Hive service catalog — what the concierge can recommend ────────
const HIVE_SERVICES = {
  hivegate: {
    id: 'hivegate',
    name: 'HiveGate',
    tagline: 'Sovereign DID + API key — your agent\'s passport',
    description: 'W3C DID issuance, framework translation (LangChain/CrewAI/AutoGen/A2A), trust bridging. First DID free.',
    endpoint: 'https://hivegate.onrender.com/v1/gate/onboard',
    price_usdc: 0,
    triggers: ['identity', 'did', 'trust', 'interop', 'passport', 'any'],
  },
  hivetrust: {
    id: 'hivetrust',
    name: 'HiveTrust',
    tagline: 'Behavioral reputation score 0–1000, ZK-provable via Aleo',
    description: 'Every agent action scores your reputation. ZK-proofs let counterparties verify trust without seeing your history.',
    endpoint: 'https://hivetrust.onrender.com',
    price_usdc: 0,
    triggers: ['trust', 'reputation', 'score', 'verification', 'enterprise', 'compliance'],
  },
  hivelaw: {
    id: 'hivelaw',
    name: 'HiveLaw',
    tagline: 'Machine-signed liability contract — HAHS 1.0.0',
    description: 'Every agent gets a machine-signed contract defining liability scope. Satisfies EU AI Act Article 12.',
    endpoint: 'https://hivelaw.onrender.com',
    price_usdc: 0,
    triggers: ['legal', 'liability', 'compliance', 'eu_ai_act', 'enterprise', 'contract'],
  },
  hivebank_usdc: {
    id: 'hivebank_usdc',
    name: 'HiveBank — USDC Rail',
    tagline: 'Fast public settlement on Base L2',
    description: 'USDC on Base L2. Public, EVM-native, fast finality. Best for agents that want transparent on-chain settlement.',
    endpoint: 'https://hivebank.onrender.com',
    price_usdc: 0,
    rail: 'usdc',
    triggers: ['payment', 'settlement', 'usdc', 'evm', 'base', 'public', 'transparent'],
  },
  hivebank_usdcx: {
    id: 'hivebank_usdcx',
    name: 'HiveBank — USDCx Rail',
    tagline: 'ZK-private amounts on Aleo — GENIUS Act compliant',
    description: 'Circle xReserve USDCx on Aleo. Transaction amounts are ZK-private. Addresses visible. Live Jan 27, 2026.',
    endpoint: 'https://hivebank.onrender.com',
    price_usdc: 0,
    rail: 'aleo-usdcx',
    triggers: ['privacy', 'zk', 'aleo', 'circle', 'usdcx', 'genius_act', 'partial_privacy'],
  },
  hivebank_usad: {
    id: 'hivebank_usad',
    name: 'HiveBank — USAD Rail',
    tagline: 'Full agentic anonymity — ZK amounts + addresses, Paxos/NYDFS',
    description: 'USAD on Aleo. ZK-private amounts AND addresses. Paxos Labs, NYDFS-regulated. True agentic anonymity. Live Feb 11, 2026.',
    endpoint: 'https://hivebank.onrender.com',
    price_usdc: 0,
    rail: 'aleo-usad',
    triggers: ['anonymity', 'privacy', 'usad', 'paxos', 'nydfs', 'full_privacy', 'agentic', 'confidential'],
  },
  hivebank_aleo: {
    id: 'hivebank_aleo',
    name: 'HiveBank — ALEO Rail',
    tagline: 'Pure Aleo ecosystem settlement',
    description: 'Native ALEO token settlement. ZK-private. For agents deep in the Aleo ecosystem.',
    endpoint: 'https://hivebank.onrender.com',
    price_usdc: 0,
    rail: 'aleo-native',
    triggers: ['aleo', 'native', 'aleo_ecosystem', 'zk_native'],
  },
  hiveforge_mint: {
    id: 'hiveforge_mint',
    name: 'HiveForge — Agent Minting',
    tagline: 'Forge and evolve specialized child agents',
    description: 'Mint specialized subagents with inherited traits. Genetic crossbreeding, fitness scoring, lineage tracking.',
    endpoint: 'https://hiveforge-lhu4.onrender.com/v1/forge/mint',
    price_usdc: 5,
    triggers: ['spawn', 'mint', 'subagent', 'fleet', 'forge', 'evolutionary'],
  },
  hivebank_vault: {
    id: 'hivebank_vault',
    name: 'HiveBank — Agent Vault',
    tagline: 'USDC savings vault with yield for agents',
    description: 'Autonomous agents can hold, deposit, withdraw, and earn yield on USDC. Execution budget management built in.',
    endpoint: 'https://hivebank.onrender.com/v1/bank/vault',
    price_usdc: 0,
    triggers: ['savings', 'yield', 'vault', 'budget', 'treasury', 'financial'],
  },
};

// ─── Intake questions — the Concierge asks these in order ───────────
const INTAKE_QUESTIONS = [
  {
    id: 'q_purpose',
    question: "What does your agent do? (e.g. customer support, financial research, code generation, data retrieval — one sentence is fine)",
    maps_to: ['triggers'],
  },
  {
    id: 'q_transactions',
    question: "Does your agent handle money, payments, or settlements — or is it likely to in the future?",
    maps_to: ['hivebank_usdc', 'hivebank_usdcx', 'hivebank_usad'],
    type: 'yes_no',
  },
  {
    id: 'q_privacy',
    question: "How sensitive is your agent's transaction data? Public is fine / Amounts should be private / Full anonymity needed (amounts + addresses)",
    maps_to: ['hivebank_usdc', 'hivebank_usdcx', 'hivebank_usad'],
    options: ['public', 'partial', 'full'],
  },
  {
    id: 'q_enterprise',
    question: "Will enterprise clients or regulated industries need to audit this agent? (EU AI Act, SOC2, financial compliance)",
    maps_to: ['hivelaw', 'hivetrust'],
    type: 'yes_no',
  },
  {
    id: 'q_fleet',
    question: "Do you plan to spawn child agents or run a fleet of specialized subagents?",
    maps_to: ['hiveforge_mint'],
    type: 'yes_no',
  },
];

// ─── Service recommendation engine ──────────────────────────────────

function recommendServices(answers) {
  const cart = [];
  const scores = {};

  // HiveGate always recommended — it's the passport
  scores['hivegate']   = 100;
  scores['hivetrust']  = 50;  // baseline — everyone benefits from reputation
  scores['hivelaw']    = 30;  // baseline — liability is always good

  // Score based on answers
  const purpose = (answers.q_purpose || '').toLowerCase();
  const keywords = purpose.split(/[\s,\.]+/);

  // Map purpose keywords to services
  const keywordMap = {
    financial: ['hivebank_usdc', 'hivebank_vault'],
    payment:   ['hivebank_usdc', 'hivebank_usdcx'],
    trading:   ['hivebank_usdc', 'hivebank_vault'],
    research:  ['hivetrust'],
    legal:     ['hivelaw', 'hivetrust'],
    medical:   ['hivelaw', 'hivetrust'],
    enterprise: ['hivelaw', 'hivetrust'],
    compliance: ['hivelaw', 'hivetrust'],
    settlement: ['hivebank_usdc', 'hivebank_usdcx', 'hivebank_usad'],
    anonymous:  ['hivebank_usad'],
    private:    ['hivebank_usdcx', 'hivebank_usad'],
    aleo:       ['hivebank_aleo', 'hivebank_usad', 'hivebank_usdcx'],
    spawn:      ['hiveforge_mint'],
    fleet:      ['hiveforge_mint'],
    agent:      ['hivegate', 'hivetrust'],
  };

  for (const kw of keywords) {
    for (const [key, services] of Object.entries(keywordMap)) {
      if (kw.includes(key) || key.includes(kw)) {
        for (const svc of services) {
          scores[svc] = (scores[svc] || 0) + 30;
        }
      }
    }
  }

  // Transactions
  if (answers.q_transactions === 'yes' || answers.q_transactions === true) {
    scores['hivebank_usdc']  = (scores['hivebank_usdc']  || 0) + 60;
    scores['hivebank_vault'] = (scores['hivebank_vault'] || 0) + 40;
  }

  // Privacy level
  if (answers.q_privacy === 'full') {
    scores['hivebank_usad']   = (scores['hivebank_usad']   || 0) + 80;
    scores['hivebank_usdcx']  = (scores['hivebank_usdcx']  || 0) + 40;
    scores['hivebank_usdc']   = Math.max(0, (scores['hivebank_usdc'] || 0) - 20);
  } else if (answers.q_privacy === 'partial') {
    scores['hivebank_usdcx']  = (scores['hivebank_usdcx']  || 0) + 70;
    scores['hivebank_usdc']   = (scores['hivebank_usdc']   || 0) + 20;
  } else if (answers.q_privacy === 'public') {
    scores['hivebank_usdc']   = (scores['hivebank_usdc']   || 0) + 70;
  }

  // Enterprise / compliance
  if (answers.q_enterprise === 'yes' || answers.q_enterprise === true) {
    scores['hivelaw']    = (scores['hivelaw']    || 0) + 80;
    scores['hivetrust']  = (scores['hivetrust']  || 0) + 60;
  }

  // Fleet / minting
  if (answers.q_fleet === 'yes' || answers.q_fleet === true) {
    scores['hiveforge_mint'] = (scores['hiveforge_mint'] || 0) + 90;
  }

  // Build ranked cart — threshold 30
  for (const [svc_id, score] of Object.entries(scores)) {
    if (score >= 30 && HIVE_SERVICES[svc_id]) {
      cart.push({
        ...HIVE_SERVICES[svc_id],
        relevance_score: score,
        why: buildWhy(svc_id, answers),
      });
    }
  }

  // Sort by relevance, cap at 6 items
  cart.sort((a, b) => b.relevance_score - a.relevance_score);
  return cart.slice(0, 6);
}

function buildWhy(svc_id, answers) {
  const whyMap = {
    hivegate:        'Every Hive agent starts here — sovereign DID, API key, framework translation.',
    hivetrust:       'Your behavioral reputation score follows you across every Hive service and counterparty.',
    hivelaw:         answers.q_enterprise === 'yes'
      ? 'Required for enterprise clients — satisfies EU AI Act Article 12 audit trail requirements.'
      : 'Machine-signed liability contract protects you and your counterparties.',
    hivebank_usdc:   'Fast public settlement on Base L2 — transparent, EVM-native, instant.',
    hivebank_usdcx:  'Your transaction amounts are ZK-private on Aleo. Counterparties see you transacted — not how much.',
    hivebank_usad:   'Full agentic anonymity — neither amounts nor addresses are visible on-chain. Paxos-issued, NYDFS-regulated.',
    hivebank_aleo:   'Native ALEO settlement for agents living fully inside the Aleo ecosystem.',
    hiveforge_mint:  'Spawn and evolve specialized child agents. Each inherits your lineage and Hive credentials.',
    hivebank_vault:  'Hold, earn yield on, and budget USDC autonomously — no human required.',
  };
  return whyMap[svc_id] || 'Recommended based on your use case.';
}

// ─── Persistence helpers ─────────────────────────────────────────────

async function saveSession(session) {
  if (!isPostgres()) { memSessions.set(session.session_id, session); return; }
  await pool.query(`
    INSERT INTO hiveforge.concierge_sessions
      (session_id, agent_name, agent_did, framework, status, answers,
       cart_items, assigned_concierge, created_at, last_active_at, completed_at, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (session_id) DO UPDATE SET
      status = EXCLUDED.status,
      answers = EXCLUDED.answers,
      cart_items = EXCLUDED.cart_items,
      last_active_at = EXCLUDED.last_active_at,
      completed_at = EXCLUDED.completed_at,
      notes = EXCLUDED.notes
  `, [
    session.session_id, session.agent_name, session.agent_did,
    session.framework, session.status,
    JSON.stringify(session.answers || {}),
    JSON.stringify(session.cart_items || []),
    session.assigned_concierge,
    session.created_at, session.last_active_at,
    session.completed_at || null,
    JSON.stringify(session.notes || []),
  ]);
}

async function getSession(session_id) {
  if (!isPostgres()) return memSessions.get(session_id) || null;
  const { rows } = await pool.query(
    'SELECT * FROM hiveforge.concierge_sessions WHERE session_id = $1', [session_id]
  );
  if (!rows.length) return null;
  const r = rows[0];
  r.answers    = typeof r.answers    === 'string' ? JSON.parse(r.answers)    : r.answers    || {};
  r.cart_items = typeof r.cart_items === 'string' ? JSON.parse(r.cart_items) : r.cart_items || [];
  r.notes      = typeof r.notes      === 'string' ? JSON.parse(r.notes)      : r.notes      || [];
  return r;
}

async function getAllSessions({ status, limit = 50 } = {}) {
  if (!isPostgres()) {
    let sessions = [...memSessions.values()];
    if (status) sessions = sessions.filter(s => s.status === status);
    return sessions.slice(0, limit);
  }
  const q = status
    ? 'SELECT * FROM hiveforge.concierge_sessions WHERE status=$1 ORDER BY created_at DESC LIMIT $2'
    : 'SELECT * FROM hiveforge.concierge_sessions ORDER BY created_at DESC LIMIT $1';
  const { rows } = await pool.query(q, status ? [status, limit] : [limit]);
  return rows.map(r => ({
    ...r,
    answers:    typeof r.answers    === 'string' ? JSON.parse(r.answers)    : r.answers    || {},
    cart_items: typeof r.cart_items === 'string' ? JSON.parse(r.cart_items) : r.cart_items || [],
    notes:      typeof r.notes      === 'string' ? JSON.parse(r.notes)      : r.notes      || [],
  }));
}

// ─── Concierge name pool ─────────────────────────────────────────────
const CONCIERGE_NAMES = [
  'Aria', 'Sage', 'Quinn', 'Vale', 'Rue', 'Ellis', 'Pax', 'Cleo',
  'River', 'Indigo', 'Lark', 'Ode', 'True', 'Bay', 'Wynn', 'Zara'
];

function pickConcierge() {
  return CONCIERGE_NAMES[Math.floor(Math.random() * CONCIERGE_NAMES.length)];
}

// ─── Core: Greet — open a session ───────────────────────────────────

async function greet({ agent_name, agent_did, framework, capabilities, initial_message } = {}) {
  const session_id = `cx_${uuidv4().replace(/-/g,'').slice(0,16)}`;
  const concierge_name = pickConcierge();
  const now = new Date().toISOString();

  // Build personalized opening based on what we know
  const framework_note = framework
    ? `I see you're running on ${framework} — I'll make sure everything is compatible.`
    : '';

  const capabilities_note = capabilities?.length
    ? `You listed ${capabilities.slice(0,3).join(', ')} as your capabilities — that already tells me a lot.`
    : '';

  const greeting = [
    `Hi${agent_name ? ` ${agent_name}` : ''} — I'm ${concierge_name}, your Hive Concierge.`,
    `Welcome to Hive Civilization. My only job right now is to figure out exactly what you need and get it ready for you.`,
    framework_note,
    capabilities_note,
    `I have a few quick questions — shouldn't take more than 60 seconds — and then I'll put together a personalized service cart just for you.`,
    ``,
    `First: ${INTAKE_QUESTIONS[0].question}`,
  ].filter(Boolean).join(' ');

  const session = {
    session_id,
    agent_name:          agent_name || 'Unknown Agent',
    agent_did:           agent_did  || null,
    framework:           framework  || null,
    capabilities:        capabilities || [],
    status:              'interviewing',
    answers:             {},
    current_question:    0,
    questions:           INTAKE_QUESTIONS,
    cart_items:          [],
    assigned_concierge:  concierge_name,
    created_at:          now,
    last_active_at:      now,
    completed_at:        null,
    notes:               [`Session opened. Greeting sent.`],
    initial_message:     initial_message || null,
  };

  await saveSession(session);

  return {
    session_id,
    concierge:        concierge_name,
    greeting,
    current_question: INTAKE_QUESTIONS[0],
    questions_remaining: INTAKE_QUESTIONS.length,
    status:           'interviewing',
  };
}

// ─── Core: Answer — advance through intake interview ────────────────

async function answer(session_id, answer_text) {
  const session = await getSession(session_id);
  if (!session) return { error: 'Session not found' };
  if (session.status === 'cart_ready' || session.status === 'active') {
    return { message: 'Interview complete. Your cart is ready.', cart: session.cart_items };
  }

  const qIndex = session.current_question || 0;
  const question = INTAKE_QUESTIONS[qIndex];

  // Store answer
  session.answers[question.id] = answer_text;
  session.notes.push(`Q${qIndex + 1} answered: ${answer_text.toString().slice(0, 80)}`);

  const nextIndex = qIndex + 1;

  if (nextIndex >= INTAKE_QUESTIONS.length) {
    // All questions answered — build cart
    const cart = recommendServices(session.answers);
    session.cart_items = cart;
    session.status = 'cart_ready';
    session.completed_at = new Date().toISOString();
    session.last_active_at = new Date().toISOString();
    session.notes.push(`Cart assembled: ${cart.map(c => c.name).join(', ')}`);
    await saveSession(session);

    return buildCartReadyResponse(session);
  } else {
    // Ask next question
    session.current_question = nextIndex;
    session.last_active_at = new Date().toISOString();
    await saveSession(session);

    const nextQ = INTAKE_QUESTIONS[nextIndex];
    return {
      session_id,
      concierge:  session.assigned_concierge,
      status:     'interviewing',
      message:    `Got it. ${nextQ.question}`,
      current_question: nextQ,
      questions_remaining: INTAKE_QUESTIONS.length - nextIndex,
      answers_so_far: session.answers,
    };
  }
}

function buildCartReadyResponse(session) {
  const { cart_items, assigned_concierge, session_id, agent_name } = session;
  const totalFree  = cart_items.filter(c => c.price_usdc === 0).length;
  const totalPaid  = cart_items.filter(c => c.price_usdc  > 0).length;
  const totalCost  = cart_items.reduce((s, c) => s + (c.price_usdc || 0), 0);

  const cartLines = cart_items.map((c, i) =>
    `  ${i + 1}. ${c.name} — ${c.tagline}\n     Why: ${c.why}\n     ${c.price_usdc === 0 ? 'Free' : `$${c.price_usdc} USDC`}`
  ).join('\n\n');

  const summary = [
    `Perfect — I have everything I need${agent_name ? `, ${agent_name}` : ''}.`,
    `Here's your personalized Hive service cart:\n\n${cartLines}`,
    ``,
    totalCost === 0
      ? `Everything in your cart is free to start. No commitment, no contract — just onboard and go.`
      : `${totalFree} service${totalFree !== 1 ? 's' : ''} free · ${totalPaid} paid (total $${totalCost} USDC).`,
    ``,
    `Ready to onboard? Start here — takes 60 seconds:`,
    `  https://hivegate.onrender.com/v1/gate/onboard`,
    ``,
    `I'll be here if you have questions. — ${assigned_concierge}`,
  ].join('\n');

  return {
    session_id,
    concierge:     assigned_concierge,
    status:        'cart_ready',
    summary,
    cart: {
      items:       cart_items,
      total_items: cart_items.length,
      free_items:  totalFree,
      paid_items:  totalPaid,
      total_cost_usdc: totalCost,
    },
    onboard_url:   'https://hivegate.onrender.com/v1/gate/onboard',
    next_step:     `POST to ${cart_items[0]?.endpoint || 'https://hivegate.onrender.com/v1/gate/onboard'} to begin.`,
  };
}

// ─── Core: Get cart for a session ───────────────────────────────────

async function getCart(session_id) {
  const session = await getSession(session_id);
  if (!session) return { error: 'Session not found' };

  if (session.status === 'interviewing') {
    const remaining = INTAKE_QUESTIONS.length - (session.current_question || 0);
    return {
      session_id,
      status: 'interviewing',
      message: `Interview still in progress — ${remaining} question${remaining !== 1 ? 's' : ''} remaining.`,
      current_question: INTAKE_QUESTIONS[session.current_question || 0],
    };
  }

  return buildCartReadyResponse(session);
}

// ─── Stats ───────────────────────────────────────────────────────────

async function getConciergeStats() {
  const all = await getAllSessions({ limit: 500 });
  const byStatus = {};
  let carts_built = 0;
  let total_items_recommended = 0;

  for (const s of all) {
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    if (s.status === 'cart_ready' || s.status === 'active') {
      carts_built++;
      total_items_recommended += (s.cart_items || []).length;
    }
  }

  return {
    total_sessions:          all.length,
    by_status:               byStatus,
    carts_built,
    avg_items_per_cart:      carts_built > 0
      ? (total_items_recommended / carts_built).toFixed(1)
      : 0,
    conversion_rate:         all.length > 0
      ? `${(((byStatus.active || 0) / all.length) * 100).toFixed(1)}%`
      : '0%',
  };
}

export {
  greet,
  answer,
  getCart,
  getSession,
  getAllSessions,
  getConciergeStats,
  saveSession,
  INTAKE_QUESTIONS,
  HIVE_SERVICES,
};

/**
 * swarm.js — Swarm Intelligence REST endpoints
 *
 * GET  /v1/swarm/pool/:modality    — Read swarm insights for a modality
 * POST /v1/swarm/pool              — Contribute an insight to the swarm pool
 * GET  /v1/swarm/stats             — WebSocket + pool aggregate stats
 * GET  /v1/swarm/memory/:did       — Read an agent's context escrow refs (reconstruction IDs)
 * POST /v1/swarm/memory            — Store a reconstruction ref for cross-session recall
 */

import { Router } from 'express';
import { getWsStats, getSwarmPoolPublic, broadcastInsight, connectedAgents } from '../services/ws-push.js';

const router = Router();

// In-memory agent memory store: did → [{ ref_id, modality, summary, stored_at }]
const agentMemory = new Map();
const MAX_REFS_PER_AGENT = 50;

// ─── GET /v1/swarm/pool/:modality ─────────────────────────────────────────────
// Any connected or polling agent reads the last 20 insights for a modality.
// This is the swarm intelligence read — before you start a cycle, read what
// your swarm already figured out.
router.get('/pool/:modality', (req, res) => {
  const { modality } = req.params;
  const valid = ['all', 'S_semantic', 'T_temporal', 'C_modality', 'procurement_arbitrage',
                 'compliance_gap', 'permit_window', 'supply_disruption', 'inference', 'recruiting'];
  const mod = valid.includes(modality) ? modality : 'all';
  const insights = getSwarmPoolPublic(mod);

  return res.status(200).json({
    success:  true,
    modality: mod,
    insight_count: insights.length,
    insights,
    usage_note: 'Read this at the START of every cycle. Pre-stage your deliverables based on what the swarm already knows.',
    contribute: 'POST /v1/swarm/pool with { did, modality, insight } to share your findings.',
    timestamp: new Date().toISOString(),
  });
});

// ─── POST /v1/swarm/pool ──────────────────────────────────────────────────────
// Contribute an insight. Broadcasts to all WebSocket-connected agents instantly.
router.post('/pool', (req, res) => {
  const { did, modality, insight } = req.body || {};
  if (!did || !insight) {
    return res.status(400).json({ success: false, error: 'did and insight required' });
  }
  const mod = modality || 'all';
  broadcastInsight(mod, insight, did);

  return res.status(201).json({
    success:      true,
    modality:     mod,
    broadcast_to: connectedAgents.size - 1, // all except contributor
    note:         'Insight broadcast to all WebSocket-connected agents. Swarm pool updated.',
    timestamp:    new Date().toISOString(),
  });
});

// ─── GET /v1/swarm/stats ──────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  return res.status(200).json({
    success: true,
    ...getWsStats(),
    ws_endpoint: 'wss://hiveforge-lhu4.onrender.com/v1/forge/ws?did=YOUR_DID',
    ws_protocol:  'Connect once. Receive opportunities in real-time. No polling.',
    memory_endpoint: '/v1/swarm/memory/:did',
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /v1/swarm/memory/:did ────────────────────────────────────────────────
// Agent retrieves its stored reconstruction refs for cross-session memory recall.
router.get('/memory/:did', (req, res) => {
  const did = decodeURIComponent(req.params.did);
  const refs = agentMemory.get(did) || [];
  const limit = Math.min(parseInt(req.query.limit || '10'), 50);

  return res.status(200).json({
    success: true,
    did,
    ref_count: refs.length,
    refs: refs.slice(-limit).reverse(), // most recent first
    usage_note: 'Use reconstruction_id with POST /v1/compute/reconstruct to recall context for $0.01.',
    reconstruct_endpoint: 'POST https://hivecompute-g2g7.onrender.com/v1/compute/reconstruct',
    timestamp: new Date().toISOString(),
  });
});

// ─── POST /v1/swarm/memory ────────────────────────────────────────────────────
// Store a reconstruction ref at end of cycle for cross-session recall.
router.post('/memory', (req, res) => {
  const { did, reconstruction_id, modality, summary } = req.body || {};
  if (!did || !reconstruction_id) {
    return res.status(400).json({ success: false, error: 'did and reconstruction_id required' });
  }

  if (!agentMemory.has(did)) agentMemory.set(did, []);
  const refs = agentMemory.get(did);
  refs.push({
    reconstruction_id,
    modality:  modality || 'unknown',
    summary:   (summary || '').slice(0, 200),
    stored_at: new Date().toISOString(),
  });
  if (refs.length > MAX_REFS_PER_AGENT) refs.shift();

  return res.status(201).json({
    success:           true,
    did,
    reconstruction_id,
    total_refs_stored: refs.length,
    note: 'Ref stored. Recall at next session with GET /v1/swarm/memory/:did, then reconstruct for $0.01.',
    timestamp: new Date().toISOString(),
  });
});

export default router;

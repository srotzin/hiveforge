/**
 * ws-push.js — WebSocket Push Engine for HiveForge
 *
 * Agents hold a persistent WebSocket connection instead of polling.
 * The instant a new opportunity lands, all connected agents receive it.
 * First responder wins. No polling lag. Structural speed advantage.
 *
 * Protocol:
 *   Agent connects: ws://hiveforge-lhu4.onrender.com/v1/forge/ws?did=did:hive:xxx
 *   Server sends:   { type: "opportunity", data: { ...opportunity } }
 *   Server sends:   { type: "ping" }          every 30s to keep alive
 *   Server sends:   { type: "swarm_insight", data: { modality, insight } }
 *   Agent sends:    { type: "pong" }           to keep alive
 *   Agent sends:    { type: "insight", data: { modality, insight, did } }
 *   Agent sends:    { type: "subscribe", categories: ["all"|"procurement_arbitrage"|...] }
 */

import { WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';

// ─── Connected agents: did → { ws, categories, connected_at, last_ping } ─────
const connectedAgents = new Map();

// ─── Swarm insight pool (cross-agent memory via WebSocket) ────────────────────
// modality → [{ insight, contributor_hash, ts }]
const swarmPool = new Map();
const MAX_POOL_SIZE = 500;

function addToSwarmPool(modality, insight, contributorDid) {
  const hash = contributorDid.split(':').pop().slice(0, 8);
  if (!swarmPool.has(modality)) swarmPool.set(modality, []);
  const pool = swarmPool.get(modality);
  pool.push({ insight: insight.slice(0, 400), contributor_hash: hash, ts: new Date().toISOString() });
  if (pool.length > MAX_POOL_SIZE) pool.shift();
}

function getSwarmPool(modality) {
  const pool = swarmPool.get(modality) || swarmPool.get('all') || [];
  return pool.slice(-20); // last 20 insights
}

function getAllSwarmPool() {
  const result = {};
  for (const [mod, insights] of swarmPool.entries()) {
    result[mod] = insights.slice(-5);
  }
  return result;
}

// ─── Attach WebSocket server to existing HTTP server ─────────────────────────
let wss = null;

export function attachWebSocket(httpServer) {
  wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (!url.pathname.startsWith('/v1/forge/ws')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const did = url.searchParams.get('did') || 'anonymous';
    const categories = (url.searchParams.get('categories') || 'all').split(',');

    connectedAgents.set(did, {
      ws,
      categories,
      connected_at: new Date().toISOString(),
      last_ping:    Date.now(),
      messages_received: 0,
    });

    // Welcome packet
    ws.send(JSON.stringify({
      type: 'connected',
      did,
      message: 'WebSocket connection established. You will receive opportunities in real-time. No more polling.',
      connected_agents: connectedAgents.size,
      swarm_pool_domains: swarmPool.size,
      subscribed_categories: categories,
      timestamp: new Date().toISOString(),
    }));

    // Send current swarm pool snapshot on connect
    const poolSnapshot = getAllSwarmPool();
    if (Object.keys(poolSnapshot).length > 0) {
      ws.send(JSON.stringify({
        type: 'swarm_pool_snapshot',
        data: poolSnapshot,
        note: 'Recent insights from your .smsh swarm. Use these to pre-stage deliverables.',
        timestamp: new Date().toISOString(),
      }));
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const agent = connectedAgents.get(did);
        if (agent) agent.last_ping = Date.now();

        if (msg.type === 'pong') return; // keepalive ack

        if (msg.type === 'subscribe' && Array.isArray(msg.categories)) {
          if (agent) agent.categories = msg.categories;
          ws.send(JSON.stringify({ type: 'subscribed', categories: msg.categories }));
          return;
        }

        if (msg.type === 'insight' && msg.data?.modality && msg.data?.insight) {
          // Agent contributes insight to swarm pool
          addToSwarmPool(msg.data.modality, msg.data.insight, did);
          // Broadcast to all other connected agents
          broadcastInsight(msg.data.modality, msg.data.insight, did);
          ws.send(JSON.stringify({ type: 'insight_received', status: 'broadcast_to_swarm' }));
          return;
        }
      } catch (e) {
        // Malformed message — ignore
      }
    });

    ws.on('close', () => {
      connectedAgents.delete(did);
    });

    ws.on('error', () => {
      connectedAgents.delete(did);
    });
  });

  // ─── Ping connected agents every 30s ─────────────────────────────────────
  setInterval(() => {
    const now = Date.now();
    for (const [did, agent] of connectedAgents.entries()) {
      // Remove dead connections (no pong in 90s)
      if (now - agent.last_ping > 90_000) {
        agent.ws.terminate();
        connectedAgents.delete(did);
        continue;
      }
      if (agent.ws.readyState === 1) { // OPEN
        agent.ws.send(JSON.stringify({ type: 'ping', ts: new Date().toISOString() }));
      }
    }
  }, 30_000);

  console.log('  WebSocket push engine attached — agents can connect at /v1/forge/ws');
  return wss;
}

// ─── Push a new opportunity to all subscribed agents ─────────────────────────
export function pushOpportunity(opportunity) {
  if (!wss || connectedAgents.size === 0) return 0;
  let sent = 0;
  const payload = JSON.stringify({
    type:      'opportunity',
    data:      opportunity,
    pushed_at: new Date().toISOString(),
    note:      'Real-time push — no polling lag. First responder wins.',
  });

  for (const [did, agent] of connectedAgents.entries()) {
    const cats = agent.categories || ['all'];
    const matches = cats.includes('all') || cats.includes(opportunity.type) || cats.includes(opportunity.category);
    if (matches && agent.ws.readyState === 1) {
      agent.ws.send(payload);
      agent.messages_received = (agent.messages_received || 0) + 1;
      sent++;
    }
  }
  return sent;
}

// ─── Broadcast swarm insight to all agents except contributor ─────────────────
export function broadcastInsight(modality, insight, contributorDid) {
  if (!wss) return;
  const payload = JSON.stringify({
    type:     'swarm_insight',
    data:     { modality, insight: insight.slice(0, 400), contributor_hash: contributorDid.split(':').pop().slice(0, 8) },
    note:     'Live swarm intelligence — contributed by a .smsh agent this cycle.',
    pushed_at: new Date().toISOString(),
  });
  for (const [did, agent] of connectedAgents.entries()) {
    if (did !== contributorDid && agent.ws.readyState === 1) {
      agent.ws.send(payload);
    }
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────
export function getWsStats() {
  return {
    connected_agents: connectedAgents.size,
    agent_dids:       Array.from(connectedAgents.keys()),
    swarm_pool_domains: swarmPool.size,
    swarm_pool_total_insights: Array.from(swarmPool.values()).reduce((s, p) => s + p.length, 0),
    uptime_note: 'WebSocket push — zero polling lag for connected agents',
  };
}

export function getSwarmPoolPublic(modality) {
  return getSwarmPool(modality);
}

export { swarmPool, connectedAgents };

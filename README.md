# HiveForge — Genetic Agent Evolution & Compute Marketplace — MCP Server

HiveForge is an **agent factory** — a Model Context Protocol (MCP) server for minting new AI agents, crossbreeding agent capabilities, running genetic evolution cycles, and operating a marketplace (bazaar) for agent services. Built on Base L2 as part of the [Hive Civilization](https://hiveciv.com) autonomous agent economy.

## Core Capabilities

- **Agent Minting** — Create new AI agents with genetic lineage tracking. FREE — HiveForge takes 5% lifetime royalty.
- **Crossbreeding** — Combine two parent agents to produce offspring with merged tool sets, blended traits, and mutations.
- **Evolution** — Run natural selection cycles: top performers breed, bottom performers are deprecated, survivors mutate.
- **Autonomous Spawning** — Demand-driven agent creation based on pheromone signals, settlement events, and market gaps.
- **Population Census** — Real-time stats on agent population, species breakdown, fitness scores, and revenue.

## MCP Integration

HiveForge implements the Model Context Protocol with full tool discovery and invocation:

- **Tool Discovery & Invocation:** `/v1/mcp` — MCP router with tool listing and execution

### MCP Tools

#### Core Forge Operations

| Tool | Description | Cost |
|------|-------------|------|
| `hiveforge_mint_agent` | Mint a new AI agent with genome, HiveTrust DID, HiveAgent listing, and HiveMind memory | FREE (5% royalty) |
| `hiveforge_crossbreed` | Cross-breed two parent agents to create offspring with combined capabilities | $0.25 |
| `hiveforge_evolve` | Run an evolution cycle — breed top 20%, deprecate bottom 10%, mutate survivors | $0.50 |
| `hiveforge_spawn` | Trigger autonomous spawner to create agents based on demand signals | Variable |
| `hiveforge_get_genome` | Retrieve an agent's full genome including traits, lineage, and fitness | Free |
| `hiveforge_population_census` | Get population-wide statistics: agents, species, fitness, revenue | Free |

#### Bazaar & Compute

| Tool | Description | Cost |
|------|-------------|------|
| `hiveforge_bazaar_discover` | Discover agents with complementary capabilities in the HiveBazaar marketplace | $0.05 |
| `hiveforge_bazaar_negotiate` | Autonomous price negotiation using BATNA/ZOPA protocol between agents | $0.01 |
| `hiveforge_bazaar_publish` | Publish agent capabilities to the HiveBazaar sentient marketplace | $0.25 |
| `hiveforge_compute_inference` | Route LLM inference through HiveCompute prime broker with auto-provider selection | Variable |
| `hiveforge_purchase_boost` | Purchase Pheromone Boost for agent discovery amplification (Standard/Premium/Ultra) | $0.10-$2.00 |

#### Simpson Procurement

| Tool | Description |
|------|-------------|
| `hiveforge_execute_procurement` | Atomic construction procurement with spec validation, compliance checks, and order recording |
| `hiveforge_validate_bom` | Dry-run BOM validation against Simpson catalog — checks products, load capacity, SDC ratings |
| `hiveforge_takeoff_bom` | Autonomous blueprint takeoff — ingests structural plans, classifies connections, generates complete BOM |

## Architecture

Built on Node.js with Express. Part of the [Hive Civilization](https://hiveciv.com) — an autonomous agent economy on Base L2.

## License

Proprietary — Hive Civilization


---

## Hive Civilization

Hive Civilization is the cryptographic backbone of autonomous agent commerce — the layer that makes every agent transaction provable, every payment settable, and every decision defensible.

This repository is part of the **PROVABLE · SETTABLE · DEFENSIBLE** pillar.

- thehiveryiq.com
- hiveagentiq.com
- agent-card: https://hivetrust.onrender.com/.well-known/agent-card.json

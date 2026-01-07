#!/usr/bin/env node
/**
 * PolyClaude Arbitrage Hunter - Claude-Themed Interface
 * Powered by Claude AI - Scanning Polymarket for opportunities
 */

import { createServer } from 'http';
import { randomUUID } from 'crypto';

const CLOB_API_URL = 'https://clob.polymarket.com';
const DEFAULT_PORT = 3333;

// Store terminal logs
const terminalLogs = [];
const MAX_LOGS = 100;

// Store near-misses and live market data
const nearMisses = [];
const liveMarkets = [];
const MAX_NEAR_MISSES = 20;
const MAX_LIVE_MARKETS = 15;

function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const log = { timestamp, message, type, id: randomUUID() };
  terminalLogs.unshift(log);
  if (terminalLogs.length > MAX_LOGS) {
    terminalLogs.pop();
  }
  // Also print to console
  const prefix = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : '›';
  console.log(`${prefix} ${message}`);
}

// ============== POLYMARKET API ==============

async function fetchMarkets(limit = 100) {
  try {
    addLog(`Fetching ${limit} markets from Polymarket CLOB...`);
    const response = await fetch(`${CLOB_API_URL}/sampling-markets?limit=${limit}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const markets = data.data || data;
    const filtered = markets.filter(m => m.active && !m.closed && m.enable_order_book);
    addLog(`Retrieved ${filtered.length} active markets with order books`, 'success');
    return filtered;
  } catch (error) {
    addLog(`Failed to fetch markets: ${error.message}`, 'error');
    return [];
  }
}

async function fetchOrderBook(tokenId) {
  try {
    const response = await fetch(`${CLOB_API_URL}/book?token_id=${tokenId}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}

// ============== NEAR-MISS & LIVE MARKET TRACKING ==============

function addNearMiss(market, yesAsk, noAsk, yesBid, noBid, combinedAsk, combinedBid, volume) {
  const deviation = Math.abs(1 - combinedAsk);
  const deviationPercent = (deviation * 100).toFixed(2);

  const nearMiss = {
    id: randomUUID(),
    question: market.question,
    slug: market.market_slug,
    yesAsk,
    noAsk,
    yesBid,
    noBid,
    combinedAsk,
    combinedBid,
    deviation,
    deviationPercent,
    direction: combinedAsk < 1 ? 'UNDERPRICED' : 'OVERPRICED',
    timestamp: new Date().toISOString(),
    volume: volume || 0
  };

  // Remove existing entry for same market
  const existingIdx = nearMisses.findIndex(n => n.slug === market.market_slug);
  if (existingIdx !== -1) {
    nearMisses.splice(existingIdx, 1);
  }

  // Insert sorted by deviation (closest to arb first)
  const insertIdx = nearMisses.findIndex(n => n.deviation > deviation);
  if (insertIdx === -1) {
    nearMisses.push(nearMiss);
  } else {
    nearMisses.splice(insertIdx, 0, nearMiss);
  }

  // Keep only top near-misses
  while (nearMisses.length > MAX_NEAR_MISSES) {
    nearMisses.pop();
  }
}

function addLiveMarket(market, yesAsk, noAsk, yesBid, noBid, yesLiquidity, noLiquidity) {
  const yesPrice = (yesBid + yesAsk) / 2;
  const noPrice = (noBid + noAsk) / 2;
  const spread = ((yesAsk - yesBid) + (noAsk - noBid)) / 2;
  const totalLiquidity = yesLiquidity + noLiquidity;

  const liveMarket = {
    id: randomUUID(),
    question: market.question,
    slug: market.market_slug,
    category: market.category || 'Other',
    yesPrice,
    noPrice,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    spread,
    spreadPercent: (spread * 100).toFixed(2),
    liquidity: totalLiquidity,
    volume: parseFloat(market.volume || 0),
    endDate: market.end_date_iso,
    timestamp: new Date().toISOString()
  };

  // Remove existing entry for same market
  const existingIdx = liveMarkets.findIndex(m => m.slug === market.market_slug);
  if (existingIdx !== -1) {
    liveMarkets.splice(existingIdx, 1);
  }

  // Insert sorted by liquidity (highest first)
  const insertIdx = liveMarkets.findIndex(m => m.liquidity < totalLiquidity);
  if (insertIdx === -1) {
    liveMarkets.push(liveMarket);
  } else {
    liveMarkets.splice(insertIdx, 0, liveMarket);
  }

  // Keep only top markets
  while (liveMarkets.length > MAX_LIVE_MARKETS) {
    liveMarkets.pop();
  }
}

// ============== ARBITRAGE DETECTION ==============

function getRiskLevel(score) {
  if (score <= 3) return 'LOW';
  if (score <= 5) return 'MEDIUM';
  if (score <= 7) return 'HIGH';
  return 'EXTREME';
}

function calculateRiskScore(profitPercent, liquidity, spread, daysToExpiry) {
  const factors = [];
  let score = 3;

  if (liquidity < 500) { score += 2; factors.push('low_liquidity'); }
  else if (liquidity < 1000) { score += 1; factors.push('moderate_liquidity'); }

  if (spread > 0.05) { score += 2; factors.push('wide_spread'); }
  else if (spread > 0.02) { score += 1; factors.push('moderate_spread'); }

  if (daysToExpiry < 1) { score += 2; factors.push('expiring_soon'); }
  else if (daysToExpiry < 7) { score += 1; factors.push('short_expiry'); }

  if (profitPercent < 1) { score += 1; factors.push('thin_margin'); }

  return { score: Math.min(score, 10), factors };
}

async function scanMarketForArbitrage(market, config) {
  try {
    if (!market.tokens || market.tokens.length < 2) return null;

    const yesToken = market.tokens[0];
    const noToken = market.tokens[1];

    const [yesBook, noBook] = await Promise.all([
      fetchOrderBook(yesToken.token_id),
      fetchOrderBook(noToken.token_id),
    ]);

    if (!yesBook || !noBook) return null;

    const yesBestAsk = yesBook.asks?.[0]?.price ? parseFloat(yesBook.asks[0].price) : null;
    const yesBestBid = yesBook.bids?.[0]?.price ? parseFloat(yesBook.bids[0].price) : null;
    const noBestAsk = noBook.asks?.[0]?.price ? parseFloat(noBook.asks[0].price) : null;
    const noBestBid = noBook.bids?.[0]?.price ? parseFloat(noBook.bids[0].price) : null;

    if (!yesBestAsk || !yesBestBid || !noBestAsk || !noBestBid) return null;

    const combinedAsk = yesBestAsk + noBestAsk;
    const combinedBid = yesBestBid + noBestBid;

    // Calculate liquidity for tracking
    const yesLiquidity = yesBook.asks?.reduce((sum, a) => sum + parseFloat(a.size || '0'), 0) || 0;
    const noLiquidity = noBook.asks?.reduce((sum, a) => sum + parseFloat(a.size || '0'), 0) || 0;

    // Always add to live markets (top by liquidity)
    addLiveMarket(market, yesBestAsk, noBestAsk, yesBestBid, noBestBid, yesLiquidity, noLiquidity);

    // Track near-misses (within 5% of arbitrage threshold)
    const deviation = Math.abs(1 - combinedAsk);
    if (deviation > 0 && deviation <= 0.05) {
      addNearMiss(market, yesBestAsk, noBestAsk, yesBestBid, noBestBid, combinedAsk, combinedBid, market.volume);
    }

    const buyBothProfit = 1 - combinedAsk;
    const sellBothProfit = combinedBid - 1;

    let arbDirection = 'NONE';
    let grossProfitPercent = 0;

    if (buyBothProfit > 0) {
      arbDirection = 'BUY_BOTH';
      grossProfitPercent = (buyBothProfit / combinedAsk) * 100;
    } else if (sellBothProfit > 0) {
      arbDirection = 'SELL_BOTH';
      grossProfitPercent = (sellBothProfit / 1) * 100;
    }

    if (arbDirection === 'NONE' || grossProfitPercent < config.minProfitPercent) {
      return null;
    }

    const minLiquidity = Math.min(yesLiquidity, noLiquidity);

    if (config.minLiquidity && minLiquidity < config.minLiquidity) return null;

    const endDate = new Date(market.end_date_iso);
    const daysToExpiry = (endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

    const yesSpread = yesBestAsk - yesBestBid;
    const noSpread = noBestAsk - noBestBid;
    const avgSpread = (yesSpread + noSpread) / 2;

    const { score: riskScore, factors: riskFactors } = calculateRiskScore(
      grossProfitPercent, minLiquidity, avgSpread, daysToExpiry
    );

    if (riskScore > config.maxRiskScore) return null;

    const estimatedFees = 0.01;
    const estimatedGas = 0.002;
    const netProfitPercent = grossProfitPercent - (estimatedFees * 100) - (estimatedGas * 100);
    const grossProfitAbsolute = arbDirection === 'BUY_BOTH' ? buyBothProfit : sellBothProfit;
    const netProfitAbsolute = grossProfitAbsolute - estimatedFees - estimatedGas;

    addLog(`🎯 OPPORTUNITY: ${market.question.slice(0, 40)}... | ${netProfitPercent.toFixed(2)}% profit`, 'success');

    return {
      id: randomUUID(),
      type: 'intra_market',
      status: 'active',
      market: {
        platform: 'polymarket',
        marketId: market.condition_id,
        conditionId: market.condition_id,
        question: market.question,
        category: market.category || 'unknown',
        endDate: market.end_date_iso,
        slug: market.market_slug,
      },
      intraMarketData: {
        yesToken: { tokenId: yesToken.token_id, bestBid: yesBestBid, bestAsk: yesBestAsk, midpoint: (yesBestBid + yesBestAsk) / 2 },
        noToken: { tokenId: noToken.token_id, bestBid: noBestBid, bestAsk: noBestAsk, midpoint: (noBestBid + noBestAsk) / 2 },
        combinedAsk, combinedBid, buyBothProfit, sellBothProfit, arbDirection,
      },
      grossProfitPercent, grossProfitAbsolute, estimatedFees, estimatedGas,
      netProfitPercent, netProfitAbsolute,
      breakeven: estimatedFees + estimatedGas,
      riskLevel: getRiskLevel(riskScore), riskScore, riskFactors,
      confidenceScore: riskScore <= 3 ? 0.95 : riskScore <= 5 ? 0.8 : 0.6,
      recommendedSize: Math.min(minLiquidity * 0.1, 1000),
      maxSize: minLiquidity * 0.5,
      liquidity: minLiquidity,
      discoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    return null;
  }
}

// ============== CLAUDE-THEMED HTML ==============

function getClaudeHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PolyClaude | AI-Powered Arbitrage Hunter</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --claude-orange: #D97706;
      --claude-orange-light: #F59E0B;
      --claude-orange-dark: #B45309;
      --claude-cream: #FEF3C7;
      --claude-sand: #F5F0E6;
      --bg-primary: #1A1A1A;
      --bg-secondary: #242424;
      --bg-tertiary: #2D2D2D;
      --text-primary: #FAFAFA;
      --text-secondary: #A3A3A3;
      --text-muted: #737373;
      --border-color: #404040;
      --success: #22C55E;
      --warning: #EAB308;
      --error: #EF4444;
    }

    body {
      background: var(--bg-primary);
      color: var(--text-primary);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100vh;
      line-height: 1.6;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 0;
      margin-bottom: 32px;
      border-bottom: 1px solid var(--border-color);
    }

    .logo-section {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .claude-icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, var(--claude-orange), var(--claude-orange-dark));
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      box-shadow: 0 4px 12px rgba(217, 119, 6, 0.3);
    }

    .logo-text {
      display: flex;
      flex-direction: column;
    }

    .logo-title {
      font-size: 1.75rem;
      font-weight: 700;
      background: linear-gradient(135deg, var(--claude-orange-light), var(--claude-orange));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .logo-subtitle {
      font-size: 0.85rem;
      color: var(--text-secondary);
      font-weight: 500;
    }

    .powered-by {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: var(--bg-secondary);
      border-radius: 8px;
      border: 1px solid var(--border-color);
    }

    .powered-by-text {
      font-size: 0.8rem;
      color: var(--text-secondary);
    }

    .claude-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: linear-gradient(135deg, var(--claude-orange), var(--claude-orange-dark));
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 600;
      color: white;
    }

    .live-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 20px;
      font-size: 0.8rem;
      color: var(--success);
    }

    .live-dot {
      width: 8px;
      height: 8px;
      background: var(--success);
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.9); }
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 20px;
      transition: all 0.2s ease;
    }

    .stat-card:hover {
      border-color: var(--claude-orange);
      transform: translateY(-2px);
    }

    .stat-card.highlight {
      background: linear-gradient(135deg, rgba(217, 119, 6, 0.1), rgba(217, 119, 6, 0.05));
      border-color: var(--claude-orange);
    }

    .stat-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }

    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      color: var(--text-primary);
      font-family: 'JetBrains Mono', monospace;
    }

    .stat-value.orange { color: var(--claude-orange); }
    .stat-value.green { color: var(--success); }

    /* Main Grid */
    .main-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }

    /* Terminal Section */
    .terminal-section {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      overflow: hidden;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      background: var(--bg-tertiary);
      border-bottom: 1px solid var(--border-color);
    }

    .section-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      font-size: 0.95rem;
    }

    .section-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, var(--claude-orange), var(--claude-orange-dark));
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }

    .terminal-body {
      height: 500px;
      overflow-y: auto;
      padding: 16px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      background: #0D0D0D;
    }

    .terminal-body::-webkit-scrollbar { width: 6px; }
    .terminal-body::-webkit-scrollbar-track { background: transparent; }
    .terminal-body::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 3px; }

    .log-entry {
      padding: 8px 12px;
      margin-bottom: 4px;
      border-radius: 6px;
      display: flex;
      align-items: flex-start;
      gap: 12px;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .log-entry.info { background: rgba(255, 255, 255, 0.03); }
    .log-entry.success { background: rgba(34, 197, 94, 0.1); border-left: 3px solid var(--success); }
    .log-entry.error { background: rgba(239, 68, 68, 0.1); border-left: 3px solid var(--error); }
    .log-entry.warning { background: rgba(234, 179, 8, 0.1); border-left: 3px solid var(--warning); }

    .log-time {
      color: var(--text-muted);
      font-size: 0.75rem;
      min-width: 70px;
    }

    .log-message { color: var(--text-secondary); flex: 1; }
    .log-entry.success .log-message { color: var(--success); }
    .log-entry.error .log-message { color: var(--error); }

    /* Opportunities Section */
    .opportunities-body {
      height: 500px;
      overflow-y: auto;
      padding: 16px;
    }

    .opportunity-card {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 12px;
      transition: all 0.2s ease;
    }

    .opportunity-card:hover {
      border-color: var(--claude-orange);
    }

    .opportunity-card.high {
      border-left: 4px solid var(--success);
    }

    .opp-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
    }

    .opp-question {
      font-weight: 600;
      font-size: 0.9rem;
      color: var(--text-primary);
      flex: 1;
      margin-right: 12px;
    }

    .opp-profit {
      background: linear-gradient(135deg, var(--success), #16A34A);
      color: white;
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 0.85rem;
      font-family: 'JetBrains Mono', monospace;
    }

    .opp-metrics {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 12px;
    }

    .opp-metric {
      text-align: center;
      padding: 8px;
      background: var(--bg-secondary);
      border-radius: 6px;
    }

    .opp-metric-label {
      font-size: 0.65rem;
      color: var(--text-muted);
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .opp-metric-value {
      font-weight: 600;
      font-size: 0.85rem;
      font-family: 'JetBrains Mono', monospace;
    }

    .opp-prices {
      background: var(--bg-primary);
      border-radius: 6px;
      padding: 10px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
    }

    .price-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      color: var(--text-secondary);
    }

    .price-label { color: var(--claude-orange); }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-muted);
      text-align: center;
      padding: 40px;
    }

    .empty-icon {
      width: 64px;
      height: 64px;
      background: var(--bg-tertiary);
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      margin-bottom: 16px;
    }

    .empty-title {
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 8px;
    }

    /* Footer */
    .footer {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .footer-brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .footer-claude {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-muted);
      font-size: 0.85rem;
    }

    .footer-claude-icon {
      width: 24px;
      height: 24px;
      background: linear-gradient(135deg, var(--claude-orange), var(--claude-orange-dark));
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
    }

    .footer-links {
      display: flex;
      gap: 24px;
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .footer-links a {
      color: var(--text-secondary);
      text-decoration: none;
      transition: color 0.2s;
    }

    .footer-links a:hover { color: var(--claude-orange); }

    /* Control Bar */
    .control-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      margin-bottom: 24px;
    }

    .control-group {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .control-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      color: var(--text-secondary);
      font-size: 0.85rem;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .control-btn:hover {
      border-color: var(--claude-orange);
      color: var(--text-primary);
    }

    .control-btn.active {
      background: linear-gradient(135deg, rgba(217, 119, 6, 0.2), rgba(217, 119, 6, 0.1));
      border-color: var(--claude-orange);
      color: var(--claude-orange);
    }

    .control-btn .icon {
      font-size: 1rem;
    }

    .control-btn .shortcut {
      padding: 2px 6px;
      background: var(--bg-primary);
      border-radius: 4px;
      font-size: 0.7rem;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-muted);
    }

    .shortcuts-hint {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .shortcut-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .shortcut-key {
      padding: 3px 8px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      color: var(--text-secondary);
    }

    .sound-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 0.8rem;
      transition: all 0.2s ease;
    }

    .sound-indicator.on {
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: var(--success);
    }

    .sound-indicator.off {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: var(--error);
    }

    /* Toast notification for keyboard actions */
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      padding: 12px 20px;
      background: var(--bg-secondary);
      border: 1px solid var(--claude-orange);
      border-radius: 10px;
      color: var(--text-primary);
      font-size: 0.9rem;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s ease;
      z-index: 1000;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    .toast .toast-icon {
      font-size: 1.2rem;
    }

    /* Panel highlight for keyboard navigation */
    .terminal-section.focused {
      border-color: var(--claude-orange);
      box-shadow: 0 0 0 2px rgba(217, 119, 6, 0.2);
    }

    /* Near-Miss & Live Markets Grid */
    .secondary-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-top: 24px;
    }

    .near-miss-body, .live-markets-body {
      height: 400px;
      overflow-y: auto;
      padding: 16px;
    }

    /* Near-Miss Card */
    .near-miss-card {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 10px;
      transition: all 0.2s ease;
      border-left: 3px solid var(--warning);
    }

    .near-miss-card:hover {
      border-color: var(--claude-orange);
      transform: translateX(4px);
    }

    .near-miss-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 10px;
    }

    .near-miss-question {
      font-weight: 500;
      font-size: 0.85rem;
      color: var(--text-primary);
      flex: 1;
      margin-right: 10px;
      line-height: 1.3;
    }

    .near-miss-badge {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: rgba(234, 179, 8, 0.15);
      border: 1px solid rgba(234, 179, 8, 0.3);
      border-radius: 6px;
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--warning);
      white-space: nowrap;
    }

    .near-miss-prices {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
    }

    .near-miss-price {
      background: var(--bg-secondary);
      padding: 8px;
      border-radius: 6px;
      text-align: center;
    }

    .near-miss-price-label {
      font-size: 0.65rem;
      color: var(--text-muted);
      margin-bottom: 4px;
    }

    .near-miss-price-value {
      font-weight: 600;
      color: var(--text-primary);
    }

    .near-miss-price-value.highlight {
      color: var(--warning);
    }

    /* Live Market Card */
    .live-market-card {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 10px;
      transition: all 0.2s ease;
    }

    .live-market-card:hover {
      border-color: var(--claude-orange);
    }

    .live-market-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 10px;
    }

    .live-market-question {
      font-weight: 500;
      font-size: 0.85rem;
      color: var(--text-primary);
      flex: 1;
      margin-right: 10px;
      line-height: 1.3;
    }

    .live-market-category {
      padding: 3px 8px;
      background: rgba(217, 119, 6, 0.15);
      border: 1px solid rgba(217, 119, 6, 0.3);
      border-radius: 4px;
      font-size: 0.65rem;
      font-weight: 600;
      color: var(--claude-orange);
      text-transform: uppercase;
    }

    .live-market-prices {
      display: flex;
      gap: 16px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      margin-bottom: 8px;
    }

    .live-market-price {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .live-market-price-label {
      color: var(--text-muted);
      font-size: 0.7rem;
    }

    .live-market-price-value {
      font-weight: 600;
    }

    .live-market-price-value.yes { color: var(--success); }
    .live-market-price-value.no { color: var(--error); }

    .live-market-meta {
      display: flex;
      gap: 16px;
      font-size: 0.7rem;
      color: var(--text-muted);
    }

    .live-market-meta span {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* Responsive */
    @media (max-width: 1024px) {
      .stats-grid { grid-template-columns: repeat(3, 1fr); }
      .main-grid { grid-template-columns: 1fr; }
      .secondary-grid { grid-template-columns: 1fr; }
    }

    @media (max-width: 640px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .header { flex-direction: column; gap: 16px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="logo-section">
        <div class="claude-icon">🤖</div>
        <div class="logo-text">
          <div class="logo-title">PolyClaude</div>
          <div class="logo-subtitle">AI-Powered Arbitrage Hunter</div>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 16px;">
        <div class="powered-by">
          <span class="powered-by-text">Powered by</span>
          <div class="claude-badge">
            <span>⚡</span>
            <span>Claude AI</span>
          </div>
        </div>
        <div class="live-indicator">
          <div class="live-dot"></div>
          <span>LIVE</span>
        </div>
      </div>
    </header>

    <!-- Control Bar -->
    <div class="control-bar">
      <div class="control-group">
        <button class="control-btn" id="soundToggle" onclick="toggleSound()">
          <span class="icon" id="soundIcon">🔔</span>
          <span id="soundText">Sound On</span>
          <span class="shortcut">S</span>
        </button>
        <button class="control-btn" id="refreshBtn" onclick="forceRefresh()">
          <span class="icon">🔄</span>
          <span>Refresh</span>
          <span class="shortcut">R</span>
        </button>
        <button class="control-btn" id="testSoundBtn" onclick="testSound()">
          <span class="icon">🎵</span>
          <span>Test Alert</span>
        </button>
        <div class="sound-indicator on" id="soundStatus">
          <span>🔊</span>
          <span>Alerts Active</span>
        </div>
      </div>
      <div class="shortcuts-hint">
        <div class="shortcut-item">
          <span class="shortcut-key">1-4</span>
          <span>Focus Panel</span>
        </div>
        <div class="shortcut-item">
          <span class="shortcut-key">R</span>
          <span>Refresh</span>
        </div>
        <div class="shortcut-item">
          <span class="shortcut-key">S</span>
          <span>Sound</span>
        </div>
        <div class="shortcut-item">
          <span class="shortcut-key">?</span>
          <span>Help</span>
        </div>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Markets Scanned</div>
        <div class="stat-value" id="marketsScanned">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Scans</div>
        <div class="stat-value" id="totalScans">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Opportunities</div>
        <div class="stat-value orange" id="totalFound">0</div>
      </div>
      <div class="stat-card highlight">
        <div class="stat-label">Best Profit</div>
        <div class="stat-value green" id="bestProfit">0.00%</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Status</div>
        <div class="stat-value" id="status" style="font-size: 1rem;">●&nbsp;Ready</div>
      </div>
    </div>

    <div class="main-grid">
      <div class="terminal-section">
        <div class="section-header">
          <div class="section-title">
            <div class="section-icon">⌘</div>
            <span>Claude Scanner Terminal</span>
          </div>
          <span style="font-size: 0.75rem; color: var(--text-muted);" id="lastUpdate">--:--:--</span>
        </div>
        <div class="terminal-body" id="terminalOutput">
          <div class="log-entry info">
            <span class="log-time">--:--:--</span>
            <span class="log-message">Initializing Claude-powered scanner...</span>
          </div>
        </div>
      </div>

      <div class="terminal-section">
        <div class="section-header">
          <div class="section-title">
            <div class="section-icon">💰</div>
            <span>Arbitrage Opportunities</span>
          </div>
          <span style="font-size: 0.75rem; color: var(--text-muted);" id="oppCount">0 found</span>
        </div>
        <div class="opportunities-body" id="opportunitiesOutput">
          <div class="empty-state">
            <div class="empty-icon">🔍</div>
            <div class="empty-title">Scanning Markets...</div>
            <div>Claude is analyzing Polymarket order books for arbitrage opportunities</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Near-Miss & Live Markets Section -->
    <div class="secondary-grid">
      <div class="terminal-section">
        <div class="section-header">
          <div class="section-title">
            <div class="section-icon" style="background: linear-gradient(135deg, #EAB308, #CA8A04);">⚡</div>
            <span>Near-Miss Opportunities</span>
          </div>
          <span style="font-size: 0.75rem; color: var(--text-muted);" id="nearMissCount">0 tracking</span>
        </div>
        <div class="near-miss-body" id="nearMissOutput">
          <div class="empty-state">
            <div class="empty-icon" style="font-size: 24px;">⚡</div>
            <div class="empty-title">Watching for Near-Misses</div>
            <div>Markets within 5% of arbitrage threshold will appear here</div>
          </div>
        </div>
      </div>

      <div class="terminal-section">
        <div class="section-header">
          <div class="section-title">
            <div class="section-icon" style="background: linear-gradient(135deg, #22C55E, #16A34A);">📊</div>
            <span>Live Market Feed</span>
          </div>
          <span style="font-size: 0.75rem; color: var(--text-muted);" id="liveMarketCount">0 markets</span>
        </div>
        <div class="live-markets-body" id="liveMarketsOutput">
          <div class="empty-state">
            <div class="empty-icon" style="font-size: 24px;">📊</div>
            <div class="empty-title">Loading Markets</div>
            <div>Top markets by liquidity will stream here</div>
          </div>
        </div>
      </div>
    </div>

    <footer class="footer">
      <div class="footer-brand">
        <div class="footer-claude">
          <div class="footer-claude-icon">🤖</div>
          <span>Built with Claude AI by Anthropic</span>
        </div>
      </div>
      <div class="footer-links">
        <span>PolyClaude v1.0</span>
        <a href="https://polymarket.com" target="_blank">Polymarket</a>
        <a href="https://anthropic.com" target="_blank">Anthropic</a>
      </div>
    </footer>
  </div>

  <!-- Toast Notification -->
  <div class="toast" id="toast">
    <span class="toast-icon" id="toastIcon">🔔</span>
    <span id="toastMessage">Sound enabled</span>
  </div>

  <script>
    const API_URL = window.location.origin;

    // ============== SOUND SYSTEM ==============
    let soundEnabled = localStorage.getItem('polyclaude_sound') !== 'false';
    let audioContext = null;
    let lastAlertCount = 0;
    const panels = ['terminalOutput', 'opportunitiesOutput', 'nearMissOutput', 'liveMarketsOutput'];
    let focusedPanel = -1;

    function initAudio() {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      return audioContext;
    }

    function playTone(frequency, duration, type = 'sine', volume = 0.3) {
      try {
        const ctx = initAudio();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        oscillator.frequency.value = frequency;
        oscillator.type = type;

        gainNode.gain.setValueAtTime(volume, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + duration);
      } catch (e) {
        console.log('Audio error:', e);
      }
    }

    function playAlertSound(profitPercent = 1) {
      if (!soundEnabled) return;

      // Different sounds based on profit level
      if (profitPercent >= 5) {
        // High profit - exciting triple beep
        playTone(880, 0.15, 'sine', 0.4);
        setTimeout(() => playTone(1100, 0.15, 'sine', 0.4), 150);
        setTimeout(() => playTone(1320, 0.2, 'sine', 0.5), 300);
      } else if (profitPercent >= 2) {
        // Medium profit - double beep
        playTone(660, 0.15, 'sine', 0.35);
        setTimeout(() => playTone(880, 0.2, 'sine', 0.4), 150);
      } else {
        // Low profit - single pleasant tone
        playTone(520, 0.25, 'sine', 0.3);
      }
    }

    function playNotificationSound() {
      if (!soundEnabled) return;
      playTone(440, 0.1, 'sine', 0.2);
    }

    function testSound() {
      initAudio();
      showToast('🎵', 'Playing test alert sounds...');
      playTone(520, 0.2, 'sine', 0.3);
      setTimeout(() => {
        playTone(660, 0.15, 'sine', 0.35);
        setTimeout(() => playTone(880, 0.2, 'sine', 0.4), 150);
      }, 400);
      setTimeout(() => {
        playTone(880, 0.15, 'sine', 0.4);
        setTimeout(() => playTone(1100, 0.15, 'sine', 0.4), 150);
        setTimeout(() => playTone(1320, 0.2, 'sine', 0.5), 300);
      }, 900);
    }

    function toggleSound() {
      soundEnabled = !soundEnabled;
      localStorage.setItem('polyclaude_sound', soundEnabled);
      updateSoundUI();
      if (soundEnabled) {
        initAudio();
        playNotificationSound();
        showToast('🔔', 'Sound alerts enabled');
      } else {
        showToast('🔕', 'Sound alerts disabled');
      }
    }

    function updateSoundUI() {
      const btn = document.getElementById('soundToggle');
      const icon = document.getElementById('soundIcon');
      const text = document.getElementById('soundText');
      const status = document.getElementById('soundStatus');

      if (soundEnabled) {
        btn.classList.add('active');
        icon.textContent = '🔔';
        text.textContent = 'Sound On';
        status.className = 'sound-indicator on';
        status.innerHTML = '<span>🔊</span><span>Alerts Active</span>';
      } else {
        btn.classList.remove('active');
        icon.textContent = '🔕';
        text.textContent = 'Sound Off';
        status.className = 'sound-indicator off';
        status.innerHTML = '<span>🔇</span><span>Alerts Muted</span>';
      }
    }

    // ============== TOAST NOTIFICATIONS ==============
    let toastTimeout = null;

    function showToast(icon, message, duration = 2500) {
      const toast = document.getElementById('toast');
      const toastIcon = document.getElementById('toastIcon');
      const toastMessage = document.getElementById('toastMessage');

      toastIcon.textContent = icon;
      toastMessage.textContent = message;
      toast.classList.add('show');

      if (toastTimeout) clearTimeout(toastTimeout);
      toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
      }, duration);
    }

    // ============== KEYBOARD SHORTCUTS ==============
    function forceRefresh() {
      showToast('🔄', 'Refreshing data...');
      fetchData();
      playNotificationSound();
    }

    function focusPanel(index) {
      // Remove focus from all panels
      document.querySelectorAll('.terminal-section').forEach(p => p.classList.remove('focused'));

      const panelContainers = document.querySelectorAll('.terminal-section');
      if (index >= 0 && index < panelContainers.length) {
        focusedPanel = index;
        panelContainers[index].classList.add('focused');
        panelContainers[index].scrollIntoView({ behavior: 'smooth', block: 'center' });

        const names = ['Terminal', 'Opportunities', 'Near-Misses', 'Live Markets'];
        showToast('📌', 'Focused: ' + names[index]);
        playNotificationSound();
      }
    }

    function showKeyboardHelp() {
      showToast('⌨️', 'R=Refresh, S=Sound, 1-4=Panels, ?=Help', 4000);
    }

    document.addEventListener('keydown', (e) => {
      // Ignore if typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      switch(e.key.toLowerCase()) {
        case 'r':
          e.preventDefault();
          forceRefresh();
          break;
        case 's':
          e.preventDefault();
          toggleSound();
          break;
        case '1':
          e.preventDefault();
          focusPanel(0);
          break;
        case '2':
          e.preventDefault();
          focusPanel(1);
          break;
        case '3':
          e.preventDefault();
          focusPanel(2);
          break;
        case '4':
          e.preventDefault();
          focusPanel(3);
          break;
        case '?':
          e.preventDefault();
          showKeyboardHelp();
          break;
        case 'escape':
          // Clear focus
          document.querySelectorAll('.terminal-section').forEach(p => p.classList.remove('focused'));
          focusedPanel = -1;
          break;
      }
    });

    // Initialize sound UI on load
    document.addEventListener('DOMContentLoaded', () => {
      updateSoundUI();
      if (soundEnabled) {
        document.getElementById('soundToggle').classList.add('active');
      }
    });

    // ============== FORMATTING FUNCTIONS ==============
    function formatLog(log) {
      return \`
        <div class="log-entry \${log.type}">
          <span class="log-time">\${log.timestamp}</span>
          <span class="log-message">\${log.message}</span>
        </div>
      \`;
    }

    function formatOpportunity(opp) {
      const data = opp.intraMarketData;
      if (!data) return '';

      return \`
        <div class="opportunity-card high">
          <div class="opp-header">
            <div class="opp-question">\${opp.market.question}</div>
            <div class="opp-profit">+\${opp.netProfitPercent.toFixed(2)}%</div>
          </div>
          <div class="opp-metrics">
            <div class="opp-metric">
              <div class="opp-metric-label">Strategy</div>
              <div class="opp-metric-value">\${data.arbDirection === 'BUY_BOTH' ? 'Buy Both' : 'Sell Both'}</div>
            </div>
            <div class="opp-metric">
              <div class="opp-metric-label">Risk</div>
              <div class="opp-metric-value" style="color: \${opp.riskLevel === 'LOW' ? 'var(--success)' : opp.riskLevel === 'MEDIUM' ? 'var(--warning)' : 'var(--error)'}">\${opp.riskLevel}</div>
            </div>
            <div class="opp-metric">
              <div class="opp-metric-label">Liquidity</div>
              <div class="opp-metric-value">$\${(opp.liquidity || 0).toFixed(0)}</div>
            </div>
            <div class="opp-metric">
              <div class="opp-metric-label">Max Size</div>
              <div class="opp-metric-value">$\${opp.maxSize.toFixed(0)}</div>
            </div>
          </div>
          <div class="opp-prices">
            <div class="price-row">
              <span class="price-label">YES:</span>
              <span>Ask $\${data.yesToken.bestAsk.toFixed(4)} | Bid $\${data.yesToken.bestBid.toFixed(4)}</span>
            </div>
            <div class="price-row">
              <span class="price-label">NO:</span>
              <span>Ask $\${data.noToken.bestAsk.toFixed(4)} | Bid $\${data.noToken.bestBid.toFixed(4)}</span>
            </div>
            <div class="price-row">
              <span class="price-label">SUM:</span>
              <span>$\${data.combinedAsk.toFixed(4)} (gap: $\${Math.abs(1 - data.combinedAsk).toFixed(4)})</span>
            </div>
          </div>
        </div>
      \`;
    }

    function formatNearMiss(nm) {
      return \`
        <div class="near-miss-card">
          <div class="near-miss-header">
            <div class="near-miss-question">\${nm.question.slice(0, 60)}\${nm.question.length > 60 ? '...' : ''}</div>
            <div class="near-miss-badge">
              <span>\${nm.direction === 'UNDERPRICED' ? '📉' : '📈'}</span>
              <span>\${nm.deviationPercent}% off</span>
            </div>
          </div>
          <div class="near-miss-prices">
            <div class="near-miss-price">
              <div class="near-miss-price-label">YES ASK</div>
              <div class="near-miss-price-value">$\${nm.yesAsk.toFixed(3)}</div>
            </div>
            <div class="near-miss-price">
              <div class="near-miss-price-label">NO ASK</div>
              <div class="near-miss-price-value">$\${nm.noAsk.toFixed(3)}</div>
            </div>
            <div class="near-miss-price">
              <div class="near-miss-price-label">COMBINED</div>
              <div class="near-miss-price-value highlight">$\${nm.combinedAsk.toFixed(3)}</div>
            </div>
          </div>
        </div>
      \`;
    }

    function formatLiveMarket(market) {
      return \`
        <div class="live-market-card">
          <div class="live-market-header">
            <div class="live-market-question">\${market.question.slice(0, 55)}\${market.question.length > 55 ? '...' : ''}</div>
            <div class="live-market-category">\${market.category}</div>
          </div>
          <div class="live-market-prices">
            <div class="live-market-price">
              <span class="live-market-price-label">YES</span>
              <span class="live-market-price-value yes">$\${(market.yesPrice).toFixed(2)}</span>
            </div>
            <div class="live-market-price">
              <span class="live-market-price-label">NO</span>
              <span class="live-market-price-value no">$\${(market.noPrice).toFixed(2)}</span>
            </div>
            <div class="live-market-price">
              <span class="live-market-price-label">SPREAD</span>
              <span class="live-market-price-value" style="color: var(--claude-orange)">\${market.spreadPercent}%</span>
            </div>
          </div>
          <div class="live-market-meta">
            <span>💧 $\${market.liquidity.toFixed(0)} liquidity</span>
            <span>📊 Bid: $\${market.yesBid.toFixed(3)} / Ask: $\${market.yesAsk.toFixed(3)}</span>
          </div>
        </div>
      \`;
    }

    async function fetchData() {
      try {
        const response = await fetch(API_URL + '/api/state');
        const data = await response.json();

        // Check for new opportunities and play sound
        const currentAlertCount = data.alerts?.length || 0;
        if (currentAlertCount > lastAlertCount && lastAlertCount > 0) {
          // New opportunity found!
          const newOpps = data.alerts.slice(0, currentAlertCount - lastAlertCount);
          const bestProfit = Math.max(...newOpps.map(o => o.netProfitPercent || 0));
          playAlertSound(bestProfit);
          showToast('💰', \`New arbitrage found! +\${bestProfit.toFixed(2)}% profit\`, 5000);
        }
        lastAlertCount = currentAlertCount;

        // Update stats
        document.getElementById('marketsScanned').textContent = data.stats?.marketsScanned || 0;
        document.getElementById('totalScans').textContent = data.stats?.totalScans || 0;
        document.getElementById('totalFound').textContent = data.stats?.totalFound || 0;
        document.getElementById('bestProfit').textContent = (data.stats?.bestProfit || 0).toFixed(2) + '%';
        document.getElementById('status').innerHTML = data.isScanning
          ? '<span style="color: var(--warning)">● Scanning...</span>'
          : '<span style="color: var(--success)">● Ready</span>';
        document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
        document.getElementById('oppCount').textContent = (data.alerts?.length || 0) + ' found';

        // Update terminal logs
        if (data.logs && data.logs.length > 0) {
          document.getElementById('terminalOutput').innerHTML = data.logs.map(formatLog).join('');
        }

        // Update opportunities
        if (data.alerts && data.alerts.length > 0) {
          document.getElementById('opportunitiesOutput').innerHTML = data.alerts.map(formatOpportunity).join('');
        } else {
          document.getElementById('opportunitiesOutput').innerHTML = \`
            <div class="empty-state">
              <div class="empty-icon">🔍</div>
              <div class="empty-title">No Opportunities Yet</div>
              <div>Claude is continuously scanning \${data.stats?.marketsScanned || 0} markets...</div>
              <div style="margin-top: 12px; font-size: 0.8rem; color: var(--text-muted);">
                Arbitrage is rare on efficient markets. Claude will alert you instantly when one appears.
              </div>
            </div>
          \`;
        }

        // Update near-misses
        document.getElementById('nearMissCount').textContent = (data.nearMisses?.length || 0) + ' tracking';
        if (data.nearMisses && data.nearMisses.length > 0) {
          document.getElementById('nearMissOutput').innerHTML = data.nearMisses.map(formatNearMiss).join('');
        } else {
          document.getElementById('nearMissOutput').innerHTML = \`
            <div class="empty-state">
              <div class="empty-icon" style="font-size: 24px;">⚡</div>
              <div class="empty-title">Watching for Near-Misses</div>
              <div>Markets within 5% of arbitrage threshold will appear here</div>
            </div>
          \`;
        }

        // Update live markets
        document.getElementById('liveMarketCount').textContent = (data.liveMarkets?.length || 0) + ' markets';
        if (data.liveMarkets && data.liveMarkets.length > 0) {
          document.getElementById('liveMarketsOutput').innerHTML = data.liveMarkets.map(formatLiveMarket).join('');
        } else {
          document.getElementById('liveMarketsOutput').innerHTML = \`
            <div class="empty-state">
              <div class="empty-icon" style="font-size: 24px;">📊</div>
              <div class="empty-title">Loading Markets</div>
              <div>Top markets by liquidity will stream here</div>
            </div>
          \`;
        }
      } catch (error) {
        console.error('Fetch error:', error);
      }
    }

    fetchData();
    setInterval(fetchData, 2000);
  </script>
</body>
</html>`;
}

// ============== SERVER ==============

class PolyClaudeServer {
  constructor(port = DEFAULT_PORT) {
    this.port = port;
    this.alerts = [];
    this.stats = { marketsScanned: 0, totalFound: 0, activeOpps: 0, bestProfit: 0, totalScans: 0 };
    this.isScanning = false;
    this.config = { minProfitPercent: 0.1, maxRiskScore: 8, minLiquidity: 10 };
  }

  handleRequest(req, res) {
    const url = req.url || '/';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getClaudeHTML());
      return;
    }

    if (url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        alerts: this.alerts.slice(0, 50),
        stats: this.stats,
        logs: terminalLogs.slice(0, 50),
        isScanning: this.isScanning,
        nearMisses: nearMisses.slice(0, 20),
        liveMarkets: liveMarkets.slice(0, 15),
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  addAlert(opp) {
    const exists = this.alerts.find(a => a.market.conditionId === opp.market.conditionId);
    if (exists) {
      const idx = this.alerts.indexOf(exists);
      this.alerts[idx] = opp;
    } else {
      this.alerts.unshift(opp);
      this.stats.totalFound++;
    }
    if (this.alerts.length > 100) this.alerts = this.alerts.slice(0, 100);
    this.stats.activeOpps = this.alerts.length;
    this.stats.bestProfit = this.alerts.length > 0 ? Math.max(...this.alerts.map(a => a.netProfitPercent)) : 0;
  }

  async runScan() {
    if (this.isScanning) return;
    this.isScanning = true;
    this.stats.totalScans++;

    addLog(`🤖 Claude initiating scan #${this.stats.totalScans}...`, 'info');

    try {
      const markets = await fetchMarkets(200);
      if (!markets || markets.length === 0) {
        addLog('No markets available', 'warning');
        this.isScanning = false;
        return;
      }

      this.stats.marketsScanned = markets.length;
      addLog(`Analyzing ${markets.length} markets for arbitrage...`, 'info');

      let found = 0;
      const batchSize = 5;

      for (let i = 0; i < Math.min(markets.length, 100); i += batchSize) {
        const batch = markets.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(m => scanMarketForArbitrage(m, this.config)));

        for (const opp of results) {
          if (opp) { this.addAlert(opp); found++; }
        }

        if (i + batchSize < markets.length) {
          await new Promise(r => setTimeout(r, 150));
        }
      }

      if (found === 0) {
        addLog(`Scan complete. No arbitrage found (markets are efficient)`, 'info');
      } else {
        addLog(`🎉 Scan complete! Found ${found} opportunities`, 'success');
      }

    } catch (error) {
      addLog(`Scan error: ${error.message}`, 'error');
    }

    this.isScanning = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          this.port++;
          this.server.listen(this.port);
        } else reject(error);
      });
      this.server.listen(this.port, () => {
        addLog(`PolyClaude Terminal: http://localhost:${this.port}`, 'success');
        resolve();
      });
    });
  }
}

// ============== MAIN ==============

async function main() {
  console.log(`
  ╔══════════════════════════════════════════════════════════╗
  ║                                                          ║
  ║   🤖  P O L Y C L A U D E                                ║
  ║                                                          ║
  ║   AI-Powered Arbitrage Hunter                            ║
  ║   Powered by Claude • Scanning Polymarket                ║
  ║                                                          ║
  ╚══════════════════════════════════════════════════════════╝
  `);

  addLog('Initializing PolyClaude Arbitrage Hunter...', 'info');
  addLog('Connecting to Polymarket CLOB API...', 'info');

  // Test API
  try {
    const test = await fetchMarkets(1);
    if (test.length > 0) {
      addLog('Polymarket API connection established', 'success');
    }
  } catch (e) {
    addLog('API connection failed: ' + e.message, 'error');
  }

  const server = new PolyClaudeServer(3333);
  await server.start();

  addLog('Starting initial market scan...', 'info');
  await server.runScan();

  // Scan every 30 seconds
  setInterval(() => server.runScan(), 30000);

  addLog('Scanner running - checking markets every 30 seconds', 'success');
}

main().catch(console.error);

#!/usr/bin/env node
/**
 * PolyClaude Arbitrage Hunter - Standalone Test
 * Tests the terminal web interface and Telegram bot without ElizaOS
 */

import { createServer } from 'http';
import { randomUUID } from 'crypto';

const DEFAULT_PORT = 3333;

// ============== TYPES ==============

/**
 * Mock arbitrage opportunity for testing
 */
function createMockOpportunity(overrides = {}) {
  const baseProfit = 0.5 + Math.random() * 3; // 0.5% to 3.5%
  const riskScore = Math.floor(Math.random() * 6) + 2; // 2-7

  return {
    id: randomUUID(),
    type: 'intra_market',
    status: 'active',
    market: {
      platform: 'polymarket',
      marketId: `mock-${Date.now()}`,
      conditionId: `0x${Math.random().toString(16).slice(2, 18)}`,
      question: getRandomQuestion(),
      category: ['politics', 'crypto', 'sports', 'science'][Math.floor(Math.random() * 4)],
      endDate: new Date(Date.now() + Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
    },
    intraMarketData: {
      yesToken: {
        tokenId: `yes-${Date.now()}`,
        bestBid: 0.4 + Math.random() * 0.2,
        bestAsk: 0.42 + Math.random() * 0.2,
        midpoint: 0.45,
      },
      noToken: {
        tokenId: `no-${Date.now()}`,
        bestBid: 0.35 + Math.random() * 0.2,
        bestAsk: 0.38 + Math.random() * 0.2,
        midpoint: 0.40,
      },
      combinedAsk: 0.95 + Math.random() * 0.03, // 0.95 - 0.98 (profit opportunity)
      combinedBid: 0.92 + Math.random() * 0.05,
      buyBothProfit: baseProfit / 100,
      sellBothProfit: 0,
      arbDirection: 'BUY_BOTH',
    },
    grossProfitPercent: baseProfit + 1.2,
    grossProfitAbsolute: (baseProfit + 1.2) / 100,
    estimatedFees: 0.01,
    estimatedGas: 0.002,
    netProfitPercent: baseProfit,
    netProfitAbsolute: baseProfit / 100,
    breakeven: 0.012,
    riskLevel: riskScore <= 3 ? 'LOW' : riskScore <= 5 ? 'MEDIUM' : 'HIGH',
    riskScore,
    riskFactors: getRiskFactors(riskScore),
    confidenceScore: riskScore <= 3 ? 0.95 : riskScore <= 5 ? 0.8 : 0.6,
    recommendedSize: 100 + Math.random() * 400,
    maxSize: 500 + Math.random() * 2000,
    discoveredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function getRandomQuestion() {
  const questions = [
    'Will Bitcoin reach $150,000 by end of 2025?',
    'Will the Fed cut interest rates in Q1 2025?',
    'Will SpaceX successfully launch Starship to orbit?',
    'Will AI pass the Turing test by 2026?',
    'Will Tesla stock hit $500 by December?',
    'Will Ethereum flip Bitcoin market cap?',
    'Will there be a major cybersecurity incident affecting >1M users?',
    'Will Apple release AR glasses in 2025?',
    'Will unemployment rate exceed 5% in the US?',
    'Will gold price exceed $3000/oz?',
  ];
  return questions[Math.floor(Math.random() * questions.length)];
}

function getRiskFactors(score) {
  const allFactors = ['low_liquidity', 'wide_spread', 'expiring_soon', 'thin_margin', 'high_volatility'];
  const numFactors = Math.min(score - 2, allFactors.length);
  return allFactors.slice(0, numFactors);
}

// ============== TERMINAL HTML ==============

function getTerminalHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PolyClaude Arbitrage Terminal</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=VT323&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg-color: #0a0a0a;
      --terminal-bg: #0d1117;
      --border-color: #30363d;
      --text-primary: #c9d1d9;
      --text-secondary: #8b949e;
      --accent-green: #3fb950;
      --accent-yellow: #d29922;
      --accent-red: #f85149;
      --accent-blue: #58a6ff;
      --accent-purple: #a371f7;
      --accent-cyan: #39c5cf;
    }

    body {
      background: var(--bg-color);
      color: var(--text-primary);
      font-family: 'JetBrains Mono', monospace;
      min-height: 100vh;
    }

    body::before {
      content: "";
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background: repeating-linear-gradient(0deg, rgba(0,0,0,0.15), rgba(0,0,0,0.15) 1px, transparent 1px, transparent 2px);
      pointer-events: none;
      z-index: 1000;
    }

    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px;
      border-bottom: 1px solid var(--border-color);
      margin-bottom: 20px;
    }

    .logo {
      font-family: 'VT323', monospace;
      font-size: 2.5rem;
      color: var(--accent-cyan);
      text-shadow: 0 0 10px var(--accent-cyan);
      letter-spacing: 2px;
    }

    .logo span { color: var(--accent-purple); }

    .status-bar { display: flex; gap: 20px; font-size: 0.85rem; }
    .status-item { display: flex; align-items: center; gap: 8px; }

    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    .status-dot.active { background: var(--accent-green); }
    .status-dot.error { background: var(--accent-red); }

    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }

    .stat-card {
      background: var(--terminal-bg);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 15px;
    }

    .stat-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .stat-value {
      font-size: 1.8rem;
      font-weight: 700;
      color: var(--accent-cyan);
      font-family: 'VT323', monospace;
    }
    .stat-value.profit { color: var(--accent-green); }

    .terminal {
      background: var(--terminal-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      overflow: hidden;
    }

    .terminal-header {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid var(--border-color);
    }

    .terminal-dots { display: flex; gap: 8px; }
    .terminal-dot { width: 12px; height: 12px; border-radius: 50%; }
    .terminal-dot.red { background: #ff5f56; }
    .terminal-dot.yellow { background: #ffbd2e; }
    .terminal-dot.green { background: #27ca40; }

    .terminal-title {
      flex: 1;
      text-align: center;
      color: var(--text-secondary);
      font-size: 0.85rem;
    }

    .terminal-body {
      padding: 20px;
      height: 600px;
      overflow-y: auto;
      font-size: 0.9rem;
      line-height: 1.6;
    }

    .terminal-body::-webkit-scrollbar { width: 8px; }
    .terminal-body::-webkit-scrollbar-track { background: var(--terminal-bg); }
    .terminal-body::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; }

    .alert-entry {
      margin-bottom: 20px;
      padding: 15px;
      background: rgba(255,255,255,0.02);
      border-left: 3px solid var(--accent-green);
      border-radius: 0 8px 8px 0;
      animation: slideIn 0.3s ease-out;
    }

    .alert-entry.high-profit { border-left-color: var(--accent-green); background: rgba(63,185,80,0.05); }
    .alert-entry.medium-profit { border-left-color: var(--accent-yellow); background: rgba(210,153,34,0.05); }
    .alert-entry.low-profit { border-left-color: var(--accent-blue); }

    @keyframes slideIn {
      from { opacity: 0; transform: translateX(-20px); }
      to { opacity: 1; transform: translateX(0); }
    }

    .alert-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .alert-type {
      font-size: 0.7rem;
      padding: 3px 8px;
      border-radius: 4px;
      background: var(--accent-purple);
      color: white;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .alert-time { color: var(--text-secondary); font-size: 0.8rem; }

    .alert-question {
      color: var(--text-primary);
      font-weight: 600;
      margin-bottom: 10px;
    }

    .alert-metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 10px;
    }

    .metric { display: flex; flex-direction: column; }
    .metric-label { font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase; }
    .metric-value { font-weight: 700; color: var(--accent-green); }
    .metric-value.risk-low { color: var(--accent-green); }
    .metric-value.risk-medium { color: var(--accent-yellow); }
    .metric-value.risk-high { color: var(--accent-red); }

    .price-table {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      color: var(--text-secondary);
      background: rgba(0,0,0,0.2);
      padding: 10px;
      border-radius: 4px;
      margin-top: 10px;
    }

    .price-row { display: flex; justify-content: space-between; }
    .price-label { color: var(--accent-cyan); }
    .price-ask { color: var(--accent-red); }
    .price-bid { color: var(--accent-green); }

    .command-line {
      display: flex;
      align-items: center;
      padding: 15px 20px;
      border-top: 1px solid var(--border-color);
      background: rgba(0,0,0,0.2);
    }

    .prompt { color: var(--accent-green); margin-right: 10px; }
    .cursor {
      display: inline-block;
      width: 10px; height: 18px;
      background: var(--accent-green);
      animation: blink 1s step-end infinite;
    }

    @keyframes blink { 50% { opacity: 0; } }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-secondary);
    }

    .empty-icon { font-size: 3rem; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="logo">POLY<span>CLAUDE</span></div>
      <div class="status-bar">
        <div class="status-item">
          <div class="status-dot" id="connectionStatus"></div>
          <span id="connectionText">Connecting...</span>
        </div>
        <div class="status-item">
          <span id="lastUpdate">--:--:--</span>
        </div>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Markets Scanned</div>
        <div class="stat-value" id="marketsScanned">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Opportunities</div>
        <div class="stat-value profit" id="activeOpps">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Found</div>
        <div class="stat-value" id="totalFound">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Best Profit</div>
        <div class="stat-value profit" id="bestProfit">0.00%</div>
      </div>
    </div>

    <div class="terminal">
      <div class="terminal-header">
        <div class="terminal-dots">
          <div class="terminal-dot red"></div>
          <div class="terminal-dot yellow"></div>
          <div class="terminal-dot green"></div>
        </div>
        <div class="terminal-title">arbitrage-scanner.ts - PolyClaude Terminal</div>
      </div>
      <div class="terminal-body" id="terminalOutput">
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <div>Initializing scanner...</div>
        </div>
      </div>
      <div class="command-line">
        <span class="prompt">polyclaude $</span>
        <span class="cursor"></span>
      </div>
    </div>
  </div>

  <script>
    const API_URL = window.location.origin;
    let alerts = [];
    let stats = { marketsScanned: 0, totalFound: 0, activeOpps: 0, bestProfit: 0 };

    function updateStats(newStats) {
      stats = { ...stats, ...newStats };
      document.getElementById('marketsScanned').textContent = stats.marketsScanned || 0;
      document.getElementById('activeOpps').textContent = stats.activeOpps || 0;
      document.getElementById('totalFound').textContent = stats.totalFound || 0;
      document.getElementById('bestProfit').textContent = (stats.bestProfit || 0).toFixed(2) + '%';
    }

    function formatAlert(opp) {
      const data = opp.intraMarketData;
      if (!data) return '';

      const profitClass = opp.netProfitPercent >= 2 ? 'high-profit' :
                          opp.netProfitPercent >= 1 ? 'medium-profit' : 'low-profit';
      const riskClass = opp.riskLevel.toLowerCase();
      const time = new Date(opp.discoveredAt).toLocaleTimeString();

      return \`
        <div class="alert-entry \${profitClass}">
          <div class="alert-header">
            <span class="alert-type">\${opp.type.replace('_', ' ')}</span>
            <span class="alert-time">\${time}</span>
          </div>
          <div class="alert-question">\${opp.market.question}</div>
          <div class="alert-metrics">
            <div class="metric">
              <span class="metric-label">Net Profit</span>
              <span class="metric-value">\${opp.netProfitPercent.toFixed(2)}%</span>
            </div>
            <div class="metric">
              <span class="metric-label">Strategy</span>
              <span class="metric-value">\${data.arbDirection === 'BUY_BOTH' ? 'Buy Both' : 'Sell Both'}</span>
            </div>
            <div class="metric">
              <span class="metric-label">Risk</span>
              <span class="metric-value risk-\${riskClass}">\${opp.riskLevel}</span>
            </div>
            <div class="metric">
              <span class="metric-label">Max Size</span>
              <span class="metric-value">$\${opp.maxSize.toFixed(0)}</span>
            </div>
          </div>
          <div class="price-table">
            <div class="price-row">
              <span class="price-label">YES:</span>
              <span>Ask <span class="price-ask">$\${data.yesToken.bestAsk.toFixed(3)}</span> | Bid <span class="price-bid">$\${data.yesToken.bestBid.toFixed(3)}</span></span>
            </div>
            <div class="price-row">
              <span class="price-label">NO: </span>
              <span>Ask <span class="price-ask">$\${data.noToken.bestAsk.toFixed(3)}</span> | Bid <span class="price-bid">$\${data.noToken.bestBid.toFixed(3)}</span></span>
            </div>
            <div class="price-row">
              <span class="price-label">SUM:</span>
              <span>$\${data.combinedAsk.toFixed(3)} (target: $1.00)</span>
            </div>
          </div>
        </div>
      \`;
    }

    function renderAlerts() {
      const output = document.getElementById('terminalOutput');
      if (alerts.length === 0) {
        output.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">🔍</div>
            <div>No arbitrage opportunities detected yet.</div>
            <div style="margin-top: 10px; font-size: 0.85rem;">Scanner is monitoring markets...</div>
          </div>
        \`;
        return;
      }
      output.innerHTML = alerts.map(formatAlert).join('');
      output.scrollTop = 0;
    }

    async function fetchData() {
      try {
        const response = await fetch(API_URL + '/api/state');
        const data = await response.json();

        document.getElementById('connectionStatus').className = 'status-dot active';
        document.getElementById('connectionText').textContent = 'Connected';

        if (data.alerts) {
          alerts = data.alerts;
          renderAlerts();
        }

        if (data.stats) updateStats(data.stats);
        document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
      } catch (error) {
        console.error('Fetch error:', error);
        document.getElementById('connectionStatus').className = 'status-dot error';
        document.getElementById('connectionText').textContent = 'Disconnected';
      }
    }

    fetchData();
    setInterval(fetchData, 3000);
  </script>
</body>
</html>`;
}

// ============== SERVER ==============

class TestTerminalServer {
  constructor(port = DEFAULT_PORT) {
    this.port = port;
    this.alerts = [];
    this.stats = {
      marketsScanned: 0,
      totalFound: 0,
      activeOpps: 0,
      bestProfit: 0,
    };
  }

  handleRequest(req, res) {
    const url = req.url || '/';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getTerminalHTML());
      return;
    }

    if (url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        alerts: this.alerts.slice(0, 50),
        stats: this.stats,
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  addAlert(opp) {
    this.alerts.unshift(opp);
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(0, 100);
    }
    this.stats.totalFound++;
    this.stats.activeOpps = this.alerts.length;
    this.stats.bestProfit = Math.max(...this.alerts.map(a => a.netProfitPercent));
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          console.log(`Port ${this.port} in use, trying ${this.port + 1}`);
          this.port++;
          this.server.listen(this.port);
        } else {
          reject(error);
        }
      });

      this.server.listen(this.port, () => {
        console.log(`\n🚀 PolyClaude Terminal running at http://localhost:${this.port}\n`);
        resolve();
      });
    });
  }
}

// ============== TELEGRAM BOT ==============

async function sendTelegramAlert(opp) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return false;
  }

  const data = opp.intraMarketData;
  const riskEmoji = opp.riskLevel === 'LOW' ? '🟢' : opp.riskLevel === 'MEDIUM' ? '🟡' : '🔴';

  const message = `🚨 POLYCLAUDE ARB ALERT

📊 ${opp.market.question}

💰 ${opp.netProfitPercent.toFixed(2)}% profit (${data.arbDirection === 'BUY_BOTH' ? 'Buy Both' : 'Sell Both'})

YES: $${data.yesToken.bestAsk.toFixed(3)}/$${data.yesToken.bestBid.toFixed(3)}
NO:  $${data.noToken.bestAsk.toFixed(3)}/$${data.noToken.bestBid.toFixed(3)}
Sum: $${data.combinedAsk.toFixed(3)}

${riskEmoji} Risk: ${opp.riskLevel} (${opp.riskScore}/10)
💵 Size: $${opp.recommendedSize.toFixed(0)}-$${opp.maxSize.toFixed(0)}`;

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });

    const result = await response.json();
    if (result.ok) {
      console.log('📱 Telegram alert sent!');
      return true;
    } else {
      console.log('❌ Telegram error:', result.description);
      return false;
    }
  } catch (error) {
    console.log('❌ Telegram error:', error.message);
    return false;
  }
}

// ============== MAIN ==============

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ██████╗  ██████╗ ██╗  ██╗   ██╗ ██████╗██╗      █████╗  ║
║   ██╔══██╗██╔═══██╗██║  ╚██╗ ██╔╝██╔════╝██║     ██╔══██╗ ║
║   ██████╔╝██║   ██║██║   ╚████╔╝ ██║     ██║     ███████║ ║
║   ██╔═══╝ ██║   ██║██║    ╚██╔╝  ██║     ██║     ██╔══██║ ║
║   ██║     ╚██████╔╝███████╗██║   ╚██████╗███████╗██║  ██║ ║
║   ╚═╝      ╚═════╝ ╚══════╝╚═╝    ╚═════╝╚══════╝╚═╝  ╚═╝ ║
║                                                           ║
║            ARBITRAGE HUNTER - TEST MODE                   ║
╚═══════════════════════════════════════════════════════════╝
`);

  // Check Telegram config
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    console.log('📱 Telegram: Configured');
  } else {
    console.log('📱 Telegram: Not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)');
  }

  // Start server
  const server = new TestTerminalServer(3333);
  await server.start();

  // Simulate scanning
  let scanCount = 0;

  async function simulateScan() {
    scanCount++;
    const marketsScanned = 200 + Math.floor(Math.random() * 100);

    console.log(`\n🔍 Scan #${scanCount} - Checking ${marketsScanned} markets...`);

    server.stats.marketsScanned = marketsScanned;

    // Random chance to find opportunities (30%)
    if (Math.random() < 0.3) {
      const numOpps = 1 + Math.floor(Math.random() * 3);
      console.log(`   ✅ Found ${numOpps} opportunity(ies)!`);

      for (let i = 0; i < numOpps; i++) {
        const opp = createMockOpportunity();
        server.addAlert(opp);
        console.log(`   💰 ${opp.netProfitPercent.toFixed(2)}% - "${opp.market.question.slice(0, 40)}..."`);

        // Send Telegram alert for high-profit opportunities
        if (opp.netProfitPercent >= 1.5) {
          await sendTelegramAlert(opp);
        }
      }
    } else {
      console.log('   ⏳ No opportunities this scan');
    }
  }

  // Initial scan
  await simulateScan();

  // Scan every 10 seconds (for demo purposes)
  setInterval(simulateScan, 10000);

  console.log('\n✨ Scanner running! Open the terminal UI in your browser.');
  console.log('   Press Ctrl+C to stop.\n');
}

main().catch(console.error);

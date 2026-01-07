/**
 * PolyClaude Terminal Web Interface Server
 * Serves a retro terminal-style UI for viewing arbitrage alerts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { logger } from '@elizaos/core';
import type {
  ArbitrageOpportunity,
  ArbitrageAlert,
  ScannerStats,
  TerminalState,
} from '../types/arbitrage';

const DEFAULT_PORT = 3333;

/**
 * Terminal HTML template with retro styling
 */
function getTerminalHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PolyClaude Arbitrage Terminal</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=VT323&display=swap');

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

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
      overflow-x: hidden;
    }

    /* Scanline effect */
    body::before {
      content: "";
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: repeating-linear-gradient(
        0deg,
        rgba(0, 0, 0, 0.15),
        rgba(0, 0, 0, 0.15) 1px,
        transparent 1px,
        transparent 2px
      );
      pointer-events: none;
      z-index: 1000;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px;
    }

    /* Header */
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

    .logo span {
      color: var(--accent-purple);
    }

    .status-bar {
      display: flex;
      gap: 20px;
      font-size: 0.85rem;
    }

    .status-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    .status-dot.active { background: var(--accent-green); }
    .status-dot.warning { background: var(--accent-yellow); }
    .status-dot.error { background: var(--accent-red); }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* Stats Grid */
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
    .stat-value.warning { color: var(--accent-yellow); }

    /* Terminal Window */
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
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--border-color);
    }

    .terminal-dots {
      display: flex;
      gap: 8px;
    }

    .terminal-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }

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

    .terminal-body::-webkit-scrollbar {
      width: 8px;
    }

    .terminal-body::-webkit-scrollbar-track {
      background: var(--terminal-bg);
    }

    .terminal-body::-webkit-scrollbar-thumb {
      background: var(--border-color);
      border-radius: 4px;
    }

    /* Alert Entry */
    .alert-entry {
      margin-bottom: 20px;
      padding: 15px;
      background: rgba(255, 255, 255, 0.02);
      border-left: 3px solid var(--accent-green);
      border-radius: 0 8px 8px 0;
      animation: slideIn 0.3s ease-out;
    }

    .alert-entry.high-profit {
      border-left-color: var(--accent-green);
      background: rgba(63, 185, 80, 0.05);
    }

    .alert-entry.medium-profit {
      border-left-color: var(--accent-yellow);
      background: rgba(210, 153, 34, 0.05);
    }

    .alert-entry.low-profit {
      border-left-color: var(--accent-blue);
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(-20px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
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

    .alert-time {
      color: var(--text-secondary);
      font-size: 0.8rem;
    }

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

    .metric {
      display: flex;
      flex-direction: column;
    }

    .metric-label {
      font-size: 0.7rem;
      color: var(--text-secondary);
      text-transform: uppercase;
    }

    .metric-value {
      font-weight: 700;
      color: var(--accent-green);
    }

    .metric-value.risk-low { color: var(--accent-green); }
    .metric-value.risk-medium { color: var(--accent-yellow); }
    .metric-value.risk-high { color: var(--accent-red); }

    .price-table {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      color: var(--text-secondary);
      background: rgba(0, 0, 0, 0.2);
      padding: 10px;
      border-radius: 4px;
      margin-top: 10px;
    }

    .price-row {
      display: flex;
      justify-content: space-between;
    }

    .price-label { color: var(--accent-cyan); }
    .price-ask { color: var(--accent-red); }
    .price-bid { color: var(--accent-green); }

    /* Command Input */
    .command-line {
      display: flex;
      align-items: center;
      padding: 15px 20px;
      border-top: 1px solid var(--border-color);
      background: rgba(0, 0, 0, 0.2);
    }

    .prompt {
      color: var(--accent-green);
      margin-right: 10px;
    }

    .cursor {
      display: inline-block;
      width: 10px;
      height: 18px;
      background: var(--accent-green);
      animation: blink 1s step-end infinite;
    }

    @keyframes blink {
      50% { opacity: 0; }
    }

    /* Empty State */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-secondary);
    }

    .empty-icon {
      font-size: 3rem;
      margin-bottom: 20px;
    }

    /* Loading Animation */
    .scanning {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--accent-cyan);
      margin-bottom: 15px;
    }

    .scanning-dots::after {
      content: '';
      animation: dots 1.5s steps(4, end) infinite;
    }

    @keyframes dots {
      0%, 20% { content: ''; }
      40% { content: '.'; }
      60% { content: '..'; }
      80%, 100% { content: '...'; }
    }

    /* Risk Badge */
    .risk-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
    }

    .risk-badge.low {
      background: rgba(63, 185, 80, 0.2);
      color: var(--accent-green);
    }

    .risk-badge.medium {
      background: rgba(210, 153, 34, 0.2);
      color: var(--accent-yellow);
    }

    .risk-badge.high {
      background: rgba(248, 81, 73, 0.2);
      color: var(--accent-red);
    }
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
        <div class="scanning">
          <span>Initializing scanner</span>
          <span class="scanning-dots"></span>
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

    // Update stats display
    function updateStats(newStats) {
      stats = { ...stats, ...newStats };
      document.getElementById('marketsScanned').textContent = stats.marketsScanned || 0;
      document.getElementById('activeOpps').textContent = stats.activeOpps || 0;
      document.getElementById('totalFound').textContent = stats.totalFound || 0;
      document.getElementById('bestProfit').textContent = (stats.bestProfit || 0).toFixed(2) + '%';
    }

    // Format alert entry
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

    // Render all alerts
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
      output.scrollTop = 0; // Scroll to top for newest alerts
    }

    // Fetch latest data from server
    async function fetchData() {
      try {
        const response = await fetch(API_URL + '/api/state');
        const data = await response.json();

        // Update connection status
        document.getElementById('connectionStatus').className = 'status-dot active';
        document.getElementById('connectionText').textContent = 'Connected';

        // Update alerts
        if (data.alerts) {
          alerts = data.alerts;
          renderAlerts();
        }

        // Update stats
        if (data.stats) {
          updateStats(data.stats);
        }

        // Update last update time
        document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();

      } catch (error) {
        console.error('Fetch error:', error);
        document.getElementById('connectionStatus').className = 'status-dot error';
        document.getElementById('connectionText').textContent = 'Disconnected';
      }
    }

    // Initial fetch and set up polling
    fetchData();
    setInterval(fetchData, 5000); // Poll every 5 seconds
  </script>
</body>
</html>`;
}

/**
 * Terminal Server class
 */
export class TerminalServer {
  private server: ReturnType<typeof createServer> | null = null;
  private port: number;
  private state: TerminalState;

  constructor(port: number = DEFAULT_PORT) {
    this.port = port;
    this.state = {
      alerts: [],
      stats: {
        totalScans: 0,
        totalOpportunitiesFound: 0,
        activeOpportunities: 0,
        totalProfitCaptured: 0,
        lastScanAt: '',
        uptime: Date.now(),
        marketsScanned: 0,
      },
      isScanning: false,
      lastUpdate: new Date().toISOString(),
      config: {
        minProfitPercent: 0.5,
        maxRiskScore: 7,
        scanIntervalMs: 30000,
      },
    };
  }

  /**
   * Handle HTTP requests
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '/';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Routes
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getTerminalHTML());
      return;
    }

    if (url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          alerts: this.state.alerts.slice(0, 50), // Last 50 alerts
          stats: {
            marketsScanned: this.state.stats.marketsScanned,
            activeOpps: this.state.stats.activeOpportunities,
            totalFound: this.state.stats.totalOpportunitiesFound,
            bestProfit:
              this.state.alerts.length > 0
                ? Math.max(...this.state.alerts.map((a) => a.opportunity.netProfitPercent))
                : 0,
          },
          isScanning: this.state.isScanning,
          lastUpdate: this.state.lastUpdate,
        })
      );
      return;
    }

    if (url === '/api/alerts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.state.alerts));
      return;
    }

    if (url === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.state.stats));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  /**
   * Start the server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          logger.warn(`[TerminalServer] Port ${this.port} in use, trying ${this.port + 1}`);
          this.port++;
          this.server?.listen(this.port);
        } else {
          reject(error);
        }
      });

      this.server.listen(this.port, () => {
        logger.info(`[TerminalServer] Running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('[TerminalServer] Stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Add a new alert
   */
  addAlert(opportunity: ArbitrageOpportunity): void {
    const alert: ArbitrageAlert = {
      id: opportunity.id,
      opportunity,
      timestamp: new Date().toISOString(),
      formattedMessage: '',
      terminalOutput: '',
      telegramMessage: '',
      priority:
        opportunity.netProfitPercent >= 3
          ? 'CRITICAL'
          : opportunity.netProfitPercent >= 2
            ? 'HIGH'
            : opportunity.netProfitPercent >= 1
              ? 'MEDIUM'
              : 'LOW',
    };

    // Add to front (newest first)
    this.state.alerts.unshift(alert);

    // Keep only last 100 alerts
    if (this.state.alerts.length > 100) {
      this.state.alerts = this.state.alerts.slice(0, 100);
    }

    this.state.stats.totalOpportunitiesFound++;
    this.state.stats.activeOpportunities = this.state.alerts.filter(
      (a) => a.opportunity.status === 'active'
    ).length;
    this.state.lastUpdate = new Date().toISOString();
  }

  /**
   * Add multiple alerts
   */
  addAlerts(opportunities: ArbitrageOpportunity[]): void {
    for (const opp of opportunities) {
      this.addAlert(opp);
    }
  }

  /**
   * Update scanner stats
   */
  updateStats(updates: Partial<ScannerStats>): void {
    this.state.stats = { ...this.state.stats, ...updates };
    this.state.lastUpdate = new Date().toISOString();
  }

  /**
   * Set scanning state
   */
  setScanning(isScanning: boolean): void {
    this.state.isScanning = isScanning;
  }

  /**
   * Get current port
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get current state
   */
  getState(): TerminalState {
    return this.state;
  }
}

/**
 * Create and start terminal server
 */
export function createTerminalServer(port?: number): TerminalServer {
  return new TerminalServer(port || DEFAULT_PORT);
}

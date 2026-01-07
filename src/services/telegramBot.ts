/**
 * PolyClaude Telegram Bot Service
 * Sends arbitrage alerts to Telegram channels/groups
 */

import { logger } from '@elizaos/core';
import type { ArbitrageOpportunity, ArbitrageAlert } from '../types/arbitrage';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

/**
 * Format opportunity for Telegram (uses Telegram MarkdownV2)
 */
function formatTelegramMessage(opp: ArbitrageOpportunity): string {
  const data = opp.intraMarketData;
  if (!data) return '';

  const riskEmoji = opp.riskLevel === 'LOW' ? '🟢' : opp.riskLevel === 'MEDIUM' ? '🟡' : '🔴';
  const directionEmoji = data.arbDirection === 'BUY_BOTH' ? '📥' : '📤';

  // Escape special characters for Telegram MarkdownV2
  const escapeMarkdown = (text: string): string => {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  };

  const question =
    opp.market.question.length > 50
      ? opp.market.question.slice(0, 50) + '...'
      : opp.market.question;

  const message = `
🚨 *POLYCLAUDE ARBITRAGE ALERT*

📊 *Market:*
${escapeMarkdown(question)}

${directionEmoji} *Strategy:* ${data.arbDirection === 'BUY_BOTH' ? 'BUY YES \\+ NO' : 'SELL YES \\+ NO'}

💰 *Profit:*
• Gross: ${opp.grossProfitPercent.toFixed(2)}%
• Net: ${opp.netProfitPercent.toFixed(2)}%
• Per $100: \\$${(opp.netProfitAbsolute * 100).toFixed(2)}

📈 *Prices:*
\`\`\`
YES: Ask $${data.yesToken.bestAsk.toFixed(3)} | Bid $${data.yesToken.bestBid.toFixed(3)}
NO:  Ask $${data.noToken.bestAsk.toFixed(3)} | Bid $${data.noToken.bestBid.toFixed(3)}
Sum: $${data.combinedAsk.toFixed(3)} (target: $1.00)
\`\`\`

${riskEmoji} *Risk:* ${opp.riskLevel} \\(${opp.riskScore}/10\\)
${opp.riskFactors.length > 0 ? `⚠️ ${escapeMarkdown(opp.riskFactors.join(', '))}` : ''}

💵 *Recommended:* \\$${opp.recommendedSize.toFixed(0)} \\(max \\$${opp.maxSize.toFixed(0)}\\)

🔗 [View on Polymarket](https://polymarket.com/event/${opp.market.conditionId})

⏰ ${new Date(opp.discoveredAt).toLocaleTimeString()}
`.trim();

  return message;
}

/**
 * Format a plain text version for Telegram (no markdown)
 */
function formatPlainMessage(opp: ArbitrageOpportunity): string {
  const data = opp.intraMarketData;
  if (!data) return '';

  const riskEmoji = opp.riskLevel === 'LOW' ? '🟢' : opp.riskLevel === 'MEDIUM' ? '🟡' : '🔴';

  const question =
    opp.market.question.length > 50
      ? opp.market.question.slice(0, 50) + '...'
      : opp.market.question;

  return `🚨 POLYCLAUDE ARB ALERT

📊 ${question}

💰 ${opp.netProfitPercent.toFixed(2)}% profit (${data.arbDirection === 'BUY_BOTH' ? 'Buy Both' : 'Sell Both'})

YES: $${data.yesToken.bestAsk.toFixed(3)}/$${data.yesToken.bestBid.toFixed(3)}
NO:  $${data.noToken.bestAsk.toFixed(3)}/$${data.noToken.bestBid.toFixed(3)}
Sum: $${data.combinedAsk.toFixed(3)}

${riskEmoji} Risk: ${opp.riskLevel} (${opp.riskScore}/10)
💵 Size: $${opp.recommendedSize.toFixed(0)}-$${opp.maxSize.toFixed(0)}

🔗 polymarket.com/event/${opp.market.conditionId}`;
}

/**
 * Telegram Bot Service class
 */
export class TelegramBotService {
  private config: TelegramConfig;
  private lastAlertTime: Map<string, number> = new Map();
  private cooldownMs: number = 60000; // 1 minute cooldown per market

  constructor(config: TelegramConfig) {
    this.config = config;
    logger.info('[TelegramBot] Service initialized');
  }

  /**
   * Check if we should send alert (cooldown check)
   */
  private shouldSendAlert(marketId: string): boolean {
    const lastTime = this.lastAlertTime.get(marketId);
    if (!lastTime) return true;
    return Date.now() - lastTime > this.cooldownMs;
  }

  /**
   * Send a message to Telegram
   */
  async sendMessage(text: string, parseMode: 'MarkdownV2' | 'HTML' | '' = ''): Promise<boolean> {
    if (!this.config.enabled || !this.config.botToken || !this.config.chatId) {
      logger.warn('[TelegramBot] Bot not configured, skipping message');
      return false;
    }

    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;

      const body: Record<string, any> = {
        chat_id: this.config.chatId,
        text,
        disable_web_page_preview: true,
      };

      if (parseMode) {
        body.parse_mode = parseMode;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const result = await response.json();

      if (!result.ok) {
        logger.error('[TelegramBot] Send failed:', result.description);
        return false;
      }

      logger.info('[TelegramBot] Message sent successfully');
      return true;
    } catch (error) {
      logger.error('[TelegramBot] Error sending message:', error);
      return false;
    }
  }

  /**
   * Send an arbitrage alert
   */
  async sendArbitrageAlert(opportunity: ArbitrageOpportunity): Promise<boolean> {
    if (!this.shouldSendAlert(opportunity.market.marketId)) {
      logger.info(`[TelegramBot] Skipping alert for ${opportunity.market.marketId} (cooldown)`);
      return false;
    }

    // Try markdown first, fall back to plain text
    const markdownMessage = formatTelegramMessage(opportunity);
    let success = await this.sendMessage(markdownMessage, 'MarkdownV2');

    if (!success) {
      // Fallback to plain text
      const plainMessage = formatPlainMessage(opportunity);
      success = await this.sendMessage(plainMessage, '');
    }

    if (success) {
      this.lastAlertTime.set(opportunity.market.marketId, Date.now());
    }

    return success;
  }

  /**
   * Send multiple alerts (batch)
   */
  async sendBatchAlerts(opportunities: ArbitrageOpportunity[]): Promise<number> {
    let sent = 0;
    for (const opp of opportunities) {
      const success = await this.sendArbitrageAlert(opp);
      if (success) sent++;
      // Small delay between messages to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return sent;
  }

  /**
   * Send scanner status update
   */
  async sendStatusUpdate(stats: {
    marketsScanned: number;
    opportunitiesFound: number;
    isScanning: boolean;
  }): Promise<boolean> {
    const statusEmoji = stats.isScanning ? '🔄' : '✅';
    const message = `${statusEmoji} *PolyClaude Scanner Status*

📊 Markets Scanned: ${stats.marketsScanned}
🎯 Opportunities: ${stats.opportunitiesFound}
⏰ ${new Date().toLocaleTimeString()}`;

    return this.sendMessage(message, 'MarkdownV2');
  }

  /**
   * Send test message to verify bot is working
   */
  async sendTestMessage(): Promise<boolean> {
    const message = `🤖 *PolyClaude Arbitrage Hunter*

✅ Bot connection successful\\!
📡 Ready to send arbitrage alerts\\.

_This is a test message\\._`;

    return this.sendMessage(message, 'MarkdownV2');
  }

  /**
   * Update cooldown period
   */
  setCooldown(ms: number): void {
    this.cooldownMs = ms;
  }

  /**
   * Clear cooldown for a specific market
   */
  clearCooldown(marketId: string): void {
    this.lastAlertTime.delete(marketId);
  }

  /**
   * Clear all cooldowns
   */
  clearAllCooldowns(): void {
    this.lastAlertTime.clear();
  }
}

/**
 * Create Telegram bot service from environment variables
 */
export function createTelegramBot(): TelegramBotService | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    logger.warn('[TelegramBot] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return null;
  }

  return new TelegramBotService({
    botToken,
    chatId,
    enabled: true,
  });
}

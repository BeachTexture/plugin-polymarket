#!/usr/bin/env node
/**
 * Playwright test to verify PolyClaude deployment
 */

import { chromium } from 'playwright';

const URLS_TO_TEST = [
  'https://plugin-polymarket-klins-projects-c5215d70.vercel.app',
  'https://plugin-polymarket.vercel.app',
];

async function testDeployment() {
  console.log('🎭 Starting Playwright deployment test...\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let workingUrl = null;

  // Try to find a working URL
  for (const url of URLS_TO_TEST) {
    console.log(`🔍 Testing: ${url}`);
    try {
      const response = await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
      const content = await page.content();

      // Check if it's the auth page or our actual app
      if (content.includes('PolyClaude') && content.includes('Arbitrage')) {
        console.log(`✅ Found PolyClaude app at: ${url}\n`);
        workingUrl = url;
        break;
      } else if (content.includes('Authentication Required') || content.includes('Vercel Authentication')) {
        console.log(`🔒 Auth required at: ${url}`);
      } else {
        console.log(`❓ Unknown page at: ${url}`);
      }
    } catch (error) {
      console.log(`❌ Failed: ${url} - ${error.message}`);
    }
  }

  if (!workingUrl) {
    console.log('\n⚠️  No public deployment found. Testing local version instead...');
    workingUrl = 'http://localhost:3333';

    try {
      await page.goto(workingUrl, { timeout: 5000 });
    } catch (e) {
      console.log('❌ Local server not running. Starting it...');
      console.log('Run: node test-polyclaude-real.mjs');
      await browser.close();
      process.exit(1);
    }
  }

  console.log(`\n📋 Running tests on: ${workingUrl}\n`);

  // Test 1: Page loads with correct title
  console.log('Test 1: Page title');
  const title = await page.title();
  if (title.includes('PolyClaude')) {
    console.log(`  ✅ Title: "${title}"`);
  } else {
    console.log(`  ❌ Unexpected title: "${title}"`);
  }

  // Test 2: Logo and branding
  console.log('\nTest 2: Branding elements');
  const logoTitle = await page.locator('.logo-title').textContent().catch(() => null);
  if (logoTitle?.includes('PolyClaude')) {
    console.log(`  ✅ Logo found: "${logoTitle}"`);
  } else {
    console.log(`  ❌ Logo not found`);
  }

  const claudeBadge = await page.locator('.claude-badge').textContent().catch(() => null);
  if (claudeBadge?.includes('Claude')) {
    console.log(`  ✅ Claude badge found`);
  } else {
    console.log(`  ❌ Claude badge not found`);
  }

  // Test 3: Control bar (sound/refresh buttons)
  console.log('\nTest 3: Control bar');
  const soundBtn = await page.locator('#soundToggle').isVisible().catch(() => false);
  console.log(`  ${soundBtn ? '✅' : '❌'} Sound toggle button`);

  const refreshBtn = await page.locator('button:has-text("Refresh")').isVisible().catch(() => false);
  console.log(`  ${refreshBtn ? '✅' : '❌'} Refresh button`);

  // Test 4: Stats cards
  console.log('\nTest 4: Stats cards');
  const statsCards = await page.locator('.stat-card').count();
  console.log(`  ${statsCards >= 4 ? '✅' : '❌'} Found ${statsCards} stat cards`);

  // Test 5: Main panels
  console.log('\nTest 5: Main panels');
  const panels = await page.locator('.terminal-section').count();
  console.log(`  ${panels >= 2 ? '✅' : '❌'} Found ${panels} panels`);

  // Test 6: API endpoint (if Vercel deployment)
  if (workingUrl.includes('vercel.app')) {
    console.log('\nTest 6: API endpoint');
    try {
      const apiResponse = await page.goto(`${workingUrl}/api/scan`, { timeout: 30000 });
      const apiData = await apiResponse.json();

      if (apiData.success) {
        console.log(`  ✅ API working - scanned ${apiData.stats?.marketsScanned || 0} markets`);
        console.log(`  ✅ Opportunities: ${apiData.opportunities?.length || 0}`);
        console.log(`  ✅ Near-misses: ${apiData.nearMisses?.length || 0}`);
        console.log(`  ✅ Live markets: ${apiData.liveMarkets?.length || 0}`);
      } else {
        console.log(`  ❌ API error: ${apiData.error}`);
      }
    } catch (error) {
      console.log(`  ❌ API test failed: ${error.message}`);
    }
  }

  // Test 7: Keyboard shortcuts (interactive)
  console.log('\nTest 7: Keyboard shortcuts');
  await page.goto(workingUrl);
  await page.waitForTimeout(1000);

  // Press 'R' for refresh
  await page.keyboard.press('r');
  await page.waitForTimeout(500);
  const toast = await page.locator('.toast.show').isVisible().catch(() => false);
  console.log(`  ${toast ? '✅' : '⚠️'} Toast notification on 'R' press`);

  // Take screenshot
  console.log('\nTest 8: Screenshot');
  const screenshotPath = '/Users/jefferson/Desktop/400000dollars/plugin-polymarket/deployment-screenshot.png';
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`  ✅ Screenshot saved: ${screenshotPath}`);

  await browser.close();

  console.log('\n✨ Deployment test complete!\n');
  console.log(`🌐 URL: ${workingUrl}`);
}

testDeployment().catch(console.error);

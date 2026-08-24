// Playwright verification: with an invalid LITELLM_BASE, the error must be
// shown inside the #chart container (where the Sankey would render), in red,
// and NOT in the bottom warnings area.
const { chromium } = require('playwright');
const { spawn } = require('child_process');

(async () => {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, LITELLM_BASE: 'http://localhost:9999', PORT: '5173' },
    stdio: 'pipe',
  });
  let so = '', se = '';
  server.stdout.on('data', d => so += d);
  server.stderr.on('data', d => se += d);

  const killServer = () => {
    try { process.kill(server.pid, 'SIGKILL'); } catch {}
  };

  await new Promise(r => setTimeout(r, 2500));
  if (se.includes('EADDRINUSE')) {
    console.log('FAIL: server could not start (EADDRINUSE)');
    killServer();
    process.exit(1);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });

  await page.waitForFunction(() => {
    const el = document.getElementById('chartError');
    return el && el.hidden === false && el.textContent.length > 0;
  }, { timeout: 8000 });

  const chartErrorText = await page.evaluate(() => {
    const el = document.getElementById('chartError');
    return el ? el.textContent : null;
  });
  const chartErrorColor = await page.evaluate(() => {
    const el = document.getElementById('chartError');
    return el ? getComputedStyle(el).color : null;
  });
  const chartErrorFontSize = await page.evaluate(() => {
    const el = document.getElementById('chartError');
    return el ? getComputedStyle(el).fontSize : null;
  });
  const inChartArea = await page.evaluate(() => {
    const chart = document.getElementById('chart');
    const err = document.getElementById('chartError');
    return chart && err ? chart.contains(err) : false;
  });
  const bottomWarnings = await page.evaluate(() => {
    const w = document.getElementById('warnings');
    return w ? w.textContent.trim() : null;
  });

  console.log('=== chart area error ===');
  console.log('inChartArea:', inChartArea);
  console.log('text:', chartErrorText);
  console.log('color:', chartErrorColor, '(expect rgb(255, 77, 77) = #ff4d4d)');
  console.log('fontSize:', chartErrorFontSize, '(expect 28px)');
  console.log('bottomWarnings text:', JSON.stringify(bottomWarnings), '(expect empty)');

  const pass = inChartArea && chartErrorText && chartErrorColor === 'rgb(255, 77, 77)'
    && chartErrorFontSize === '28px' && !bottomWarnings;
  console.log(pass ? 'PASS' : 'FAIL');
  await browser.close();
  killServer();
  process.exit(pass ? 0 : 1);
})().catch(e => {
  console.error('ERR', e.message);
  process.exit(1);
});

#!/usr/bin/env node
// github.com/nuhmanpk
// =============================================================================
//  Matricx — Next-Level TUI System Monitor
//  Views: ALL | CPU | GPU | NET | DISK | MEM | PROC
//  Keys : Tab/→ next view  ←/Shift+Tab prev  q quit  s style  h help
// =============================================================================

import si from 'systeminformation';
import os from 'os';
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import prettyBytes from 'pretty-bytes';

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const VIEWS = ['ALL', 'CPU', 'GPU', 'NET', 'DISK', 'MEM', 'PROC', 'DASH', 'SENSORS'];
let currentView = 'ALL';
let SAMPLE_MS = 1000;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') {
    try {
      const results = await Promise.all([
        si.currentLoad(), si.mem(), si.networkStats(), si.processes(), si.fsStats(), si.osInfo(), si.battery().catch(() => ({})), si.graphics().catch(() => ({})), si.cpu().catch(() => ({})), si.diskLayout().catch(() => ([]))
      ]);
      const data = {
        load: results[0], mem: results[1], netStats: results[2], procs: results[3], fsStats: results[4], osInfo: results[5], battery: results[6], gfx: results[7], cpuInfo: results[8], diskLayout: results[9]
      };
      console.log(JSON.stringify(data, null, 2));
      process.exit(0);
    } catch (err) {
      console.error("Error fetching data:", err);
      process.exit(1);
    }
  } else if ((a === '-i' || a === '--interval') && i + 1 < argv.length) {
    SAMPLE_MS = parseInt(argv[i + 1], 10) || 1000;
    i++;
  } else {
    const v = a.replace(/^--/, '').toUpperCase();
    if (VIEWS.includes(v)) { currentView = v; }
  }
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
  Matricx — TUI System Monitor

  Usage: matricx [--cpu | --gpu | --net | --disk | --mem | --proc | --all]

  Keyboard shortcuts (in-app):
    Tab / →        Next view
    ← / Shift+Tab  Previous view
    s              Cycle bar style (blocks › shaded › ascii)
    h              Toggle help overlay
    q / Ctrl+C     Quit

  Views:
    --all   (default) Overview of everything
    --cpu   Deep CPU: sparkline history + per-core bars
    --gpu   GPU info + display list
    --net   Per-interface network + rx/tx sparklines
    --disk  Disk usage + read/write rate sparklines
    --mem   Memory breakdown + swap + text donut
    --proc  Full-screen sortable process table
    --sensors Hardware temperature, battery & fan sensors

  Options:
    --json               Output system specs as JSON and exit
    -i, --interval <ms>  Refresh interval in milliseconds (default 1000)
`);
  process.exit(0);
}

// ── Config ───────────────────────────────────────────────────────────────────
const HIST_LEN = 60;      // sparkline history samples
let barStyle = 'blocks';
const GLYPHS = {
  blocks: { fill: '█', empty: ' ' },
  shaded: { fill: '▓', empty: '░' },
  ascii: { fill: '#', empty: '-' },
};
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// ── History ring buffers ─────────────────────────────────────────────────────
const hist = {
  cpu: [],
  mem: [],
  rxps: [],
  txps: [],
  diskR: [],
  diskW: [],
  sensorsTemp: [],
};
const coreHist = []; // coreHist[i] = ring buffer of load% for core i

function pushHist(key, val) {
  hist[key].push(val);
  if (hist[key].length > HIST_LEN) hist[key].shift();
}
function pushCoreHist(cores) {
  cores.forEach((c, i) => {
    if (!coreHist[i]) coreHist[i] = [];
    coreHist[i].push(safeNum(c.load));
    if (coreHist[i].length > HIST_LEN) coreHist[i].shift();
  });
}

// single-row spark chars (linear scale)
function sparkline(arr, width, color = 'green') {
  if (arr.length === 0) return ' '.repeat(width);
  const max = Math.max(...arr, 1);
  const slice = arr.slice(-width);
  const pad = Math.max(0, width - slice.length);
  const chars = slice.map(v => {
    const idx = Math.min(7, Math.floor((v / max) * 8));
    return SPARK_CHARS[idx];
  });
  return ' '.repeat(pad) + `{${color}-fg}` + chars.join('') + '{/}';
}

// single-row spark chars — LOG scale (makes bursty/sparse data visible)
function logSparkRow(arr, width, color = 'green') {
  if (arr.length === 0) return ' '.repeat(width);
  const logMax = Math.log1p(Math.max(...arr, 1));
  const slice = arr.slice(-width);
  const pad = Math.max(0, width - slice.length);
  const chars = slice.map(v => {
    const idx = Math.min(7, Math.floor((Math.log1p(safeNum(v)) / logMax) * 8));
    return SPARK_CHARS[idx];
  });
  return ' '.repeat(pad) + `{${color}-fg}` + chars.join('') + '{/}';
}

// filled area chart: ▄ at peak row, █ for body below — clean and readable
function areaGraph(arr, width, height, color) {
  if (arr.length === 0) return Array(height).fill('').join('\n');
  const max = Math.max(...arr, 1);
  const slice = arr.slice(-width);
  const pad = Math.max(0, width - slice.length);
  const vals = [...Array(pad).fill(0), ...slice];
  // row 0 = top (100%), row height-1 = bottom (0%)
  const toRow = v => Math.max(0, Math.min(height - 1, Math.floor((1 - safeNum(v) / max) * height)));
  const pts = vals.map(toRow);
  const grid = Array.from({ length: height }, () => new Array(width).fill(' '));
  for (let x = 0; x < width; x++) {
    const y = pts[x];
    grid[y][x] = '▄';            // top edge
    for (let r = y + 1; r < height; r++) grid[r][x] = '█'; // fill
  }
  return grid.map((row, i) => {
    const pct = Math.round(((height - 1 - i) / (height - 1)) * 100);
    return `{grey-fg}${String(pct).padStart(3)}%{/} {${color}-fg}${row.join('')}{/}`;
  }).join('\n');
}

// LOG-scaled filled area — ideal for network/disk bursty data
function logAreaGraph(arr, width, height, color) {
  if (arr.length === 0) return Array(height).fill('').join('\n');
  const max = Math.max(...arr, 1);
  const logMax = Math.log1p(max);
  const slice = arr.slice(-width);
  const pad = Math.max(0, width - slice.length);
  const vals = [...Array(pad).fill(0), ...slice];
  const toRow = v => Math.max(0, Math.min(height - 1, Math.floor((1 - Math.log1p(safeNum(v)) / logMax) * height)));
  const pts = vals.map(toRow);
  const grid = Array.from({ length: height }, () => new Array(width).fill(' '));
  for (let x = 0; x < width; x++) {
    const y = pts[x];
    grid[y][x] = '▄';
    for (let r = y + 1; r < height; r++) grid[r][x] = '█';
  }
  return grid.map((row, i) => {
    const logVal = (1 - i / (height - 1)) * logMax;
    const label = prettyBytes(Math.expm1(logVal));
    return `{grey-fg}${label.padStart(9)}{/} {${color}-fg}${row.join('')}{/}`;
  }).join('\n');
}

// kept for disk view (plain area, labelled)
function sparklineGraph(arr, width, height, color, label, unit = '') {
  if (arr.length === 0) return Array(height).fill('').join('\n');
  const max = Math.max(...arr, 1);
  const slice = arr.slice(-width);
  const pad = Math.max(0, width - slice.length);
  const rows = [];
  for (let row = height - 1; row >= 0; row--) {
    const threshold = (row / height) * max;
    let line = ' '.repeat(pad);
    for (const v of slice) {
      line += v >= threshold ? `{${color}-fg}█{/}` : ' ';
    }
    if (row === height - 1) line += ` ${label}`;
    if (row === 0) line += ` max:${unit ? prettyBytes(max) : max.toFixed(0)}${unit}`;
    rows.push(line);
  }
  return rows.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const safeNum = n => Number.isFinite(n) ? n : 0;
const stripTags = s => String(s).replace(/\{\/?\w[^}]*\}/g, '');
const pctColor = pc => pc >= 80 ? 'red' : pc >= 50 ? 'yellow' : 'green';
const rateColor = bs => { const mb = Math.abs(bs) / 1e6; return mb > 5 ? 'red' : mb > 1 ? 'yellow' : 'green'; };
const contentWidth = () => Math.max(10, (screen.width || 80) - 2);
const contentHeight = () => Math.max(4, (screen.height || 24) - 2);

function truncateMiddle(str, max) {
  if (str.length <= max) return str;
  if (max <= 3) return str.slice(0, max);
  const h = Math.floor((max - 3) / 2);
  return str.slice(0, h) + '…' + str.slice(str.length - h);
}
function makeBar(fraction, length, color) {
  const g = GLYPHS[barStyle] || GLYPHS.blocks;
  const filled = Math.max(0, Math.min(length, Math.round(length * fraction)));
  const empty = Math.max(0, length - filled);
  return `{${color}-fg}${g.fill.repeat(filled)}{/}` + g.empty.repeat(empty);
}
function makeMiniBar(fraction, length = 6, color = 'green') {
  const filled = Math.max(0, Math.min(length, Math.round(length * fraction)));
  return `{${color}-fg}` + '|'.repeat(filled) + '{/}' + ' '.repeat(Math.max(0, length - filled));
}
function makeAlignedBarLine({ label = '', fraction = 0, rightText = '', color = 'green', width = 0 }) {
  const innerW = width || contentWidth();
  const labelTxt = label ? label + ' ' : '';
  const rightLen = stripTags(rightText).length;
  const fixedL = 1 + labelTxt.length;
  let barLen = innerW - fixedL - rightLen - 1;
  if (barLen < 0) barLen = 0;
  const bar = makeBar(fraction, barLen, color);
  const gap = Math.max(1, innerW - fixedL - stripTags(bar).length - rightLen);
  return ' ' + labelTxt + bar + ' '.repeat(gap) + rightText;
}
function spaceEvenly(items, width) {
  if (!items.length) return '';
  const total = items.map(stripTags).reduce((a, s) => a + s.length, 0);
  const space = Math.max(1, Math.floor((width - total) / Math.max(1, items.length - 1)));
  return items.join(' '.repeat(space));
}
function textDonut(used, total, radius = 4) {
  // Draw a simple text-mode arc ring inside a box
  const pct = total > 0 ? used / total : 0;
  const filled = Math.round(pct * 16); // 16 "cells" around ring
  const ring = [];
  const W = radius * 2 + 1;
  for (let r = -radius; r <= radius; r++) {
    let row = '';
    for (let c = -radius; c <= radius; c++) {
      const dist = Math.sqrt(r * r + c * c);
      const inner = radius - 1.35;
      const outer = radius + 0.25;
      if (dist >= inner && dist <= outer) {
        // map angle to 0-16 segment
        const angle = Math.atan2(c, r) + Math.PI; // 0..2PI
        const seg = Math.floor((angle / (2 * Math.PI)) * 16);
        row += seg < filled ? `{cyan-fg}█{/}` : `{white-fg}░{/}`;
      } else if (dist < inner) {
        // centre label
        const cx = r + radius, cy = c + radius;
        if (cx === radius && cy === radius - 1) {
          row += `{bold}${Math.round(pct * 100)}%{/bold}`;
          c += String(Math.round(pct * 100)).length; // skip width
        } else row += ' ';
      } else row += ' ';
    }
    ring.push(row);
  }
  return ring.join('\n');
}

// ── Blessed screen ───────────────────────────────────────────────────────────
const screen = blessed.screen({ smartCSR: true, title: 'Matricx', fullUnicode: true });

// ── Header ───────────────────────────────────────────────────────────────────
const header = blessed.box({
  top: 0, left: 0, width: '100%', height: 1,
  style: { bg: 'black', fg: 'white' },
  tags: true,
});
screen.append(header);

function renderHeader() {
  const tabs = VIEWS.map(v => {
    return v === currentView
      ? `{black-fg}{cyan-bg} ${v} {/}`
      : `{white-fg} ${v} {/}`;
  }).join('{grey-fg}│{/}');
  header.setContent(
    `{bold}{cyan-fg}Matricx{/}  ${tabs}  {grey-fg}← Tab → navigate  s style  h help  q quit{/}`
  );
}

// ── Help overlay ─────────────────────────────────────────────────────────────
const helpBox = blessed.box({
  top: 'center', left: 'center', width: 52, height: 18,
  label: ' ⌨  Keybinds ', border: { type: 'line' },
  style: { border: { fg: 'cyan' }, bg: 'black' },
  tags: true, hidden: true,
  content: [
    '',
    '  {cyan-fg}Tab{/} / {cyan-fg}→{/}          Next view',
    '  {cyan-fg}←{/} / {cyan-fg}Shift+Tab{/}    Previous view',
    '',
    '  {cyan-fg}s{/}               Cycle bar style',
    '  {cyan-fg}h{/}               Toggle this help',
    '  {cyan-fg}q{/} / {cyan-fg}Ctrl+C{/}       Quit',
    '',
    '  {yellow-fg}In PROC view:{/}',
    '  {cyan-fg}c{/}  Sort by CPU',
    '  {cyan-fg}m{/}  Sort by Memory',
    '  {cyan-fg}n{/}  Sort by Name',
    '  {cyan-fg}↑ ↓{/} Scroll list',
    '',
    '  {grey-fg}Press h to close{/}',
  ].join('\n'),
});
screen.append(helpBox);
let helpVisible = false;

// ── Box factory ───────────────────────────────────────────────────────────────
function makeBox(opts) {
  const box = blessed.box({
    border: { type: 'line' },
    style: { border: { fg: 'grey' } },
    tags: true,
    scrollable: opts.scrollable || false,
    alwaysScroll: opts.alwaysScroll || false,
    ...opts,
  });
  screen.append(box);
  return box;
}

// ══════════════════════════════════════════════════════════════════════════════
//  VIEW BOXES
// ══════════════════════════════════════════════════════════════════════════════

// ── ALL (overview) boxes ─────────────────────────────────────────────────────
const allCpuBox = makeBox({ label: ' ▤ CPU ', top: 1, left: 0, width: '100%', height: 6 });
const allMemBox = makeBox({ label: ' ◉ Memory ', top: 7, left: 0, width: '100%', height: 4 });
const allNetBox = makeBox({ label: ' ↕ Network ', top: 11, left: 0, width: '100%', height: 4 });
const allProcBox = makeBox({
  label: ' ≡ Processes ', top: 15, left: 0, width: '100%', bottom: 6,
  scrollable: true, alwaysScroll: true
});
const allSvcBox = makeBox({ label: ' ⚙ Services ', bottom: 3, left: 0, width: '100%', height: 3 });
const allFooter = makeBox({ bottom: 0, left: 0, width: '100%', height: 3 });

// ── CPU view boxes ────────────────────────────────────────────────────────────
const cpuSparkBox = makeBox({ label: ' ▤ CPU History (60s) ', top: 1, left: 0, width: '100%', height: 10, hidden: true });
const cpuCoreBox = makeBox({ label: ' ⬡ Per-Core Load ', top: 11, left: 0, width: '60%', bottom: 3, hidden: true });
const cpuInfoBox = makeBox({ label: ' ℹ CPU Info ', top: 11, right: 0, width: '40%', bottom: 3, hidden: true });
const cpuFooterBox = makeBox({ bottom: 0, left: 0, width: '100%', height: 3, hidden: true });

// ── GPU view boxes ─────────────────────────────────────────────────────────────
const gpuInfoBox = makeBox({ label: ' ⬡ GPU Info ', top: 1, left: 0, width: '100%', height: 12, hidden: true });
const gpuDispsBox = makeBox({ label: ' ⬕ Displays ', top: 13, left: 0, width: '100%', bottom: 0, hidden: true });

// ── NET view boxes ────────────────────────────────────────────────────────────
const netIfaceBox = makeBox({ label: ' ≡ Interfaces ', top: 1, left: 0, width: '40%', bottom: 0, hidden: true });
const netRxBox = makeBox({ label: ' ↓ Download History ', top: 1, left: '40%', width: '60%', height: 10, hidden: true });
const netTxBox = makeBox({ label: ' ↑ Upload History ', top: 11, left: '40%', width: '60%', bottom: 0, hidden: true });

// ── DISK view boxes ───────────────────────────────────────────────────────────
const diskUsageBox = makeBox({ label: ' ⬣ Disk Usage ', top: 1, left: 0, width: '100%', height: 8, hidden: true });
const diskRateBox = makeBox({ label: ' ⟳ Disk I/O History ', top: 9, left: 0, width: '100%', bottom: 0, hidden: true });

// ── MEM view boxes ────────────────────────────────────────────────────────────
const memBarBox = makeBox({ label: ' ◉ Memory Usage ', top: 1, left: 0, width: '60%', height: 8, hidden: true });
const memDonutBox = makeBox({ label: ' ◎ Usage Donut ', top: 1, left: '60%', width: '40%', height: 8, hidden: true, style: { border: { fg: 'cyan' } } });
const memDetailBox = makeBox({ label: ' ≡ Breakdown ', top: 9, left: 0, width: '100%', bottom: 0, hidden: true });

// ── PROC view boxes ───────────────────────────────────────────────────────────
const procFullBox = makeBox({
  label: ' ≡ Processes ', top: 1, left: 0, width: '100%', bottom: 0,
  scrollable: true, alwaysScroll: true, hidden: true,
  style: { border: { fg: 'green' } },
});

// ── SENSORS view boxes ────────────────────────────────────────────────────────
const sensorsTempBox = makeBox({ label: ' 🌡️ Thermal History (Main) ', top: 1, left: 0, width: '100%', height: 10, hidden: true });
const sensorsInfoBox = makeBox({ label: ' ℹ Hardware Temps & Fans ', top: 11, left: 0, width: '60%', bottom: 0, hidden: true });
const sensorsBatteryBox = makeBox({ label: ' 🔋 Power Source ', top: 11, right: 0, width: '40%', bottom: 0, hidden: true });

// ── DASH view boxes (blessed-contrib) ───────────────────────────────────────
const dashGrid = new contrib.grid({ screen, rows: 12, cols: 12 });
const dashMemPie = dashGrid.set(0, 8, 4, 4, contrib.donut, {
  label: 'Memory Usage',
  radius: 8,
  arcWidth: 3,
  remainColor: 'black',
  yPadding: 2,
  hidden: true,
});
const dashCpuBar = dashGrid.set(0, 0, 4, 8, contrib.bar, {
  label: 'CPU Core Load',
  barWidth: 5,
  barSpacing: 6,
  xOffset: 2,
  maxHeight: 100,
  hidden: true,
});
const dashNetLine = dashGrid.set(4, 0, 8, 8, contrib.line, {
  label: 'Network History (Download/Upload)',
  style: { line: ['green', 'cyan'], text: 'white', baseline: 'grey' },
  xLabelPadding: 3,
  xPadding: 5,
  showLegend: true,
  wholeNumbersOnly: false,
  legend: { width: 20 },
  hidden: true,
});
const dashProcTable = dashGrid.set(4, 8, 8, 4, contrib.table, {
  keys: true,
  fg: 'white',
  label: 'Top Processes',
  columnSpacing: 2,
  columnWidth: [20, 8, 8],
  hidden: true,
});


// ══════════════════════════════════════════════════════════════════════════════
//  VIEW VISIBILITY
// ══════════════════════════════════════════════════════════════════════════════
const VIEW_BOXES = {
  ALL: [allCpuBox, allMemBox, allNetBox, allProcBox, allSvcBox, allFooter],
  CPU: [cpuSparkBox, cpuCoreBox, cpuInfoBox, cpuFooterBox],
  GPU: [gpuInfoBox, gpuDispsBox],
  NET: [netIfaceBox, netRxBox, netTxBox],
  DISK: [diskUsageBox, diskRateBox],
  MEM: [memBarBox, memDonutBox, memDetailBox],
  PROC: [procFullBox],
  SENSORS: [sensorsTempBox, sensorsInfoBox, sensorsBatteryBox],
  DASH: [dashMemPie, dashCpuBar, dashNetLine, dashProcTable],
};

function switchView(v) {
  Object.values(VIEW_BOXES).flat().forEach(b => b.hide());
  currentView = v;
  VIEW_BOXES[v].forEach(b => b.show());
  renderHeader();
  screen.render();
}

// ── Keys / navigation ─────────────────────────────────────────────────────────
screen.key(['q', 'C-c'], () => process.exit(0));
screen.key(['tab', 'right'], () => {
  const idx = VIEWS.indexOf(currentView);
  switchView(VIEWS[(idx + 1) % VIEWS.length]);
});
screen.key(['left', 'S-tab'], () => {
  const idx = VIEWS.indexOf(currentView);
  switchView(VIEWS[(idx - 1 + VIEWS.length) % VIEWS.length]);
});
screen.key(['s'], () => {
  const styles = Object.keys(GLYPHS);
  barStyle = styles[(styles.indexOf(barStyle) + 1) % styles.length];
});
screen.key(['h'], () => {
  helpVisible = !helpVisible;
  helpVisible ? helpBox.show() : helpBox.hide();
  screen.render();
});

// PROC view sort
let procSort = 'cpu'; // cpu | mem | name
screen.key(['c'], () => { if (currentView === 'PROC') procSort = 'cpu'; });
screen.key(['m'], () => { if (currentView === 'PROC') procSort = 'mem'; });
screen.key(['n'], () => { if (currentView === 'PROC') procSort = 'name'; });
procFullBox.key(['up'], () => { procFullBox.scroll(-1); screen.render(); });
procFullBox.key(['down'], () => { procFullBox.scroll(1); screen.render(); });

// ══════════════════════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════════════════════
let lastNet = null;
let lastDisk = null;
let obsNetMax = 1;
let obsDiskMax = 1;

const SERVICE_MATCHERS = [
  { name: 'Docker', matches: ['dockerd', 'docker', 'containerd'] },
  { name: 'MongoDB', matches: ['mongod', 'mongo'] },
  { name: 'Postgres', matches: ['postgres', 'postgresql'] },
  { name: 'MySQL', matches: ['mysqld', 'mysql'] },
  { name: 'Redis', matches: ['redis-server', 'redis'] },
  { name: 'Nginx', matches: ['nginx'] },
  { name: 'Apache', matches: ['httpd', 'apache2'] },
];

// cache slow data
let cachedGfx = null;
let cachedCpuInfo = null;
let cachedDiskLayout = null;

// Fetch slow static hardware data once at startup
si.graphics().then(g => { cachedGfx = g; }).catch(() => { });
si.cpu().then(c => { cachedCpuInfo = c; }).catch(() => { });
si.diskLayout().then(d => { cachedDiskLayout = d; }).catch(() => { });

// ══════════════════════════════════════════════════════════════════════════════
//  SAMPLE + RENDER
// ══════════════════════════════════════════════════════════════════════════════
async function sampleOnce() {
  try {
    const now = Date.now();

    // Only fetch processes if the current view actually needs them to save CPU usage
    const needsProcs = ['ALL', 'CPU', 'PROC', 'DASH'].includes(currentView);
    const needsSensors = currentView === 'SENSORS';

    const [load, mem, netStatsRaw, procs, fsStats, osInfo, battery, thermal] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
      needsProcs ? si.processes() : Promise.resolve({ list: [] }),
      si.fsStats(),
      si.osInfo(),
      si.battery().catch(() => ({})),
      needsSensors ? si.cpuTemperature().catch(() => ({})) : Promise.resolve({}),
    ]);
    const loadAvg = os.loadavg();

    // ── Network delta ─────────────────────────────────────────────────────────
    const netStats = Array.isArray(netStatsRaw) ? netStatsRaw : (netStatsRaw ? [netStatsRaw] : []);
    const primary = netStats.find(n => safeNum(n.rx_bytes) + safeNum(n.tx_bytes) > 0) || netStats[0];
    let rxps = 0, txps = 0;

    if (primary) {
      if (Number.isFinite(primary.rx_sec) && primary.rx_sec > 0) rxps = safeNum(primary.rx_sec);
      if (Number.isFinite(primary.tx_sec) && primary.tx_sec > 0) txps = safeNum(primary.tx_sec);
      if (!(rxps > 0 || txps > 0) && lastNet) {
        const dt = Math.max(0.001, (now - lastNet.t) / 1000);
        rxps = (safeNum(primary.rx_bytes) - lastNet.rx) / dt;
        txps = (safeNum(primary.tx_bytes) - lastNet.tx) / dt;
      }
      lastNet = { rx: safeNum(primary.rx_bytes || 0), tx: safeNum(primary.tx_bytes || 0), t: now };
    }
    obsNetMax = Math.max(obsNetMax * 0.95, 1, Math.abs(rxps), Math.abs(txps));

    // ── Disk delta ────────────────────────────────────────────────────────────
    let diskR = 0, diskW = 0;
    if (fsStats) {
      if (Number.isFinite(fsStats.rx_sec) && fsStats.rx_sec >= 0) diskR = safeNum(fsStats.rx_sec);
      if (Number.isFinite(fsStats.wx_sec) && fsStats.wx_sec >= 0) diskW = safeNum(fsStats.wx_sec);
      if (diskR === 0 && diskW === 0 && lastDisk) {
        const dt = Math.max(0.001, (now - lastDisk.t) / 1000);
        diskR = Math.max(0, (safeNum(fsStats.rx) - lastDisk.rx) / dt);
        diskW = Math.max(0, (safeNum(fsStats.wx) - lastDisk.wx) / dt);
      }
      lastDisk = { rx: safeNum(fsStats.rx), wx: safeNum(fsStats.wx), t: now };
    }
    obsDiskMax = Math.max(obsDiskMax * 0.95, 1, diskR, diskW);

    // ── CPU values ────────────────────────────────────────────────────────────
    const cpuPct = safeNum(load.currentLoad || 0);
    const cores = load.cpus || [];
    pushHist('cpu', cpuPct);
    if (needsSensors && thermal) pushHist('sensorsTemp', safeNum(thermal.main || 0));
    pushHist('rxps', rxps);
    pushHist('txps', txps);
    pushHist('diskR', diskR);
    pushHist('diskW', diskW);
    pushCoreHist(cores);

    // ── Memory values ─────────────────────────────────────────────────────────
    const totalMem = safeNum(mem.total);
    const usedMem = safeNum(mem.active || mem.used);
    const cachedMem = safeNum(mem.cached);
    const freeMem = safeNum(mem.available || (totalMem - usedMem));
    const swapTotal = safeNum(mem.swaptotal);
    const swapUsed = safeNum(mem.swapused);
    const memPct = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;
    pushHist('mem', memPct);

    // ── Uptime/footer info ────────────────────────────────────────────────────
    const uptimeSec = safeNum(si.time().uptime);
    const uptimeDays = Math.floor(uptimeSec / 86400);
    const uptimeHrs = Math.floor((uptimeSec % 86400) / 3600);
    const uptimeMin = Math.floor((uptimeSec % 3600) / 60);
    const nowStr = new Date().toLocaleTimeString();

    const footerContent =
      `{green-fg}${osInfo.distro} ${osInfo.release} (${osInfo.kernel}){/}  │  ` +
      `{cyan-fg}Up: ${uptimeDays}d ${uptimeHrs}h ${uptimeMin}m{/}  │  ` +
      `{yellow-fg}Load: ${loadAvg.map(v => v.toFixed(2)).join(' ')}{/}  │  ` +
      `{magenta-fg}Battery: ${battery?.hasBattery ? battery.percent + '%' : 'N/A'}{/}  │  ` +
      `{white-fg}${nowStr}{/}`;

    // ══════════════════════════════════════════════════════════════════════════
    //  RENDER PER VIEW
    // ══════════════════════════════════════════════════════════════════════════

    // ── ALL view ──────────────────────────────────────────────────────────────
    if (currentView === 'ALL') {
      const innerW = contentWidth();

      // CPU
      const miniLen = 6;
      const coreItems = cores.map((c, i) => {
        const pct = safeNum(c.load);
        const bar = makeMiniBar(pct / 100, miniLen, pctColor(pct));
        return `C${i + 1}:${bar} ${String(Math.round(pct)).padStart(2, '0')}%`;
      });
      const half = Math.ceil(coreItems.length / 2);
      const cpuLine = makeAlignedBarLine({
        fraction: cpuPct / 100, color: pctColor(cpuPct),
        rightText: `${cpuPct.toFixed(1)}% │ cores:${cores.length}`,
      });
      // 1-row sparkline in cpu box line 2
      const cpuSpk = sparkline(hist.cpu, innerW - 2, pctColor(cpuPct));
      allCpuBox.setContent(
        cpuLine + '\n' +
        ' ' + cpuSpk + '\n' +
        spaceEvenly(coreItems.slice(0, half), innerW) + '\n' +
        spaceEvenly(coreItems.slice(half), innerW)
      );

      // Memory
      const memLine = makeAlignedBarLine({
        fraction: memPct / 100, color: pctColor(memPct),
        rightText: `${memPct.toFixed(1)}%`,
      });
      const memSpk = sparkline(hist.mem, innerW - 2, pctColor(memPct));
      allMemBox.setContent(
        memLine + '\n' +
        ' ' + memSpk + '\n' +
        ` ${prettyBytes(usedMem)} / ${prettyBytes(totalMem)}` +
        (swapTotal > 0 ? `  Swap: ${prettyBytes(swapUsed)}/${prettyBytes(swapTotal)}` : '')
      );

      // Network
      const downLine = makeAlignedBarLine({
        label: 'Down', fraction: rxps / obsNetMax,
        rightText: `↓ ${prettyBytes(rxps)}/s`, color: rateColor(rxps),
      });
      const upLine = makeAlignedBarLine({
        label: 'Up  ', fraction: txps / obsNetMax,
        rightText: `↑ ${prettyBytes(txps)}/s`, color: rateColor(txps),
      });
      allNetBox.setContent(downLine + '\n' + upLine);

      // Processes
      const procTop = 15, reservedBot = 6;
      const procH = Math.max(5, (screen.height || 24) - procTop - reservedBot);
      const maxProcs = Math.max(5, procH - 3);
      const pidW = 6, cpuW = 7, rssW = 10, gap = 2;
      const nameW = Math.max(12, innerW - pidW - cpuW - rssW - gap * 3);
      const heading = `${'NAME'.padEnd(nameW)}${' '.repeat(gap)}${'PID'.padStart(pidW)}${'CPU%'.padStart(cpuW + gap)}${'RSS'.padStart(rssW + gap)}`;
      const sortedProcs = (procs.list || []).slice().sort((a, b) =>
        (b.cpu || 0) - (a.cpu || 0) || (b.memRss || 0) - (a.memRss || 0)
      ).slice(0, maxProcs);
      const lines = ['{bold}' + heading + '{/}'];
      for (const p of sortedProcs) {
        const cpuVal = safeNum(p.cpu || 0);
        const col = pctColor(cpuVal);
        const name = truncateMiddle(String(p.name || p.command || ''), nameW).padEnd(nameW);
        const pid = String(p.pid || '').padStart(pidW);
        const cpu = `{${col}-fg}${cpuVal.toFixed(1).padStart(cpuW)}{/}`;
        const rss = prettyBytes(p.memRss || 0).padStart(rssW);
        lines.push(`${name}${' '.repeat(gap)}${pid}${' '.repeat(gap)}${cpu}${' '.repeat(gap)}${rss}`);
      }
      while (lines.length < maxProcs + 2) lines.push('');
      allProcBox.setContent(lines.join('\n'));

      // Services
      const lowerProcs = (procs.list || []).map(p => ({ name: (p.name || '').toLowerCase(), pid: p.pid, cpu: p.cpu }));
      const svcStatus = SERVICE_MATCHERS.map(svc => {
        const found = lowerProcs.find(p => svc.matches.some(m => p.name.includes(m)));
        return found
          ? `${svc.name}:{green-fg}✔{/}(${found.pid})`
          : `${svc.name}:{red-fg}✘{/}`;
      });
      allSvcBox.setContent(' ' + svcStatus.join('  │  '));

      // Footer
      allFooter.setContent(footerContent);
    }

    // ── CPU view ──────────────────────────────────────────────────────────────
    if (currentView === 'CPU') {
      const screenH = screen.height || 24;
      const innerW = contentWidth();

      // Dynamic: spark box = 40% of screen, core+info box = rest
      const sparkBoxH = Math.max(8, Math.floor(screenH * 0.40));
      cpuSparkBox.height = sparkBoxH;
      cpuCoreBox.top = sparkBoxH + 1;
      cpuInfoBox.top = sparkBoxH + 1;

      // ── Area chart (filled, ▄ top edge) with % labels ────────────────────
      const sparkH = Math.max(4, sparkBoxH - 2);
      const graphW = innerW - 6; // leave 5 chars for y-axis labels
      const area = areaGraph(hist.cpu, graphW, sparkH, pctColor(cpuPct));
      const titleRow = `{bold}{cyan-fg} CPU ${cpuPct.toFixed(1)}%{/}  ` +
        `{grey-fg}1m:${loadAvg[0].toFixed(2)} 5m:${loadAvg[1].toFixed(2)} 15m:${loadAvg[2].toFixed(2)}{/}  ` +
        `{grey-fg}60s history{/}`;
      cpuSparkBox.setContent(titleRow + '\n' + area);

      // ── Per-core bars + mini sparkline (left panel) ───────────────────────
      const coreW = Math.floor(innerW * 0.6) - 2;
      const miniSpkW = Math.max(8, Math.floor(coreW * 0.22));
      const barW = coreW; // makeAlignedBarLine handles the math

      const coreLines = cores.map((c, i) => {
        const pct = safeNum(c.load);
        const col = pctColor(pct);
        const ch = coreHist[i] || [];
        const mini = logSparkRow(ch, miniSpkW, col);
        const bar = makeAlignedBarLine({
          label: `C${String(i + 1).padStart(2)}`,
          fraction: pct / 100, color: col,
          rightText: `${mini} ${pct.toFixed(1)}%`,
          width: barW,
        });
        return bar;
      });

      // Fill remaining rows with a heatmap grid of all cores
      const usedRows = coreLines.length;
      const boxInnerH = Math.max(0, screenH - (sparkBoxH + 1) - 3 - 2);
      if (usedRows < boxInnerH) {
        coreLines.push('');
        coreLines.push(' {grey-fg}── Core Heatmap (recent 30s) ──{/}');
        // 10-column heatmap: one char per sample per core
        const hmSamples = 30;
        const gradient = [' ', '░', '▒', '▓', '█'];
        for (let ci2 = 0; ci2 < cores.length && coreLines.length < boxInnerH; ci2++) {
          const ch2 = (coreHist[ci2] || []).slice(-hmSamples);
          const padded2 = [...Array(Math.max(0, hmSamples - ch2.length)).fill(0), ...ch2];
          const cells = padded2.map(v => {
            const g = Math.min(4, Math.floor((v / 100) * 5));
            const c2 = v >= 80 ? 'red' : v >= 50 ? 'yellow' : 'green';
            return `{${c2}-fg}${gradient[g]}{/}`;
          }).join('');
          coreLines.push(` {grey-fg}C${String(ci2 + 1).padStart(2)}{/} ${cells}`);
        }
      }
      cpuCoreBox.setContent(coreLines.join('\n'));

      // ── CPU info + top hogs (right panel) ────────────────────────────────
      const ci = cachedCpuInfo;
      const topHogs = (procs.list || [])
        .slice().sort((a, b) => (b.cpu || 0) - (a.cpu || 0)).slice(0, 6);

      const infoLines = [
        '',
        ` {bold}Model:{/}   ${ci?.brand || os.cpus()[0]?.model || 'N/A'}`,
        ` {bold}Vendor:{/}  ${ci?.manufacturer || 'N/A'}`,
        ` {bold}Cores:{/}   ${ci?.physicalCores || cores.length} physical / ${ci?.cores || cores.length} logical`,
        ` {bold}Speed:{/}   ${ci?.speed ? ci.speed + ' GHz' : 'N/A'}`,
        ` {bold}Max:{/}     ${ci?.speedMax ? ci.speedMax + ' GHz' : 'N/A'}`,
        '',
        ` {bold}Load 1m:{/}  ${loadAvg[0].toFixed(2)}`,
        ` {bold}Load 5m:{/}  ${loadAvg[1].toFixed(2)}`,
        ` {bold}Load 15m:{/} ${loadAvg[2].toFixed(2)}`,
        '',
        ` {grey-fg}── Top CPU Hogs ──{/}`,
      ];
      for (const p of topHogs) {
        const c2 = safeNum(p.cpu || 0);
        const col = pctColor(c2);
        const nm = truncateMiddle(String(p.name || ''), 14).padEnd(14);
        infoLines.push(` {${col}-fg}${nm} ${c2.toFixed(1)}%{/}`);
      }
      infoLines.push('');
      infoLines.push(` {bold}Platform:{/} ${os.platform()} ${os.arch()}`);
      cpuInfoBox.setContent(infoLines.join('\n'));

      cpuFooterBox.setContent(footerContent);
    }

    // ── GPU view ──────────────────────────────────────────────────────────────
    if (currentView === 'GPU') {
      const gfx = cachedGfx;
      if (gfx && gfx.controllers && gfx.controllers.length > 0) {
        const leftLines = [''];
        const rightLines = [''];
        gfx.controllers.forEach((g, i) => {
          leftLines.push(` {bold}{cyan-fg}▸ GPU ${i + 1}{/}{/}`);
          leftLines.push(` {bold}Vendor :{/} ${g.vendor || 'N/A'}`);
          leftLines.push(` {bold}Model  :{/} ${g.model || 'N/A'}`);
          leftLines.push(` {bold}Bus    :{/} ${g.bus || 'N/A'}`);
          leftLines.push(` {bold}Cores  :{/} {cyan-fg}${g.cores || 'N/A'}{/}`);
          leftLines.push(` {bold}VRAM   :{/} {yellow-fg}${g.vram ? prettyBytes(g.vram * 1024 * 1024) : (g.vramDynamic ? 'Dynamic (Unified Memory)' : 'N/A')}{/}`);
          leftLines.push(` {bold}Metal  :{/} ${g.metalVersion || 'N/A'}`);
          leftLines.push(` {bold}External:{/} ${g.external ? '{red-fg}Yes{/}' : '{green-fg}No (Built-in){/}'}`);
        });
        // System info on the right column
        leftLines.push('');
        leftLines.push(' {grey-fg}── System Memory ──{/}');
        leftLines.push(` {bold}Total RAM:{/} ${prettyBytes(safeNum(mem.total))}`);
        leftLines.push(` {bold}Used RAM :{/} {${pctColor(memPct)}-fg}${prettyBytes(usedMem)} (${memPct.toFixed(1)}%){/}`);
        leftLines.push(` {bold}Free RAM :{/} {green-fg}${prettyBytes(safeNum(mem.available))}{/}`);
        leftLines.push('');
        leftLines.push(' {grey-fg}── Platform ──{/}');
        leftLines.push(` {bold}OS     :{/} ${osInfo.distro} ${osInfo.release}`);
        leftLines.push(` {bold}Kernel :{/} ${osInfo.kernel}`);
        leftLines.push(` {bold}Arch   :{/} ${os.arch()}`);
        leftLines.push(` {bold}Hostname:{/} ${os.hostname()}`);
        gpuInfoBox.setContent(leftLines.join('\n'));

        // Displays — with ASCII "screen" art
        const dlines = [''];
        for (const [i, d] of (gfx.displays || []).entries()) {
          const isMain = d.main ? '{green-fg}[PRIMARY]{/}' : '{grey-fg}[external]{/}';
          const hz = d.currentRefreshRate || '?';
          const res = `{cyan-fg}${d.currentResX}×${d.currentResY}{/}`;
          const model = d.model || 'Unknown';
          const builtIn = d.builtin ? '{yellow-fg}Built-in{/}' : (d.connection || 'ext');
          // little ascii monitor frame
          const w = 14, h = 4;
          const top = '  ┌' + '─'.repeat(w) + '┐';
          const bottom = '  └' + '─'.repeat(w) + '┘';
          const mid1 = `  │ ${model.slice(0, w - 2).padEnd(w - 2)} │`;
          const mid2 = `  │ ${String(d.currentResX + '×' + d.currentResY).slice(0, w - 2).padEnd(w - 2)} │`;
          dlines.push(`  {bold}Display ${i + 1}:{/} ${isMain}  ${res} @ ${hz}Hz  ${builtIn}`);
          dlines.push(top);
          dlines.push(`  │{cyan-fg}${model.slice(0, w).padEnd(w)}{/}│`);
          dlines.push(`  │{grey-fg}${String(d.currentResX + 'x' + d.currentResY + ' @' + hz + 'Hz').padEnd(w)}{/}│`);
          dlines.push(bottom);
          dlines.push('');
        }
        gpuDispsBox.setContent(dlines.join('\n'));
      } else {
        gpuInfoBox.setContent('\n  {yellow-fg}No GPU data available yet (loading…){/}');
        gpuDispsBox.setContent('\n  {grey-fg}Waiting for display info…{/}');
      }
    }

    // ── NET view ───────────────────────────────────────────────────────────────
    if (currentView === 'NET') {
      // Interface list (left panel) — with totals
      const ifaceLines = [
        `{bold}{'Iface'.padEnd(10)} ${'IP'.padEnd(15)} ${'↓/s'.padEnd(11)} ${'↑/s'.padEnd(11)} ↓Total    ↑Total{/}`,
        '{grey-fg}' + '─'.repeat(Math.floor(contentWidth() * 0.4) - 3) + '{/}',
      ];
      for (const n of netStats.slice(0, 14)) {
        const active = (n.rx_bytes || 0) + (n.tx_bytes || 0) > 0;
        const col = active ? 'green' : 'grey';
        const iface = truncateMiddle(n.iface || '', 9).padEnd(9);
        const ip = (n.ip4 || '').padEnd(14);
        const rx = prettyBytes(Math.max(0, safeNum(n.rx_sec || 0))).padEnd(10);
        const tx = prettyBytes(Math.max(0, safeNum(n.tx_sec || 0))).padEnd(10);
        const rxt = prettyBytes(safeNum(n.rx_bytes || 0));
        const txt = prettyBytes(safeNum(n.tx_bytes || 0));
        ifaceLines.push(`{${col}-fg}${iface} ${ip} ${rx} ${tx} ${rxt.padEnd(9)} ${txt}{/}`);
      }
      // summary
      ifaceLines.push('');
      ifaceLines.push(`{grey-fg}── Current ──{/}`);
      ifaceLines.push(makeAlignedBarLine({ label: '↓', fraction: rxps / obsNetMax, color: rateColor(rxps), rightText: prettyBytes(rxps) + '/s', width: Math.floor(contentWidth() * 0.4) - 3 }));
      ifaceLines.push(makeAlignedBarLine({ label: '↑', fraction: txps / obsNetMax, color: rateColor(txps), rightText: prettyBytes(txps) + '/s', width: Math.floor(contentWidth() * 0.4) - 3 }));
      netIfaceBox.setContent(ifaceLines.join('\n'));

      // RX panel (right-top): log-scale spark row + log area chart
      const rxW = Math.floor(contentWidth() * 0.6) - 4;
      const rxH = Math.max(4, (netRxBox.height || 10) - 4);
      const rxSpk = logSparkRow(hist.rxps, rxW, rateColor(rxps));
      const rxArea = logAreaGraph(hist.rxps, rxW, rxH, rateColor(rxps));
      const rxPeak = Math.max(...hist.rxps, 0);
      netRxBox.setContent(
        ` {bold}{green-fg}↓ Download{/}  {white-fg}${prettyBytes(rxps)}/s{/}  {grey-fg}peak: ${prettyBytes(rxPeak)}/s  log scale{/}\n` +
        ` ${rxSpk}\n` +
        rxArea
      );

      // TX panel (right-bottom): same treatment
      const txH = Math.max(4, (netTxBox.height || 10) - 4);
      const txSpk = logSparkRow(hist.txps, rxW, rateColor(txps));
      const txArea = logAreaGraph(hist.txps, rxW, txH, rateColor(txps));
      const txPeak = Math.max(...hist.txps, 0);
      netTxBox.setContent(
        ` {bold}{cyan-fg}↑ Upload{/}    {white-fg}${prettyBytes(txps)}/s{/}  {grey-fg}peak: ${prettyBytes(txPeak)}/s  log scale{/}\n` +
        ` ${txSpk}\n` +
        txArea
      );
    }

    // ── DISK view ──────────────────────────────────────────────────────────────
    if (currentView === 'DISK') {
      const innerW = contentWidth();
      const lines = [];
      if (cachedDiskLayout && cachedDiskLayout.length > 0) {
        for (const d of cachedDiskLayout) {
          lines.push(` {bold}${d.name || d.device || 'Disk'}{/}  ${d.type || ''}  ${d.vendor || ''}  ${prettyBytes(d.size || 0)}`);
        }
      } else {
        lines.push(' {grey-fg}Loading disk info…{/}');
      }
      lines.push('');
      lines.push(makeAlignedBarLine({
        label: 'Read ', fraction: diskR / obsDiskMax, color: 'cyan',
        rightText: `↑ ${prettyBytes(diskR)}/s`,
      }));
      lines.push(makeAlignedBarLine({
        label: 'Write', fraction: diskW / obsDiskMax, color: 'yellow',
        rightText: `↓ ${prettyBytes(diskW)}/s`,
      }));
      diskUsageBox.setContent(lines.join('\n'));

      // I/O history sparklines
      const diskH = Math.max(4, (diskRateBox.height || 10) - 2);
      const diskW2 = innerW - 6;
      const half = Math.floor(diskH / 2);
      const rGraph = sparklineGraph(hist.diskR, diskW2, half, 'cyan', `Read  ${prettyBytes(diskR)}/s`, '/s');
      const wGraph = sparklineGraph(hist.diskW, diskW2, half, 'yellow', `Write ${prettyBytes(diskW)}/s`, '/s');
      diskRateBox.setContent(rGraph + '\n' + '{grey-fg}' + '─'.repeat(diskW2) + '{/}\n' + wGraph);
    }

    // ── MEM view ───────────────────────────────────────────────────────────────
    if (currentView === 'MEM') {
      const innerW = Math.floor(contentWidth() * 0.6) - 2;

      // Bar panel
      const lines = [''];
      lines.push(makeAlignedBarLine({ label: 'RAM ', fraction: memPct / 100, color: pctColor(memPct), rightText: `${prettyBytes(usedMem)}/${prettyBytes(totalMem)} ${memPct.toFixed(1)}%`, width: innerW }));
      if (swapTotal > 0) {
        const swapPct = (swapUsed / swapTotal) * 100;
        lines.push(makeAlignedBarLine({ label: 'Swap', fraction: swapPct / 100, color: pctColor(swapPct), rightText: `${prettyBytes(swapUsed)}/${prettyBytes(swapTotal)} ${swapPct.toFixed(1)}%`, width: innerW }));
      }
      // Sparkline row
      const spk = sparkline(hist.mem, innerW - 2, pctColor(memPct));
      lines.push('');
      lines.push(' ' + spk);
      memBarBox.setContent(lines.join('\n'));

      // Donut (right panel)
      const donutLines = textDonut(usedMem, totalMem, 4);
      memDonutBox.setContent('\n' + donutLines);

      // Detail breakdown (bottom)
      const memDetailLines = [
        '',
        `  {bold}Total:{/}     ${prettyBytes(totalMem).padStart(12)}`,
        `  {bold}Used:{/}      {${pctColor(memPct)}-fg}${prettyBytes(usedMem).padStart(12)} (${memPct.toFixed(1)}%){/}`,
        `  {bold}Free:{/}      {green-fg}${prettyBytes(freeMem).padStart(12)}{/}`,
        `  {bold}Cached:{/}    ${prettyBytes(cachedMem).padStart(12)}`,
        `  {bold}Swap Total:{/}${prettyBytes(swapTotal).padStart(12)}`,
        `  {bold}Swap Used:{/} ${prettyBytes(swapUsed).padStart(12)}`,
      ];
      memDetailBox.setContent(memDetailLines.join('\n'));
    }

    // ── PROC view ──────────────────────────────────────────────────────────────
    if (currentView === 'PROC') {
      const innerW = contentWidth();
      const pidW = 6, cpuW = 7, rssW = 11, memW = 7, gap = 2;
      const nameW = Math.max(12, innerW - pidW - cpuW - rssW - memW - gap * 4);

      const sortFn = procSort === 'cpu'
        ? (a, b) => (b.cpu || 0) - (a.cpu || 0)
        : procSort === 'mem'
          ? (a, b) => (b.memRss || 0) - (a.memRss || 0)
          : (a, b) => String(a.name || '').localeCompare(String(b.name || ''));

      const sorted = (procs.list || []).slice().sort(sortFn);

      const sortIndicator = (col) => procSort === col ? '{cyan-fg}▼{/}' : ' ';
      const heading = (
        'NAME'.padEnd(nameW) + ' '.repeat(gap) +
        'PID'.padStart(pidW) + ' '.repeat(gap) +
        `CPU%${sortIndicator('cpu')}`.padStart(cpuW + 12) + ' '.repeat(gap) +
        `MEM%${sortIndicator('mem')}`.padStart(memW + 12) + ' '.repeat(gap) +
        'RSS'.padStart(rssW)
      );

      const lines = ['{bold}' + heading + '{/}', '{grey-fg}' + '─'.repeat(innerW) + '{/}'];
      const totalRam = safeNum(mem.total);

      for (const p of sorted) {
        const cpuVal = safeNum(p.cpu || 0);
        const memVal = totalRam > 0 ? (safeNum(p.memRss || 0) / totalRam) * 100 : 0;
        const cpuCol = pctColor(cpuVal);
        const memCol = pctColor(memVal);
        lines.push(
          truncateMiddle(String(p.name || p.command || ''), nameW).padEnd(nameW) +
          ' '.repeat(gap) +
          String(p.pid || '').padStart(pidW) +
          ' '.repeat(gap) +
          `{${cpuCol}-fg}${cpuVal.toFixed(1).padStart(cpuW)}{/}` +
          ' '.repeat(gap) +
          `{${memCol}-fg}${memVal.toFixed(1).padStart(memW)}%{/}` +
          ' '.repeat(gap) +
          prettyBytes(p.memRss || 0).padStart(rssW)
        );
      }

      const sortHint = '  {grey-fg}sort: [c]pu  [m]em  [n]ame  │  scroll: ↑↓{/}';
      procFullBox.setLabel(` ≡ Processes (${sorted.length})${sortHint} `);
      procFullBox.setContent(lines.join('\n'));
    }

    // ── SENSORS view ──────────────────────────────────────────────────────────
    if (currentView === 'SENSORS') {
      const innerW = contentWidth();
      const sparkH = Math.max(4, (sensorsTempBox.height || 10) - 2);

      // Thermal Graph
      const tempArea = areaGraph(hist.sensorsTemp, innerW - 6, sparkH, 'red');
      const currentTemp = hist.sensorsTemp.length > 0 ? hist.sensorsTemp[hist.sensorsTemp.length - 1] : 0;
      sensorsTempBox.setContent(` {bold}{red-fg}Main Temperature (°C){/}  {white-fg}${currentTemp.toFixed(1)}°C{/}\n` + tempArea);

      // Thermal Info & Fans
      const infoLines = [
        '',
        `  {bold}Main CPU Temp:{/}  ${thermal?.main ? thermal.main + ' °C' : '{grey-fg}N/A{/}'}`,
        `  {bold}Max Config:{/}     ${thermal?.max ? thermal.max + ' °C' : '{grey-fg}N/A{/}'}`,
        `  {bold}Chipset:{/}        ${thermal?.chipset ? thermal.chipset + ' °C' : '{grey-fg}N/A{/}'}`,
        '',
        `  {grey-fg}── Core Temperatures ──{/}`
      ];
      if (thermal?.cores && thermal.cores.length > 0) {
        thermal.cores.forEach((t, i) => {
          infoLines.push(`  Core ${i}:         ${t} °C`);
        });
      } else {
        infoLines.push(`  {grey-fg}No per-core thermal data retrieved.{/}`);
      }
      infoLines.push('');
      infoLines.push(`  {grey-fg}── Fan Speeds ──{/}`);
      infoLines.push(`  {bold}Fans:{/}           {yellow-fg}Unavailable natively via Node.js systeminformation{/}`);
      infoLines.push(`                   {grey-fg}(Requires root OS plugins like lm-sensors or smc){/}`);
      sensorsInfoBox.setContent(infoLines.join('\n'));

      // Battery Info
      const batLines = [
        '',
        `  {bold}Has Battery:{/}    ${battery?.hasBattery ? '{green-fg}Yes{/}' : '{yellow-fg}No{/}'}`
      ];
      if (battery?.hasBattery) {
        const charStatus = battery.isCharging ? '{green-fg}Charging{/}' : '{yellow-fg}Discharging{/}';
        batLines.push(`  {bold}Percentage:{/}     ${battery.percent}%`);
        batLines.push(`  {bold}Status:{/}         ${charStatus}`);
        batLines.push(`  {bold}Cycle Count:{/}    ${battery.cycleCount || 'N/A'}`);
        batLines.push(`  {bold}Health:{/}         ${battery.health ? battery.health + '%' : 'N/A'}`);
        batLines.push(`  {bold}Model:{/}          ${battery.model || 'Unknown'}`);
      }
      sensorsBatteryBox.setContent(batLines.join('\n'));
    }

    // ── DASH view ──────────────────────────────────────────────────────────────
    if (currentView === 'DASH') {
      // Memory Pie
      const memDonutData = [
        { percent: memPct.toFixed(1), label: 'used', color: pctColor(memPct) },
        { percent: (100 - memPct).toFixed(1), label: 'free', color: 'green' },
      ];
      dashMemPie.setData(memDonutData);

      // CPU Bars
      const coreLabels = cores.map((c, i) => `C${i + 1}`);
      const corePcts = cores.map(c => safeNum(c.load));
      dashCpuBar.setData({
        titles: coreLabels,
        data: corePcts,
      });

      // Network Line
      const netTimeLabels = Array.from({ length: HIST_LEN }, (_, i) => `-${HIST_LEN - i}s`);
      const rxSeries = {
        title: 'Download',
        x: netTimeLabels,
        y: hist.rxps,
        style: { line: 'green' },
      };
      const txSeries = {
        title: 'Upload',
        x: netTimeLabels,
        y: hist.txps,
        style: { line: 'cyan' },
      };
      dashNetLine.setData([rxSeries, txSeries]);

      // Process Table
      const sortedProcs = (procs.list || []).slice().sort((a, b) =>
        (b.cpu || 0) - (a.cpu || 0)
      ).slice(0, 10);
      const procData = sortedProcs.map(p => [
        truncateMiddle(String(p.name || p.command || ''), 20),
        String(p.pid),
        safeNum(p.cpu || 0).toFixed(1),
      ]);
      dashProcTable.setData({
        headers: ['Name', 'PID', 'CPU%'],
        data: procData,
      });
    }

  } catch (err) {
    header.setContent(`{red-fg}Matricx error: ${err.message}{/}`);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
process.on('SIGINT', () => process.exit(0));

// Initial keyboard focus for proc scrolling
procFullBox.focus();

switchView(currentView);
renderHeader();

sampleOnce().then(() => screen.render());
setInterval(() => { sampleOnce().then(() => screen.render()); }, SAMPLE_MS);

const express = require('express');
const path = require('path');
const CONFIG = require('./src/config');
const Poller = require('./src/poller');

const app = express();
const poller = new Poller();

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.json')) {
      res.setHeader('Cache-Control', 'public, max-age=10, s-maxage=10');
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    }
  }
}));

// --- SSE endpoint ---
app.get('/api/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // For Cloudflare/nginx

  const added = poller.addSSEClient(res);
  if (!added) {
    res.status(503).end('Too many connections');
    return;
  }

  // Keep-alive ping every 30s
  const pingInterval = setInterval(() => {
    try { res.write(':ping\n\n'); } catch {}
  }, 30000);

  req.on('close', () => {
    clearInterval(pingInterval);
  });
});

// --- API endpoints ---
app.get('/api/latest', (req, res) => {
  const data = poller.lastEstimate;
  if (data) {
    res.json(data);
  } else {
    res.status(503).json({ error: 'Data not ready yet' });
  }
});

app.get('/api/history', (req, res) => {
  res.json(poller.history.getAll());
});

app.get('/api/status', (req, res) => {
  res.json(poller.getStatus());
});

app.get('/health', (req, res) => {
  res.json({ ok: true, lastUpdate: poller.lastEstimate?.timestamp });
});

// --- Start ---
const server = app.listen(CONFIG.PORT, () => {
  console.log(`\n========================================`);
  console.log(`  PROYECCIONES ELECTORALES PERU 2026`);
  console.log(`  Servidor en http://localhost:${CONFIG.PORT}`);
  console.log(`========================================\n`);

  // Start the polling engine
  poller.start();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[server] Shutting down...');
  poller.stop();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  poller.stop();
  server.close(() => process.exit(0));
});

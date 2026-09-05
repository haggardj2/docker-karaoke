import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Duplex } from 'node:stream';
import { apiRouter, setPostQueueUpdate, syncRemoteGatewayTaskState } from './routes/api';
import { mediaRouter } from './routes/media';
import { WebSocketServer } from 'ws';
import { qrRouter } from './routes/qr';
import { rotationRouter } from './routes/rotation';
import { logger, setLogLevel, type LogLevel } from './logger';
import { ensureAdminUser, getSetting, validateSessionInfo } from './db';
import { syncBackgroundTaskState } from './backgroundTasks';

// Helper to add timestamps to console logs
function timestamp() {
  return new Date().toISOString();
}


const app = express();
const port = Number(process.env.PORT || 5174);
const bindHost = process.env.BIND_HOST?.trim();
const BOOTSTRAP_PASSWORD_LOG_DELAY_MS = 5_000;
const webDistDir = process.env.WEB_DIST_DIR?.trim();
const bootstrapAdminPromise = ensureAdminUser().catch((e) => {
  console.error('ensureAdminUser failed', e);
  return null;
});

const runtimeApiBase = process.env.WEB_RUNTIME_API_BASE;
const injectedRuntimeConfigScript = runtimeApiBase === undefined
  ? '<script>window.__ENV__={API_BASE:window.location.origin}</script>'
  : `<script>window.__ENV__={API_BASE:${JSON.stringify(runtimeApiBase.trim())}}</script>`;
let cachedSpaHtmlPromise: Promise<string> | null = null;

async function writeBootstrapCredentialsFile(bootstrapAdmin: { username: string; password: string }) {
  const credentialsFile = process.env.BOOTSTRAP_CREDENTIALS_FILE?.trim();
  if (!credentialsFile) return;

  await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
  await fs.writeFile(
    credentialsFile,
    `${JSON.stringify({
      username: bootstrapAdmin.username,
      password: bootstrapAdmin.password,
      generatedAt: new Date().toISOString(),
      message: 'Change this password immediately after first login.',
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await fs.chmod(credentialsFile, 0o600);
}

function shouldServeSpaFallback(requestPath: string) {
  if (
    requestPath === '/health' ||
    requestPath === '/ws' ||
    requestPath.startsWith('/api/') ||
    requestPath.startsWith('/media/')
  ) {
    return false;
  }

  return !path.posix.basename(requestPath).includes('.');
}

async function getSpaHtml(distDir: string) {
  if (!cachedSpaHtmlPromise) {
    const indexPath = path.join(distDir, 'index.html');
    cachedSpaHtmlPromise = fs.readFile(indexPath, 'utf8').then((html) => {
      const withoutExistingRuntimeConfig = html.replace(/<script>window\.__ENV__=.*?<\/script>/g, '');
      if (withoutExistingRuntimeConfig.includes('</head>')) {
        return withoutExistingRuntimeConfig.replace('</head>', `${injectedRuntimeConfigScript}</head>`);
      }
      return `${injectedRuntimeConfigScript}${withoutExistingRuntimeConfig}`;
    });
  }
  return cachedSpaHtmlPromise;
}

// Configure trust proxy for apps behind reverse proxies/load balancers
// This allows Express to properly identify client IPs from X-Forwarded-For headers
// Default: trust the first proxy (loopback, private networks)
// Can be configured via TRUST_PROXY env variable:
// - 'true' = trust all proxies
// - 'false' = trust no proxies  
// - number = trust first N hops
// - string = trust specific IP/CIDR ranges (comma-separated)
const trustProxyValue = process.env.TRUST_PROXY || '1';
if (trustProxyValue === 'true') {
  app.set('trust proxy', true);
} else if (trustProxyValue === 'false') {
  app.set('trust proxy', false);
} else if (!isNaN(Number(trustProxyValue))) {
  app.set('trust proxy', Number(trustProxyValue));
} else {
  // String value (IP/CIDR ranges)
  app.set('trust proxy', trustProxyValue);
}

// Security: Helmet middleware for security headers
// Note: CSP is disabled because the web app uses inline scripts/styles (React/Vite)
// and embeds external media (YouTube videos, CDG files). 
// Consider enabling CSP with proper directives in production for enhanced security.
app.use(helmet({
  contentSecurityPolicy: false, // Disabled to allow inline scripts/styles and external media
  crossOriginEmbedderPolicy: false, // Allow external media embedding from YouTube, etc.
  crossOriginResourcePolicy: false, // Allow cross-origin loading of images, videos, and other media resources
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// CORS configuration
// Parse ORIGIN env variable and configure CORS to only allow specified origins
// If ORIGIN is not set, allow all origins (not recommended for production)
// IMPORTANT: CORS must be configured BEFORE rate limiting so that error responses
// (like 429 Too Many Requests) include proper CORS headers
const allowedOrigins = process.env.ORIGIN?.split(',').map(origin => origin.trim()) || ['*'];
const corsOptions = {
  origin: allowedOrigins.length === 1 && allowedOrigins[0] === '*' 
    ? true  // Allow all origins if ORIGIN is not configured
    : allowedOrigins,  // Only allow specified origins
  credentials: true,  // Allow cookies and authentication headers
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-session-token'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600  // Cache preflight requests for 10 minutes
};

const wildcardOriginAllowed = allowedOrigins.length === 1 && allowedOrigins[0] === '*';

function isOriginAllowed(origin: string | undefined) {
  if (wildcardOriginAllowed) return true;
  if (!origin) return false;
  return allowedOrigins.includes(origin.trim());
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string) {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

console.log(`[${timestamp()}] CORS configured for origins:`, allowedOrigins);

// Apply CORS middleware to all routes (including error responses)
app.use(cors(corsOptions));

// Global rate limiter: 1000 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000, // Shared Wi-Fi guests can easily exceed the old global cap during active shows
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Skip rate limiting for health checks, media endpoints, and QR code
  skip: (req) => {
    return req.path === '/health' || 
           req.path.startsWith('/media/') || 
           req.path === '/api/qr';
  },
});

// Apply global rate limiter to all routes (after CORS)
app.use(globalLimiter);
app.use(express.json({ limit: '1mb' })); // Limit request body size to prevent DoS

// Log IP addresses for all requests (except frequent/internal endpoints)
app.use((req, _res, next) => {
  // Skip logging for health endpoint
  if (req.path === '/health') {
    return next();
  }
  
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = forwardedFor 
    ? (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(',')[0].trim())
    : req.socket.remoteAddress || 'unknown';
  if (req.method === 'GET' || req.path === '/api/player/timing' || req.path === '/api/break-music/timing' || req.path === '/api/break-music/auto-next') {
    logger.verbose(`[${timestamp()}] Request from IP: ${ip} - ${req.method} ${req.path}`);
  } else {
    logger.info(`[${timestamp()}] Request from IP: ${ip} - ${req.method} ${req.path}`);
  }
  next();
});

// health
app.get('/health', (_req, res) => res.json({ ok: true }));

// routes
app.use('/api', apiRouter);
app.use('/api', rotationRouter);
app.use('/media', mediaRouter);  // ADD THIS LINE - mount media router at /media
app.use(qrRouter);

if (webDistDir) {
  app.use(express.static(webDistDir, { index: false }));
  app.get('/{*path}', async (req, res, next) => {
    if (!shouldServeSpaFallback(req.path)) {
      return next();
    }
    try {
      res.type('html').send(await getSpaHtml(webDistDir));
    } catch (err) {
      next(err);
    }
  });
}

// websockets: broadcast exact message types Player expects
const wss = new WebSocketServer({ noServer: true });

// Keep WebSocket connections alive with ping/pong
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) {
      ws.ping();
    }
  });
}, 30000); // Send ping every 30 seconds

setPostQueueUpdate((type = 'queue.updated', data?: any) => {
  const msg = JSON.stringify({ type, ...(data || {}) });
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
});

function onServerListening() {
  console.log(`API running on http://${bindHost || 'localhost'}:${port}`);
  if (webDistDir) {
    console.log(`Serving web app from ${webDistDir}`);
  }
  void bootstrapAdminPromise.then((bootstrapAdmin) => {
    if (!bootstrapAdmin) return;
    void writeBootstrapCredentialsFile(bootstrapAdmin).catch((error) => {
      console.error('[security] Failed to write bootstrap credentials file:', error);
    });
    setTimeout(() => {
      console.log(
        `[security] No admin password was configured. Generated bootstrap credentials: username="${bootstrapAdmin.username}" password="${bootstrapAdmin.password}". Change this password immediately after first login.`
      );
    }, BOOTSTRAP_PASSWORD_LOG_DELAY_MS);
  });
}

const server = bindHost
  ? app.listen(port, bindHost, onServerListening)
  : app.listen(port, onServerListening);

server.on('upgrade', (req, socket, head) => {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  if (!isOriginAllowed(origin)) {
    rejectUpgrade(socket, 403, 'Forbidden');
    return;
  }

  const requestUrl = new URL(req.url || '/ws', `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname !== '/ws') {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }

  const sessionToken = requestUrl.searchParams.get('sessionToken');
  const proceed = async () => {
    if (sessionToken) {
      const info = await validateSessionInfo(sessionToken);
      if (!info.valid) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      (req as any).user = { userId: info.userId, role: info.role };
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };

  proceed().catch((err) => {
    console.error('WebSocket upgrade failed:', err);
    rejectUpgrade(socket, 500, 'Internal Server Error');
  });
});

const STARTUP_DELAY = 10000; // 10 seconds

// Start the background task after a short delay to allow the server to fully start
// Only starts if background tasks are enabled in settings
setTimeout(async () => {
  try {
    // Load persisted log level
    const savedLogLevel = await getSetting('admin.log_level');
    if (savedLogLevel) {
      setLogLevel(savedLogLevel as LogLevel);
      logger.info(`[startup] Log level set to: ${savedLogLevel}`);
    }

    await syncBackgroundTaskState({ runDurationImmediately: true });
    await syncRemoteGatewayTaskState({ runImmediately: true });
  } catch (err) {
    console.error('Failed to start background task:', err);
  }
}, STARTUP_DELAY);

// keep process alive, log crashes
process.on('unhandledRejection', (r) => console.error('unhandledRejection', r));
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
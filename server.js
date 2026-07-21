const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8183);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123s";
const CANONICAL_RENDER_HOST = "jane-whatsapp.onrender.com";
const DEFAULT_PAYMENT_URL = "https://buy.stripe.com/dRm28t8i1aoU62E3gaasg03";

const DEFAULT_RULES = Object.freeze({
  offerDurationMs: 3 * 60 * 1000,
  lockDurationMs: 3 * 60 * 1000,
  timerEpochMs: Date.UTC(2026, 6, 15, 0, 0, 0),
  openSlots: 13,
  totalSlots: 30,
  manualLock: false,
});

const DEFAULT_SETTINGS = Object.freeze({
  unlockUrl: DEFAULT_PAYMENT_URL,
});

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value, min, max) {
  return Math.round(clampNumber(value, min, max));
}

function normalizeRules(rawRules) {
  if (!rawRules || typeof rawRules !== "object") return null;

  const offerDurationMs = clampNumber(Number(rawRules.offerDurationMs), 30 * 1000, 60 * 60 * 1000);
  const lockDurationMs = clampNumber(Number(rawRules.lockDurationMs), 30 * 1000, 60 * 60 * 1000);
  const totalSlots = clampInteger(Number(rawRules.totalSlots), 1, 999);
  const openSlots = clampInteger(Number(rawRules.openSlots), 1, totalSlots);
  const timerEpochMs = Number(rawRules.timerEpochMs);
  const manualLock = rawRules.manualLock === true;

  if (![offerDurationMs, lockDurationMs, totalSlots, openSlots, timerEpochMs].every(Number.isFinite)) {
    return null;
  }

  return {
    offerDurationMs,
    lockDurationMs,
    timerEpochMs,
    openSlots,
    totalSlots,
    manualLock,
  };
}

function normalizePaymentUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";

  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeSettings(rawSettings, fallbackSettings = DEFAULT_SETTINGS) {
  const source = rawSettings && typeof rawSettings === "object" ? rawSettings : {};
  const unlockUrl = normalizePaymentUrl(source.unlockUrl || fallbackSettings.unlockUrl);

  if (!unlockUrl) return null;

  return {
    unlockUrl,
  };
}

function resolveDataDir() {
  const candidates = [
    process.env.DATA_DIR,
    "/var/data",
    path.join(__dirname, ".data"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return __dirname;
}

const DATA_DIR = resolveDataDir();
const CONFIG_FILE = path.join(DATA_DIR, "timer-config.json");

function readConfigRecord() {
  try {
    const record = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const rules = normalizeRules(record.rules);
    const settings = normalizeSettings(record.settings);
    if (rules && settings) {
      return {
        rules,
        settings,
        updatedAt: record.updatedAt || null,
      };
    }
  } catch {
    // Missing or invalid config falls back to defaults.
  }

  return {
    rules: { ...DEFAULT_RULES },
    settings: { ...DEFAULT_SETTINGS },
    updatedAt: null,
  };
}

function writeConfigRecord(nextRecord) {
  const currentRecord = readConfigRecord();
  const normalizedRules = normalizeRules(nextRecord.rules || currentRecord.rules);
  const normalizedSettings = normalizeSettings(nextRecord.settings || currentRecord.settings);
  if (!normalizedRules || !normalizedSettings) return null;

  const record = {
    rules: normalizedRules,
    settings: normalizedSettings,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(record, null, 2));
  return record;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function applyCors(request, response) {
  const origin = request.headers.origin || "";
  const allowedOrigin =
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:") ||
    origin === `https://${CANONICAL_RENDER_HOST}` ||
    origin.endsWith(".onrender.com")
      ? origin
      : "";

  if (allowedOrigin) {
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    response.setHeader("Vary", "Origin");
  }

  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 32 * 1024) {
        reject(new Error("Body too large"));
        request.destroy();
      }
    });

    request.on("end", () => {
      resolve(body);
    });

    request.on("error", reject);
  });
}

async function handleConfigApi(request, response) {
  applyCors(request, response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET") {
    sendJson(response, 200, readConfigRecord());
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readRequestBody(request));
  } catch {
    sendJson(response, 400, { error: "invalid_json" });
    return;
  }

  if ((payload.password || "").trim() !== ADMIN_PASSWORD) {
    sendJson(response, 401, { error: "invalid_password" });
    return;
  }

  const record = writeConfigRecord({
    rules: payload.rules,
    settings: payload.settings,
  });
  if (!record) {
    sendJson(response, 400, { error: "invalid_config" });
    return;
  }

  sendJson(response, 200, record);
}

function getStaticPath(urlPath) {
  const normalizedUrlPath = decodeURIComponent(urlPath.split("?")[0]);
  const routePath =
    normalizedUrlPath === "/" ||
    normalizedUrlPath === "/admin" ||
    normalizedUrlPath === "/admin/" ||
    normalizedUrlPath === "/admin.html"
      ? "/index.html"
      : normalizedUrlPath;

  const resolved = path.normalize(path.join(__dirname, routePath));
  if (!resolved.startsWith(__dirname)) {
    return path.join(__dirname, "index.html");
  }

  return resolved;
}

function serveStatic(request, response) {
  let filePath = getStaticPath(request.url || "/");

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer((request, response) => {
  const requestPath = (request.url || "/").split("?")[0];

  if (requestPath === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      service: "jane-whatsapp",
    });
    return;
  }

  if (requestPath === "/api/config") {
    handleConfigApi(request, response);
    return;
  }

  serveStatic(request, response);
});

server.listen(PORT, HOST, () => {
  console.log(`Jane WhatsApp Premium server listening on http://${HOST}:${PORT}`);
});

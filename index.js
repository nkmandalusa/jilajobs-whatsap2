import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';
import nodemailer from 'nodemailer';
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5001;

// Global process error handlers to ensure high availability and prevent daemon crashes
process.on('uncaughtException', (err) => {
  console.warn('[Server/Gateway] Handled uncaught exception (prevented crash):', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.warn('[Server/Gateway] Handled unhandled rejection (prevented crash):', reason?.message || reason);
});

app.use(cors());
app.use(express.json());

// Render.com & Uptime Health Check Endpoints
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'JilaJobs WhatsApp Multi-Device & SMTP Gateway',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const SESSIONS_BASE_DIR = path.join(__dirname, 'auth_sessions');
if (!fs.existsSync(SESSIONS_BASE_DIR)) {
  fs.mkdirSync(SESSIONS_BASE_DIR, { recursive: true });
}

// Device configs: Primary (uses existing auth_info_baileys for backward compatibility), Device 2, Device 3
const DEVICE_CONFIGS = [
  { id: 'primary', name: 'Primary WhatsApp (मुख्य नंबर 1)', authFolder: path.join(__dirname, 'auth_info_baileys') },
  { id: 'device_2', name: 'Secondary WhatsApp (बैकअप नंबर 2)', authFolder: path.join(SESSIONS_BASE_DIR, 'device_2') },
  { id: 'device_3', name: 'Tertiary WhatsApp (बैकअप नंबर 3)', authFolder: path.join(SESSIONS_BASE_DIR, 'device_3') },
];

// Device runtime state
const devices = {};
DEVICE_CONFIGS.forEach((cfg) => {
  devices[cfg.id] = {
    id: cfg.id,
    name: cfg.name,
    authFolder: cfg.authFolder,
    status: 'disconnected', // 'disconnected' | 'connecting' | 'connected'
    phone: null,
    pushName: null,
    sock: null,
    currentQrDataUrl: null,
    rawQrString: null,
    reconnectTimer: null,
  };
});

let stats = {
  totalSent: 0,
  sentToday: 0,
  lastSentAt: null,
};

// Auto-Reply Bot Settings
let botSettings = {
  enabled: true,
  delaySeconds: 2, // 2 second natural human delay
  sendReadReceipt: true, // Double blue tick!
  sendTypingPresence: true, // "typing..." indicator
  customGreeting: '',
};

// WhatsApp Role-based Device Assignment
// role => [deviceId, ...] in priority order
let deviceRoleAssignments = {
  candidate_otp:   [],   // Which device(s) handle candidate OTP
  employer_otp:    [],   // Which device(s) handle employer OTP
  job_alert:       [],   // Job alerts
  job_application: [],   // Application alerts
  admin_otp:       [],   // Super admin OTP
  general:         [],   // Default fallback
};

const ROLE_ASSIGNMENTS_FILE = path.join(__dirname, 'role_assignments.json');

function loadRoleAssignments() {
  try {
    if (fs.existsSync(ROLE_ASSIGNMENTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ROLE_ASSIGNMENTS_FILE, 'utf8'));
      if (data && typeof data === 'object') {
        deviceRoleAssignments = { ...deviceRoleAssignments, ...data };
        console.log('[Role Assignments] Loaded from file.');
      }
    }
  } catch (err) {
    console.warn('[Role Assignments] Load error:', err.message);
  }
}

function saveRoleAssignments() {
  try {
    fs.writeFileSync(ROLE_ASSIGNMENTS_FILE, JSON.stringify(deviceRoleAssignments, null, 2), 'utf8');
  } catch (err) {
    console.error('[Role Assignments] Save error:', err.message);
  }
}

loadRoleAssignments();

const BOT_RULES_FILE = path.join(__dirname, 'bot_rules.json');
let botRules = [];

function loadBotRules() {
  try {
    if (fs.existsSync(BOT_RULES_FILE)) {
      const raw = fs.readFileSync(BOT_RULES_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.botSettings) {
        botSettings = { ...botSettings, ...data.botSettings };
      }
      if (Array.isArray(data.rules)) {
        botRules = data.rules;
        console.log(`[Auto-Reply Bot] Loaded ${botRules.length} rules from bot_rules.json`);
        return;
      }
    }
  } catch (err) {
    console.warn('[Auto-Reply Bot] Failed to read bot_rules.json:', err.message);
  }
}

function saveBotRulesToFile() {
  try {
    fs.writeFileSync(BOT_RULES_FILE, JSON.stringify({ botSettings, rules: botRules }, null, 2), 'utf8');
    console.log(`[Auto-Reply Bot] Saved ${botRules.length} rules to bot_rules.json`);
  } catch (err) {
    console.error('[Auto-Reply Bot] Failed to write bot_rules.json:', err.message);
  }
}

loadBotRules();

// Anti-loop throttle for auto-reply bot (per remote jid)
const lastRepliedMap = new Map();

// Memory stores for OTPs
const phoneOtpStore = new Map();
const emailOtpStore = new Map();

const FIREBASE_API_KEY = 'AIzaSyDLXIjY-AdCpdyuBu6iGNXQxrL7oejzPWc';
const FIRESTORE_PROJECT = 'jilajobs';

/**
 * Standardize Indian Phone Number to 10-digits
 */
function normalizePhone(raw) {
  let digits = String(raw || '').trim().replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  return digits;
}

/**
 * Sync WhatsApp Gateway Status to Firestore in Real Time
 */
async function syncGatewayToFirestore(status, phone, name) {
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/system_settings/whatsapp_gateway?key=${FIREBASE_API_KEY}`;
    const cleanPhone = phone ? (phone.startsWith('+') ? phone : `+${phone}`) : '';
    const body = {
      fields: {
        status: { stringValue: status },
        phoneNumber: { stringValue: cleanPhone },
        deviceInfo: { stringValue: `WhatsApp Business (${name || 'JilaJobs Official'})` },
        linkedAt: { stringValue: new Date().toISOString() },
        lastPingAt: { stringValue: new Date().toISOString() },
        antiBan: {
          mapValue: {
            fields: {
              enabled: { booleanValue: true },
              minDelaySeconds: { integerValue: '2' },
              maxDelaySeconds: { integerValue: '5' },
              maxPerHour: { integerValue: '120' },
              spintaxTemplates: { booleanValue: true },
              humanEmulation: { booleanValue: true },
            },
          },
        },
        stats: {
          mapValue: {
            fields: {
              totalSent: { integerValue: String(stats.totalSent) },
              sentToday: { integerValue: String(stats.sentToday) },
              lastOtpSentAt: { stringValue: stats.lastSentAt || '' },
            },
          },
        },
      },
    };
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log(`[WhatsApp Gateway] Synced live status '${status}' (${cleanPhone}) to Firestore.`);
  } catch (err) {
    // ignore
  }
}

// ----------------- MYSQL / PHP API BRIDGE CONFIG & SYNC -----------------
const BRIDGE_CONFIG_FILE = path.join(__dirname, 'bridge_config.json');
let bridgeConfig = {
  localApiUrl: 'http://127.0.0.1/job/api/whatsapp.php',
  onlineApiUrl: process.env.ONLINE_API_URL || 'https://jilajobs.gt.tc/api/whatsapp.php',
  secretToken: 'jilajobs_wa_bridge_secret'
};

function loadBridgeConfig() {
  try {
    if (fs.existsSync(BRIDGE_CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(BRIDGE_CONFIG_FILE, 'utf8'));
      bridgeConfig = { ...bridgeConfig, ...data };
      console.log(`[WhatsApp Bridge] Config loaded. Online URL: ${bridgeConfig.onlineApiUrl || 'None (Local only)'}`);
    }
  } catch (err) {
    console.warn('[WhatsApp Bridge] Config read error:', err.message);
  }
}

function saveBridgeConfigFile() {
  try {
    fs.writeFileSync(BRIDGE_CONFIG_FILE, JSON.stringify(bridgeConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('[WhatsApp Bridge] Config save error:', err.message);
  }
}

loadBridgeConfig();

/**
 * Dynamically resolve public website base URL for links in bot replies
 */
function getPublicSiteBaseUrl() {
  if (process.env.PUBLIC_SITE_URL && process.env.PUBLIC_SITE_URL.startsWith('http')) {
    return process.env.PUBLIC_SITE_URL.replace(/\/+$/, '');
  }
  if (bridgeConfig.onlineApiUrl && bridgeConfig.onlineApiUrl.startsWith('http')) {
    try {
      const u = new URL(bridgeConfig.onlineApiUrl);
      return `${u.protocol}//${u.host}`;
    } catch (e) {}
  }
  return 'https://jilajobs.com';
}

async function syncBridgeConfigFromPhp() {
  const targetUrls = [];
  if (bridgeConfig.localApiUrl) targetUrls.push(bridgeConfig.localApiUrl);
  if (bridgeConfig.onlineApiUrl && bridgeConfig.onlineApiUrl.trim().startsWith('http')) {
    targetUrls.push(bridgeConfig.onlineApiUrl.trim());
  }
  if (targetUrls.length === 0) targetUrls.push('http://127.0.0.1/job/api/whatsapp.php');

  for (const rawUrl of targetUrls) {
    try {
      const endpoint = rawUrl.includes('?') ? `${rawUrl}&action=bridge_config` : `${rawUrl}?action=bridge_config`;
      const res = await fetch(endpoint);
      if (res.ok) {
        const data = await res.json();
        if (data && data.config && data.config.onlineApiUrl) {
          bridgeConfig.onlineApiUrl = data.config.onlineApiUrl.trim();
          saveBridgeConfigFile();
          console.log(`[WhatsApp Bridge] Synced online URL from PHP: ${bridgeConfig.onlineApiUrl}`);
          break;
        }
      }
    } catch (e) {}
  }
}
syncBridgeConfigFromPhp();
setInterval(syncBridgeConfigFromPhp, 60000);

/**
 * Periodically sync WhatsApp bot rules and settings from PHP MySQL (Local & Online)
 */
async function syncBotRulesFromPhp() {
  const targetUrls = [];
  if (bridgeConfig.localApiUrl) targetUrls.push(bridgeConfig.localApiUrl);
  if (bridgeConfig.onlineApiUrl && bridgeConfig.onlineApiUrl.trim().startsWith('http')) {
    targetUrls.push(bridgeConfig.onlineApiUrl.trim());
  }
  if (targetUrls.length === 0) targetUrls.push('http://127.0.0.1/job/api/whatsapp.php');

  for (const rawUrl of targetUrls) {
    try {
      const endpoint = rawUrl.includes('?') ? `${rawUrl}&action=bot_rules` : `${rawUrl}?action=bot_rules`;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(endpoint, { signal: controller.signal });
      clearTimeout(tid);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.rules) && data.rules.length > 0) {
          botRules = data.rules;
          saveBotRulesToFile();
          break;
        }
      }
    } catch (e) {}
  }

  for (const rawUrl of targetUrls) {
    try {
      const endpoint = rawUrl.includes('?') ? `${rawUrl}&action=bot_settings` : `${rawUrl}?action=bot_settings`;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(endpoint, { signal: controller.signal });
      clearTimeout(tid);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.enabled === 'boolean') {
          botSettings = { ...botSettings, ...data };
          saveBotRulesToFile();
          break;
        }
      }
    } catch (e) {}
  }
}
syncBotRulesFromPhp();
setInterval(syncBotRulesFromPhp, 60000);

/**
 * Sync WhatsApp Gateway State & Real QR Codes to Local & Online MySQL PHP API
 */
async function syncToPhpApi() {
  try {
    const activeCount = Object.values(devices).filter((d) => d.status === 'connected').length;
    const deviceList = Object.values(devices).map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      phone: d.phone ? (d.phone.startsWith('+') ? d.phone : `+${d.phone}`) : null,
      pushName: d.pushName,
      hasQr: !!d.currentQrDataUrl,
      qrDataUrl: d.currentQrDataUrl,
      rawQr: d.rawQrString,
    }));

    const payload = {
      connectedCount: activeCount,
      devices: deviceList,
      botSettings,
      stats,
      syncedAt: new Date().toISOString(),
    };

    const targetUrls = [];
    if (bridgeConfig.localApiUrl) {
      targetUrls.push(bridgeConfig.localApiUrl);
    }
    if (bridgeConfig.onlineApiUrl && bridgeConfig.onlineApiUrl.trim().startsWith('http')) {
      targetUrls.push(bridgeConfig.onlineApiUrl.trim());
    }

    for (const rawUrl of targetUrls) {
      const endpoint = rawUrl.includes('?') ? `${rawUrl}&action=sync_devices` : `${rawUrl}?action=sync_devices`;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch (postErr) {
        // failover silently
      }
    }
  } catch (err) {
    // ignore
  }
}

/**
 * Poll PHP API WhatsApp Queue (both local and online) for Pending Outgoing Messages
 */
async function pollPhpApiQueue() {
  const activeDev = Object.values(devices).find((d) => d.status === 'connected' && d.sock);
  if (!activeDev) return;

  const targetUrls = [];
  if (bridgeConfig.localApiUrl) targetUrls.push(bridgeConfig.localApiUrl);
  if (bridgeConfig.onlineApiUrl && bridgeConfig.onlineApiUrl.trim().startsWith('http')) {
    targetUrls.push(bridgeConfig.onlineApiUrl.trim());
  }

  for (const rawUrl of targetUrls) {
    const pollEndpoint = rawUrl.includes('?') ? `${rawUrl}&action=poll_queue` : `${rawUrl}?action=poll_queue`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(pollEndpoint, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) continue;

      const data = await res.json();
      if (!data.messages || !Array.isArray(data.messages) || data.messages.length === 0) continue;

      for (const item of data.messages) {
        if (!item.id || !item.phone || !item.message) continue;
        console.log(`[PHP Queue Dispatch] Sending WhatsApp message to +${item.phone}...`);

        await sendMessageWithFailover(item.phone, item.message);

        // Mark sent
        const markEndpoint = rawUrl.includes('?') ? `${rawUrl}&action=mark_sent` : `${rawUrl}?action=mark_sent`;
        try {
          await fetch(markEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id }),
          });
          console.log(`[PHP Queue Dispatch] Marked message #${item.id} as sent.`);
        } catch (markErr) {}
      }
    } catch (pollErr) {
      // silent
    }
  }
}

/**
 * Poll PHP API WhatsApp Command Queue (Both Local & Online) for Pairing Code & QR Refresh commands
 */
async function pollPhpApiCommands() {
  const targetUrls = [];
  if (bridgeConfig.localApiUrl) targetUrls.push(bridgeConfig.localApiUrl);
  if (bridgeConfig.onlineApiUrl && bridgeConfig.onlineApiUrl.trim().startsWith('http')) {
    targetUrls.push(bridgeConfig.onlineApiUrl.trim());
  }
  if (targetUrls.length === 0) return;

  for (const rawUrl of targetUrls) {
    const pollEndpoint = rawUrl.includes('?') ? `${rawUrl}&action=poll_commands` : `${rawUrl}?action=poll_commands`;
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(pollEndpoint, { signal: controller.signal });
      clearTimeout(tid);
      if (!res.ok) continue;

      const data = await res.json();
      if (!data || !data.commands || !Array.isArray(data.commands) || data.commands.length === 0) continue;

      for (const cmd of data.commands) {
        const cmdId = cmd.id;
        const cmdType = cmd.type;
        const deviceId = cmd.deviceId || 'primary';
        const dev = devices[deviceId];
        console.log(`[Bridge Command] Received command #${cmdId} (${cmdType}) for device ${deviceId}`);

        if (cmdType === 'pairing_code') {
          const rawPhone = cmd.phone || cmd.payload?.phone || '';
          const digits = normalizePhone(rawPhone);
          const fullPhone = digits.length === 10 ? `91${digits}` : digits;

          try {
            if (!dev) throw new Error('Device not found');
            if (dev.status === 'connected') {
              throw new Error(`Device already connected (+${dev.phone})`);
            }

            if (!dev.sock) {
              await startDeviceSocket(deviceId);
              await new Promise((r) => setTimeout(r, 1500));
            }

            let waitLoops = 0;
            while (!dev.sock?.requestPairingCode && waitLoops < 6) {
              await new Promise((r) => setTimeout(r, 500));
              waitLoops++;
            }

            if (dev.sock?.requestPairingCode) {
              const code = await dev.sock.requestPairingCode(fullPhone);
              const formattedCode = (typeof code === 'string' && code.length === 8) 
                ? `${code.slice(0, 4)}-${code.slice(4)}` 
                : code;

              console.log(`[Bridge Command] FULFILLED PAIRING CODE: ${formattedCode} for +${fullPhone}`);

              const submitEndpoint = rawUrl.includes('?') ? `${rawUrl}&action=submit_command_result` : `${rawUrl}?action=submit_command_result`;
              await fetch(submitEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  id: cmdId,
                  success: true,
                  code: formattedCode,
                  rawCode: code,
                  formattedPhone: `+${fullPhone}`
                }),
              });
            } else {
              throw new Error('Socket pairing code method not available');
            }
          } catch (pairErr) {
            console.error(`[Bridge Command] Failed to fulfill pairing code:`, pairErr.message);
            const submitEndpoint = rawUrl.includes('?') ? `${rawUrl}&action=submit_command_result` : `${rawUrl}?action=submit_command_result`;
            await fetch(submitEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: cmdId,
                success: false,
                error: pairErr.message || 'पेयरिंग कोड जनरेट नहीं हो सका।'
              }),
            }).catch(() => {});
          }
        } else if (cmdType === 'refresh_qr') {
          console.log(`[Bridge Command] Executing fresh QR request for ${deviceId}...`);
          if (dev) {
            dev.currentQrDataUrl = null;
            dev.rawQrString = null;
            dev.status = 'connecting';
            if (dev.sock) {
              try {
                dev.sock.ev.removeAllListeners('connection.update');
                dev.sock.ev.removeAllListeners('creds.update');
                dev.sock.end(undefined);
              } catch (e) {}
              dev.sock = null;
            }
            try {
              if (fs.existsSync(dev.authFolder)) {
                fs.rmSync(dev.authFolder, { recursive: true, force: true });
              }
            } catch (e) {}
            setTimeout(async () => {
              await startDeviceSocket(deviceId);
              await syncToPhpApi();
            }, 600);
          }

          // Mark command completed
          const submitEndpoint = rawUrl.includes('?') ? `${rawUrl}&action=submit_command_result` : `${rawUrl}?action=submit_command_result`;
          await fetch(submitEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: cmdId, success: true }),
          }).catch(() => {});
        } else if (cmdType === 'disconnect') {
          await disconnectDevice(deviceId);
          const submitEndpoint = rawUrl.includes('?') ? `${rawUrl}&action=submit_command_result` : `${rawUrl}?action=submit_command_result`;
          await fetch(submitEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: cmdId, success: true }),
          }).catch(() => {});
        }
      }
    } catch (pollErr) {
      // silent
    }
  }
}

/**
 * Build Natural Human-like Auto Reply Message
 * Trained with complete JilaJobs Knowledge Base (Candidate & Employer Q&A)
 * Prioritizes Jharkhand & All India district jobs, plans, registration, and safety
 */
function buildSmartBotReply(incomingText, senderName, connectedPhone) {
  const lower = (incomingText || '').toLowerCase().trim();
  const phoneFormatted = connectedPhone || '919288242463';
  const nameFormatted = senderName || 'जी';
  const baseUrl = getPublicSiteBaseUrl();

  // Check custom or system rules dynamically from botRules
  if (Array.isArray(botRules) && botRules.length > 0) {
    for (const rule of botRules) {
      if (rule.enabled === false) continue;
      if (Array.isArray(rule.keywords)) {
        const matches = rule.keywords.some(kw => {
          if (!kw) return false;
          const cleanKw = String(kw).toLowerCase().trim();
          return cleanKw && lower.includes(cleanKw);
        });
        if (matches) {
          let reply = rule.replyText || '';
          reply = reply.replace(/\{name\}/g, nameFormatted);
          reply = reply.replace(/\{phone\}/g, phoneFormatted);
          reply = reply.replace(/\{baseUrl\}/g, baseUrl);
          reply = reply.replace(/http:\/\/localhost\/job/g, baseUrl);
          return reply;
        }
      }
    }
  }

  // If custom greeting configured and message is a generic hello
  if (botSettings.customGreeting && (lower === 'hi' || lower === 'hello' || lower === 'namaste' || lower === 'hey' || lower === 'hlo')) {
    return botSettings.customGreeting
      .replace(/\{name\}/g, nameFormatted)
      .replace(/\{phone\}/g, phoneFormatted)
      .replace(/\{baseUrl\}/g, baseUrl)
      .replace(/http:\/\/localhost\/job/g, baseUrl);
  }

  // Fallback natural friendly greeting & guide (prioritizing Jharkhand & All-India district jobs)
  return `नमस्ते *${nameFormatted}*! 🙏

*जिला जॉब्स (JilaJobs)* आधिकारिक सहायता केंद्र में आपका स्वागत है।
(झारखण्ड एवं भारत के सभी जिलों में 100% नि:शुल्क एवं सत्यापित नौकरियां)

हम आपकी क्या सहायता कर सकते हैं?
1️⃣ *नई नौकरियां खोजने व आवेदन करने के लिए:* ${baseUrl}/jobs
2️⃣ *झारखण्ड जिलेवार नौकरियां (राँची, धनबाद, जमशेदपुर आदि):* ${baseUrl}/jobs
3️⃣ *स्टाफ भर्ती / नई रिक्ति पोस्ट करने के लिए:* ${baseUrl}/employer/jobs/create
4️⃣ *नया उम्मीदवार पंजीकरण:* ${baseUrl}/register/seeker
5️⃣ *नियोक्ता प्लान एवं पैकेज:* ${baseUrl}/employer/plans

यदि आपका कोई विशेष सवाल है या किसी जिले की नौकरी चाहिए, तो कृपया यहाँ विस्तार से लिखें।

धन्यवाद,
*जिला जॉब्स डिजिटल सहायक*`;
}

/**
 * Test Bot Rule Matcher for Simulator
 */
function testBotRuleMatch(incomingText, senderName) {
  const lower = (incomingText || '').toLowerCase().trim();
  const nameFormatted = senderName || 'परीक्षण उपयोगकर्ता';
  const baseUrl = getPublicSiteBaseUrl();

  if (Array.isArray(botRules)) {
    for (const rule of botRules) {
      if (rule.enabled === false) continue;
      if (Array.isArray(rule.keywords)) {
        const matchedKw = rule.keywords.find(kw => {
          if (!kw) return false;
          const cleanKw = String(kw).toLowerCase().trim();
          return cleanKw && lower.includes(cleanKw);
        });
        if (matchedKw) {
          let reply = rule.replyText || '';
          reply = reply.replace(/\{name\}/g, nameFormatted);
          reply = reply.replace(/\{phone\}/g, '919288242463');
          reply = reply.replace(/\{baseUrl\}/g, baseUrl);
          reply = reply.replace(/http:\/\/localhost\/job/g, baseUrl);
          return {
            matched: true,
            ruleId: rule.id,
            ruleTitle: rule.title,
            matchedKeyword: matchedKw,
            replyText: reply
          };
        }
      }
    }
  }

  return {
    matched: false,
    ruleId: null,
    ruleTitle: 'डिफ़ॉल्ट मेन्यू (Default Fallback)',
    matchedKeyword: null,
    replyText: buildSmartBotReply(incomingText, senderName, '919288242463')
  };
}

/**
 * Attach Message Handler for Auto-Reply Bot with Human Delay, Blue Tick & Robust Message Extraction
 */
function setupAutoReplyBot(dev) {
  if (!dev.sock) return;

  dev.sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Process both notify and append types so no incoming chat is missed
    if (!botSettings.enabled) return;
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      try {
        // Skip outgoing messages
        if (!msg.message || msg.key.fromMe) continue;

        const fromJid = msg.key.remoteJid;
        // Skip groups, status broadcasts, and newsletters
        if (!fromJid || fromJid.endsWith('@g.us') || fromJid.endsWith('@newsletter') || fromJid === 'status@broadcast') continue;

        // Unpack nested message containers (ephemeral, viewOnce, documentWithCaption, interactive)
        const realMsg = msg.message?.ephemeralMessage?.message ||
                        msg.message?.viewOnceMessage?.message ||
                        msg.message?.viewOnceMessageV2?.message ||
                        msg.message?.documentWithCaptionMessage?.message ||
                        msg.message;

        const incomingText = (
          realMsg?.conversation ||
          realMsg?.extendedTextMessage?.text ||
          realMsg?.imageMessage?.caption ||
          realMsg?.videoMessage?.caption ||
          realMsg?.buttonsResponseMessage?.selectedButtonId ||
          realMsg?.buttonsResponseMessage?.selectedDisplayText ||
          realMsg?.templateButtonReplyMessage?.selectedId ||
          realMsg?.listResponseMessage?.singleSelectReply?.selectedRowId ||
          realMsg?.listResponseMessage?.title ||
          ''
        ).trim();

        // If no text received at all, skip
        if (!incomingText) continue;

        console.log(`[Auto-Reply Bot - ${dev.id}] Received message from ${fromJid}: "${incomingText}"`);

        // 1. Send Read Receipt -> DOUBLE BLUE TICK (✔️✔️) on user's phone!
        if (botSettings.sendReadReceipt) {
          try {
            await dev.sock.readMessages([msg.key]);
            console.log(`[Auto-Reply Bot - ${dev.id}] Sent Read Receipt (Double Blue Tick) to ${fromJid}`);
          } catch (readErr) {
            console.warn(`[Auto-Reply Bot - ${dev.id}] Read receipt error:`, readErr.message);
          }
        }

        // Anti-spam throttle: prevent rapid-fire loop from same sender within 4 seconds (not 60s)
        const lastReplied = lastRepliedMap.get(fromJid) || 0;
        const now = Date.now();
        if (now - lastReplied < 4000) {
          console.log(`[Auto-Reply Bot - ${dev.id}] Throttled message from ${fromJid} (within 4s)`);
          continue;
        }

        // 2. NATURAL HUMAN DELAY (Default 1-2 SECONDS): Pause before responding
        const delayMs = Math.max(500, (botSettings.delaySeconds || 2) * 1000);
        await new Promise((r) => setTimeout(r, delayMs));

        // 3. Show "typing..." presence update to simulate a real human typing
        if (botSettings.sendTypingPresence) {
          try {
            await dev.sock.sendPresenceUpdate('composing', fromJid);
          } catch (e) {}
          await new Promise((r) => setTimeout(r, 1200));
        }

        // 4. Send smart reply from the EXACT SAME connected WhatsApp number!
        const senderName = msg.pushName || 'जी';
        const replyText = buildSmartBotReply(incomingText, senderName, dev.phone);

        // Send with quoted reference for reliable routing on both standard and LID JIDs
        await dev.sock.sendMessage(fromJid, { text: replyText }, { quoted: msg });
        lastRepliedMap.set(fromJid, Date.now());
        console.log(`[Auto-Reply Bot - ${dev.id}] Sent human auto-reply to ${fromJid}`);

        try {
          await dev.sock.sendPresenceUpdate('available', fromJid);
        } catch (e) {}
      } catch (err) {
        console.warn(`[Auto-Reply Bot - ${dev.id}] Error handling incoming message:`, err.message);
      }
    }
  });
}

/**
 * Initialize a specific Baileys device socket with long-lived persistence
 */
async function startDeviceSocket(deviceId) {
  const dev = devices[deviceId];
  if (!dev) return;

  // Prevent duplicate concurrent initialization
  if (dev.isStarting) {
    console.log(`[WhatsApp Gateway - ${deviceId}] Socket startup already in progress, waiting...`);
    return;
  }
  dev.isStarting = true;

  clearTimeout(dev.reconnectTimer);
  if (dev.keepAliveTimer) {
    clearInterval(dev.keepAliveTimer);
    dev.keepAliveTimer = null;
  }

  // Gracefully terminate existing socket if any before creating a new one
  if (dev.sock) {
    try {
      dev.sock.ev.removeAllListeners('connection.update');
      dev.sock.ev.removeAllListeners('creds.update');
      dev.sock.ev.removeAllListeners('messages.upsert');
      dev.sock.end(undefined);
    } catch (e) {}
    dev.sock = null;
  }

  // Brief pause for Windows file handles to release
  await new Promise((r) => setTimeout(r, 400));

  if (!fs.existsSync(dev.authFolder)) {
    fs.mkdirSync(dev.authFolder, { recursive: true });
  }

  try {
    dev.status = 'connecting';
    const { state, saveCreds } = await useMultiFileAuthState(dev.authFolder);
    let version = [2, 3000, 1015901307];
    try {
      const v = await fetchLatestBaileysVersion();
      if (v?.version) version = v.version;
    } catch (vErr) {
      console.warn(`[WhatsApp Gateway - ${deviceId}] Version fetch fallback:`, version);
    }

    // Windows Chrome identity prevents WhatsApp's automated Linux/headless bot timeouts
    dev.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Windows', 'Chrome', '128.0.6613.120'],
      syncFullHistory: false,
      connectTimeoutMs: 90000,
      defaultQueryTimeoutMs: 90000,
      keepAliveIntervalMs: 20000,
      emitOwnEvents: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,   // Set false to avoid server-side presence conflicts on Linux hosting
      retryRequestDelayMs: 350,
      maxMsgRetryCount: 5,
      getMessage: async () => undefined,
    });

    dev.sock.ev.on('creds.update', saveCreds);

    // Setup Auto-Reply Bot for this device
    setupAutoReplyBot(dev);

    dev.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        dev.rawQrString = qr;
        try {
          dev.currentQrDataUrl = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 320,
            color: { dark: '#0f172a', light: '#ffffff' },
          });
          dev.status = 'disconnected';
          console.log(`[WhatsApp Gateway - ${dev.id}] NEW REAL QR CODE GENERATED!`);
          if (dev.id === 'primary') {
            syncGatewayToFirestore('disconnected', null, null);
          }
          syncToPhpApi();
        } catch (err) {
          console.error(`[WhatsApp Gateway - ${dev.id}] QR error:`, err);
        }
      }

      if (connection === 'open') {
        dev.isStarting = false;
        dev.status = 'connected';
        dev.currentQrDataUrl = null;
        dev.rawQrString = null;
        const userJid = dev.sock.user?.id || '';
        dev.phone = userJid.split(':')[0] || userJid.split('@')[0] || 'Linked Device';
        dev.pushName = dev.sock.user?.name || 'JilaJobs Admin';
        console.log(`[WhatsApp Gateway - ${dev.id}] PERMANENTLY CONNECTED! Device: +${dev.phone} (${dev.pushName})`);

        // Proactive presence keepalive heartbeat every 30 seconds
        // Ensures WhatsApp servers never mark session as idle or inactive!
        if (dev.keepAliveTimer) clearInterval(dev.keepAliveTimer);
        dev.keepAliveTimer = setInterval(async () => {
          try {
            if (dev.sock && dev.status === 'connected') {
              await dev.sock.sendPresenceUpdate('available');
            }
          } catch (e) {
            // If keepalive fails, the connection.update event will handle reconnect
            console.warn(`[WhatsApp KeepAlive - ${dev.id}] Presence update failed:`, e?.message || e);
          }
        }, 25000); // Every 25 seconds to stay well within WhatsApp's idle timeout

        if (dev.id === 'primary') {
          syncGatewayToFirestore('connected', dev.phone, dev.pushName);
        }
        syncToPhpApi();
      }

      if (connection === 'close') {
        dev.isStarting = false;
        if (dev.keepAliveTimer) {
          clearInterval(dev.keepAliveTimer);
          dev.keepAliveTimer = null;
        }

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        console.log(`[WhatsApp Gateway - ${dev.id}] Connection closed. StatusCode: ${statusCode}, IsLoggedOut: ${isLoggedOut}`);

        const savedCredsExist = hasSavedCreds(dev.authFolder);

        // DO NOT delete authFolder automatically! Keeping saved credentials preserves the login permanently.
        // The authFolder will ONLY be deleted when the admin explicitly clicks "Disconnect" in the Admin UI.
        if (isLoggedOut && !savedCredsExist) {
          dev.status = 'disconnected';
          dev.phone = null;
          dev.pushName = null;
          if (dev.id === 'primary') {
            syncGatewayToFirestore('disconnected', null, null);
          }
          syncToPhpApi();
        } else {
          // Keep state connecting while auto-reconnecting with saved credentials
          dev.status = 'connecting';
          syncToPhpApi();
        }

        clearTimeout(dev.reconnectTimer);

        // Auto-reconnect with existing saved credentials so the session never expires
        // On online servers (Render, Railway, etc.): use shorter reconnect delay to stay alive
        const isOnlineServer = !!process.env.PORT && process.env.PORT !== '5001';
        if (savedCredsExist || dev.id === 'primary') {
          const baseDelay = statusCode === 515 || statusCode === 428 ? 2000 : 4000;
          const delay = isOnlineServer ? Math.min(baseDelay, 3000) : baseDelay;
          console.log(`[WhatsApp Gateway - ${dev.id}] Persistent auto-reconnect in ${delay}ms (online: ${isOnlineServer})...`);
          dev.reconnectTimer = setTimeout(() => {
            startDeviceSocket(dev.id);
          }, delay);
        } else {
          console.log(`[WhatsApp Gateway - ${dev.id}] No credentials. Waiting for QR scan.`);
        }
      }
    });
  } catch (err) {
    dev.isStarting = false;
    console.error(`[WhatsApp Gateway - ${dev.id}] Init error:`, err);
    clearTimeout(dev.reconnectTimer);
    if (dev.id === 'primary' || hasSavedCreds(dev.authFolder)) {
      dev.reconnectTimer = setTimeout(() => startDeviceSocket(dev.id), 5000);
    }
  }
}

function hasSavedCreds(folder) {
  try {
    return fs.existsSync(path.join(folder, 'creds.json'));
  } catch (e) {
    return false;
  }
}

// Boot Primary device immediately
startDeviceSocket('primary');

// Boot secondary devices ONLY if previously paired to avoid 401 reconnect loops
if (hasSavedCreds(devices['device_2'].authFolder)) {
  setTimeout(() => startDeviceSocket('device_2'), 1500);
}
if (hasSavedCreds(devices['device_3'].authFolder)) {
  setTimeout(() => startDeviceSocket('device_3'), 3000);
}

/**
 * Disconnect and Truly Logout a WhatsApp Device
 */
async function disconnectDevice(deviceId = 'primary') {
  const dev = devices[deviceId];
  if (!dev) return false;

  console.log(`[WhatsApp Gateway] Disconnecting and Logging Out Device: ${deviceId}...`);

  clearTimeout(dev.reconnectTimer);
  if (dev.keepAliveTimer) {
    clearInterval(dev.keepAliveTimer);
    dev.keepAliveTimer = null;
  }

  if (dev.sock) {
    try {
      dev.sock.ev.removeAllListeners('connection.update');
      dev.sock.ev.removeAllListeners('creds.update');
      dev.sock.ev.removeAllListeners('messages.upsert');
      await dev.sock.logout().catch(() => {});
      dev.sock.end(undefined);
    } catch (e) {}
    dev.sock = null;
  }

  dev.status = 'disconnected';
  dev.phone = null;
  dev.pushName = null;
  dev.currentQrDataUrl = null;
  dev.rawQrString = null;

  // Wait 700ms for Windows file handles to release
  await new Promise((r) => setTimeout(r, 700));

  try {
    if (fs.existsSync(dev.authFolder)) {
      fs.rmSync(dev.authFolder, { recursive: true, force: true });
    }
  } catch (rmErr) {
    console.warn(`[WhatsApp Gateway] Cleaned auth folder for ${deviceId}:`, rmErr.message);
  }

  if (deviceId === 'primary') {
    syncGatewayToFirestore('disconnected', null, null);
    // Restart clean socket for primary to generate a fresh QR code
    setTimeout(() => {
      startDeviceSocket('primary');
    }, 1000);
  }

  await syncToPhpApi();
  return true;
}

/**
 * Multi-Device Failover Message Dispatch Engine
 * If Device 1 fails or is offline, automatically failover to Device 2, then Device 3!
 */
async function sendMessageWithFailover(phone, messageText, roleHint = null) {
  const digits = normalizePhone(phone);
  const jid = `91${digits}@s.whatsapp.net`;

  const directUrl = `https://wa.me/91${digits}?text=${encodeURIComponent(messageText)}`;

  // Build ordered device list: role-assigned devices first, then all connected
  let orderedDevices = [];

  if (roleHint && deviceRoleAssignments[roleHint] && Array.isArray(deviceRoleAssignments[roleHint])) {
    for (const deviceId of deviceRoleAssignments[roleHint]) {
      const dev = devices[deviceId];
      if (dev && dev.status === 'connected' && dev.sock) {
        orderedDevices.push(dev);
      }
    }
  }

  // Add remaining connected devices as fallback
  const allConnected = Object.values(devices).filter((d) => d.status === 'connected' && d.sock);
  for (const dev of allConnected) {
    if (!orderedDevices.find((d) => d.id === dev.id)) {
      orderedDevices.push(dev);
    }
  }

  if (orderedDevices.length === 0) {
    return {
      success: false,
      isRealSent: false,
      message: 'No WhatsApp device is connected. Direct URL prepared.',
      directUrl,
    };
  }

  let lastError = null;
  for (let i = 0; i < orderedDevices.length; i++) {
    const dev = orderedDevices[i];
    try {
      console.log(`[WhatsApp Dispatch] Attempting send via ${dev.name} (+${dev.phone})${roleHint ? ` [role: ${roleHint}]` : ''}...`);
      await dev.sock.sendMessage(jid, { text: messageText });
      stats.totalSent += 1;
      stats.sentToday += 1;
      stats.lastSentAt = new Date().toISOString();

      return {
        success: true,
        isRealSent: true,
        sentViaDevice: dev.id,
        devicePhone: dev.phone,
        message: `Message sent via WhatsApp (+${dev.phone}).`,
        directUrl,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[WhatsApp Failover] Device ${dev.id} (+${dev.phone}) failed: ${err.message}. Failing over to next device...`);
    }
  }

  return {
    success: false,
    isRealSent: false,
    message: `All connected WhatsApp devices failed: ${lastError?.message || 'Network error'}. Message prepared for manual send.`,
    directUrl,
  };
}

/**
 * Poll Firestore whatsapp_outbox Queue for requests triggered from online server (https://jilajobs.web.app)
 */
async function processWhatsAppOutboxQueue() {
  const activeDev = Object.values(devices).find((d) => d.status === 'connected' && d.sock);
  if (!activeDev) return;

  try {
    const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/whatsapp_outbox?key=${FIREBASE_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return;

    const data = await res.json();
    if (!data.documents || !data.documents.length) return;

    for (const doc of data.documents) {
      const docPath = doc.name;
      const fields = doc.fields;
      if (!fields) continue;

      const docStatus = fields.status?.stringValue;
      if (docStatus !== 'pending') continue;

      const rawPhone = fields.phone?.stringValue || '';
      const digits = normalizePhone(rawPhone);
      const otp = fields.otp?.stringValue;
      const name = fields.name?.stringValue || 'User';
      const userType = fields.userType?.stringValue || 'seeker';

      if (!digits || !otp) continue;

      console.log(`[Outbox Cloud Queue] Dispatching WhatsApp message to +91 ${digits}...`);

      const greetings = [`नमस्ते ${name} जी,`, `Hello ${name},`, `सादर प्रणाम ${name} जी,`];
      const chosenGreeting = greetings[Math.floor(Math.random() * greetings.length)];
      const intros = userType === 'seeker'
        ? 'ज़िलाजॉब्स (JilaJobs) स्थानीय रोज़गार पोर्टल पर आपका सत्यापन कोड है:'
        : 'ज़िलाजॉब्स (JilaJobs) कंपनी पोर्टल पर आपका आधिकारिक सत्यापन कोड है:';
      const refId = Math.random().toString(36).substring(2, 7).toUpperCase();
      const timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const messageText = `${chosenGreeting}\n\n${intros}\n\n👉 *${otp}*\n\n(कृपया यह 6-अंकीय कोड वेबसाइट पर दर्ज करें)\n\n⚠️ सुरक्षा सूचना: यह कोड केवल 10 मिनट के लिए मान्य है। किसी भी अनजान व्यक्ति के साथ इसे साझा न करें। JilaJobs आपसे कभी भी पैसे नहीं माँगता।\n\n━━━━━━━━━━━━━━━━━━━━\n📌 Ref ID: #JJ-${refId} • Time: ${timeStr} IST\n🌐 JilaJobs - Apne District Me Pao Verified Jobs`;

      await sendMessageWithFailover(digits, messageText);

      // Store in daemon memory too
      const expiresAt = Date.now() + 10 * 60 * 1000;
      phoneOtpStore.set(digits, { otp, expiresAt, name });
      phoneOtpStore.set(`91${digits}`, { otp, expiresAt, name });

      // Mark outbox document as sent in Firestore
      const updateUrl = `https://firestore.googleapis.com/v1/${docPath}?updateMask.fieldPaths=status&updateMask.fieldPaths=sentAt&key=${FIREBASE_API_KEY}`;
      await fetch(updateUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            ...fields,
            status: { stringValue: 'sent' },
            sentAt: { stringValue: new Date().toISOString() },
          },
        }),
      });

      console.log(`[Outbox Cloud Queue] Delivered WhatsApp OTP to +91 ${digits}`);
    }
  } catch (err) {
    // silent
  }
}

// Poll cloud outbox every 15 seconds (optimized for low bandwidth)
setInterval(processWhatsAppOutboxQueue, 15000);

// Heartbeat sync to MySQL PHP API every 30 seconds
setInterval(syncToPhpApi, 30000);

// Poll MySQL PHP API Queue (Local & Online) every 10 seconds for immediate message dispatch
setInterval(pollPhpApiQueue, 10000);

// Poll MySQL PHP API Commands (Local & Online) every 15 seconds for pairing code & QR refresh
setInterval(pollPhpApiCommands, 15000);

// Heartbeat sync to Firestore every 30 seconds
setInterval(() => {
  const primary = devices['primary'];
  if (primary && primary.status === 'connected' && primary.phone) {
    syncGatewayToFirestore('connected', primary.phone, primary.pushName);
  }
}, 30000);

// ----------------- WHATSAPP API ROUTES -----------------

/**
 * API: Get Bridge Configuration
 */
app.get('/api/whatsapp/bridge-config', (req, res) => {
  res.json({ success: true, bridgeConfig });
});

/**
 * API: Set Online Bridge URL & Credentials
 */
app.post('/api/whatsapp/set-online-bridge', (req, res) => {
  const { onlineApiUrl, localApiUrl, secretToken } = req.body || {};
  if (typeof onlineApiUrl === 'string') {
    bridgeConfig.onlineApiUrl = onlineApiUrl.trim();
  }
  if (typeof localApiUrl === 'string') {
    bridgeConfig.localApiUrl = localApiUrl.trim();
  }
  if (typeof secretToken === 'string') {
    bridgeConfig.secretToken = secretToken.trim();
  }
  saveBridgeConfigFile();
  syncToPhpApi();
  console.log(`[WhatsApp Bridge] Bridge configuration updated: onlineApiUrl=${bridgeConfig.onlineApiUrl}`);
  res.json({ success: true, message: 'Bridge configuration updated successfully', bridgeConfig });
});

/**
 * API: Get Gateway Status & Primary QR (Backward compatible)
 */
app.get('/api/whatsapp/status', (req, res) => {
  const primary = devices['primary'];
  const connectedCount = Object.values(devices).filter((d) => d.status === 'connected').length;

  res.json({
    status: primary.status,
    qrDataUrl: primary.currentQrDataUrl,
    rawQr: primary.rawQrString,
    phone: primary.phone ? `+${primary.phone}` : null,
    name: primary.pushName,
    stats,
    multiDevice: {
      totalConfigured: Object.keys(devices).length,
      totalConnected: connectedCount,
      failoverActive: connectedCount > 1,
    },
    botSettings,
  });
});

/**
 * API: Get All Configured WhatsApp Devices
 */
app.get('/api/whatsapp/devices', (req, res) => {
  const list = Object.values(devices).map((d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    phone: d.phone ? `+${d.phone}` : null,
    pushName: d.pushName,
    hasQr: !!d.currentQrDataUrl,
    qrDataUrl: d.currentQrDataUrl,
    rawQr: d.rawQrString,
  }));

  res.json({
    devices: list,
    connectedCount: list.filter((d) => d.status === 'connected').length,
    botSettings,
    roleAssignments: deviceRoleAssignments,
  });
});

/**
 * API: Get WhatsApp Role Assignments
 */
app.get('/api/whatsapp/role-assignments', (req, res) => {
  res.json({ success: true, assignments: deviceRoleAssignments });
});

/**
 * API: Save WhatsApp Role Assignments
 */
app.post('/api/whatsapp/role-assignments', (req, res) => {
  const newAssignments = req.body?.assignments || req.body || {};
  if (typeof newAssignments === 'object') {
    deviceRoleAssignments = { ...deviceRoleAssignments, ...newAssignments };
    saveRoleAssignments();
    // Also sync to PHP API
    syncToPhpApi();
    res.json({ success: true, assignments: deviceRoleAssignments, message: 'Role assignments saved.' });
  } else {
    res.status(400).json({ success: false, message: 'Invalid assignments data.' });
  }
});

/**
 * API: Request 8-Digit Pairing Code for a Device (Official WhatsApp Phone Pairing)
 */
app.post('/api/whatsapp/pairing-code', async (req, res) => {
  const deviceId = req.body?.deviceId || 'primary';
  const rawPhone = req.body?.phone || req.body?.phoneNumber || '';
  const digits = normalizePhone(rawPhone);

  if (!digits || digits.length < 10) {
    return res.status(400).json({
      success: false,
      message: 'कृपया 10-अंकीय वैध भारतीय मोबाइल नंबर दर्ज करें (उदा. 9288242463)',
    });
  }

  const dev = devices[deviceId];
  if (!dev) {
    return res.status(404).json({ success: false, message: 'डिवाइस नहीं मिला।' });
  }

  if (dev.status === 'connected') {
    return res.json({
      success: false,
      message: `यह डिवाइस पहले से कनेक्टेड है (+${dev.phone})। नया नंबर जोड़ने के लिए पहले डिस्कनेक्ट करें।`
    });
  }

  try {
    if (!dev.sock) {
      await startDeviceSocket(deviceId);
      await new Promise((r) => setTimeout(r, 1500));
    }

    let waitLoops = 0;
    while (!dev.sock?.requestPairingCode && waitLoops < 6) {
      await new Promise((r) => setTimeout(r, 500));
      waitLoops++;
    }

    const fullPhone = digits.length === 10 ? `91${digits}` : digits;
    console.log(`[WhatsApp Gateway - ${deviceId}] Requesting pairing code for +${fullPhone}...`);

    if (dev.sock?.requestPairingCode) {
      const code = await dev.sock.requestPairingCode(fullPhone);
      console.log(`[WhatsApp Gateway - ${deviceId}] Pairing Code generated: ${code}`);

      const formattedCode = (typeof code === 'string' && code.length === 8) 
        ? `${code.slice(0, 4)}-${code.slice(4)}` 
        : code;

      return res.json({
        success: true,
        code: formattedCode,
        rawCode: code,
        formattedPhone: `+${fullPhone}`,
        message: '8-अंकों का पेयरिंग कोड सफलतापूर्वक जनरेट हो गया!',
      });
    } else {
      return res.status(500).json({ success: false, message: 'Pairing code method not available on socket' });
    }
  } catch (err) {
    console.error(`[WhatsApp Gateway - ${deviceId}] Pairing code error:`, err?.message || err);
    return res.status(500).json({
      success: false,
      message: `पेयरिंग कोड जनरेट नहीं हो सका: ${err?.message || 'कृपया थोड़ी देर बाद पुनः प्रयास करें या QR स्कैन करें।'}`
    });
  }
});

/**
 * API: Force Refresh / Restart QR Code for a Device
 */
app.post('/api/whatsapp/refresh-qr', async (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {}
  }
  const deviceId = body?.deviceId || req.query?.deviceId || 'primary';
  const dev = devices[deviceId];
  if (!dev) {
    return res.status(404).json({ success: false, message: 'डिवाइस नहीं मिला।' });
  }

  console.log(`[WhatsApp Gateway - ${deviceId}] Admin requested fresh QR code.`);
  dev.currentQrDataUrl = null;
  dev.rawQrString = null;
  dev.status = 'connecting';

  if (dev.sock) {
    try {
      dev.sock.ev.removeAllListeners('connection.update');
      dev.sock.ev.removeAllListeners('creds.update');
      dev.sock.end(undefined);
    } catch (e) {}
    dev.sock = null;
  }

  // Clear auth cache if not connected
  try {
    if (fs.existsSync(dev.authFolder)) {
      fs.rmSync(dev.authFolder, { recursive: true, force: true });
    }
  } catch (e) {}

  setTimeout(async () => {
    await startDeviceSocket(deviceId);
  }, 600);

  res.json({ success: true, message: 'नया QR कोड जनरेट किया जा रहा है...' });
});

/**
 * API: Disconnect & Logout Specific WhatsApp Device (or Primary)
 */
app.post('/api/whatsapp/disconnect', async (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {}
  }
  const deviceId = body?.deviceId || req.query?.deviceId;
  if (!deviceId) {
    return res.status(400).json({
      success: false,
      message: 'deviceId is required to disconnect a device (e.g. "primary", "device_2", "device_3").',
    });
  }
  if (!devices[deviceId]) {
    return res.status(404).json({
      success: false,
      message: `Device "${deviceId}" not recognized.`,
    });
  }

  try {
    await disconnectDevice(deviceId);
    res.json({ success: true, message: `Device ${deviceId} logged out and disconnected cleanly.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * API: Auto-Reply Bot Settings (Get & Update)
 */
app.get('/api/whatsapp/bot-settings', (req, res) => {
  res.json(botSettings);
});

app.post('/api/whatsapp/bot-settings', (req, res) => {
  const { enabled, delaySeconds, sendReadReceipt, sendTypingPresence, customGreeting } = req.body;
  if (typeof enabled === 'boolean') botSettings.enabled = enabled;
  if (typeof delaySeconds === 'number') botSettings.delaySeconds = Math.max(1, Math.min(10, delaySeconds));
  if (typeof sendReadReceipt === 'boolean') botSettings.sendReadReceipt = sendReadReceipt;
  if (typeof sendTypingPresence === 'boolean') botSettings.sendTypingPresence = sendTypingPresence;
  if (typeof customGreeting === 'string') botSettings.customGreeting = customGreeting;

  saveBotRulesToFile();
  res.json({ success: true, botSettings });
});

/**
 * API: WhatsApp Bot Rules (Get, Add, Edit, Toggle, Delete)
 */
app.get('/api/whatsapp/bot-rules', (req, res) => {
  res.json({
    success: true,
    botSettings,
    rules: botRules,
    totalRules: botRules.length,
    activeRules: botRules.filter(r => r.enabled !== false).length,
  });
});

app.post('/api/whatsapp/bot-rules', (req, res) => {
  try {
    const { action, rule, ruleId, enabled } = req.body;

    if (action === 'toggle_rule') {
      const target = botRules.find(r => r.id === ruleId);
      if (!target) {
        return res.status(404).json({ success: false, message: 'Rule not found' });
      }
      target.enabled = typeof enabled === 'boolean' ? enabled : !target.enabled;
      saveBotRulesToFile();
      return res.json({ success: true, message: 'Rule status updated', rules: botRules });
    }

    if (action === 'delete_rule') {
      const idx = botRules.findIndex(r => r.id === ruleId);
      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Rule not found' });
      }
      botRules.splice(idx, 1);
      saveBotRulesToFile();
      return res.json({ success: true, message: 'Rule deleted successfully', rules: botRules });
    }

    if (action === 'add_rule') {
      if (!rule || !rule.title || !rule.replyText) {
        return res.status(400).json({ success: false, message: 'Rule title and replyText are required' });
      }
      const newRule = {
        id: rule.id || `rule_custom_${Date.now()}`,
        title: rule.title.trim(),
        category: rule.category || 'general',
        keywords: Array.isArray(rule.keywords)
          ? rule.keywords.map(k => String(k).trim()).filter(Boolean)
          : (typeof rule.keywords === 'string' ? rule.keywords.split(',').map(k => k.trim()).filter(Boolean) : []),
        replyText: rule.replyText.trim(),
        enabled: rule.enabled !== false,
        isSystem: false,
      };
      botRules.push(newRule);
      saveBotRulesToFile();
      return res.json({ success: true, message: 'Rule added successfully', rule: newRule, rules: botRules });
    }

    if (action === 'edit_rule') {
      if (!rule || !rule.id) {
        return res.status(400).json({ success: false, message: 'Rule ID is required for editing' });
      }
      const existing = botRules.find(r => r.id === rule.id);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Rule not found' });
      }
      if (rule.title) existing.title = rule.title.trim();
      if (rule.category) existing.category = rule.category;
      if (rule.keywords !== undefined) {
        existing.keywords = Array.isArray(rule.keywords)
          ? rule.keywords.map(k => String(k).trim()).filter(Boolean)
          : (typeof rule.keywords === 'string' ? rule.keywords.split(',').map(k => k.trim()).filter(Boolean) : existing.keywords);
      }
      if (rule.replyText) existing.replyText = rule.replyText.trim();
      if (rule.enabled !== undefined) existing.enabled = rule.enabled;
      saveBotRulesToFile();
      return res.json({ success: true, message: 'Rule updated successfully', rule: existing, rules: botRules });
    }

    res.status(400).json({ success: false, message: 'Invalid action specified' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * API: WhatsApp Bot Live Simulator / Matcher Test
 */
app.post('/api/whatsapp/bot-test', (req, res) => {
  const { text, senderName } = req.body;
  if (!text) {
    return res.status(400).json({ success: false, message: 'Message text is required' });
  }
  const result = testBotRuleMatch(text, senderName);
  res.json({ success: true, ...result });
});

/**
 * API: Send WhatsApp OTP with Multi-Device Failover
 */
app.post('/api/whatsapp/send-otp', async (req, res) => {
  const { phone, name = 'User', userType = 'seeker', otp: incomingOtp } = req.body;
  const digits = normalizePhone(phone);

  if (!/^[6-9]\d{9}$/.test(digits)) {
    return res.status(400).json({ success: false, message: 'Invalid 10-digit Indian phone number.' });
  }

  const otp = incomingOtp && /^\d{6}$/.test(String(incomingOtp).trim())
    ? String(incomingOtp).trim()
    : Math.floor(100000 + Math.random() * 900000).toString();

  const expiresAt = Date.now() + 10 * 60 * 1000;
  phoneOtpStore.set(digits, { otp, expiresAt, name });

  const greetings = [`नमस्ते ${name} जी,`, `Hello ${name},`, `सादर प्रणाम ${name} जी,`];
  const chosenGreeting = greetings[Math.floor(Math.random() * greetings.length)];

  const intros = userType === 'seeker'
    ? 'ज़िलाजॉब्स (JilaJobs) स्थानीय रोज़गार पोर्टल पर आपका सत्यापन कोड है:'
    : 'ज़िलाजॉब्स (JilaJobs) कंपनी पोर्टल पर आपका आधिकारिक सत्यापन कोड है:';

  const refId = Math.random().toString(36).substring(2, 7).toUpperCase();
  const timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const messageText = `${chosenGreeting}\n\n${intros}\n\n👉 *${otp}*\n\n(कृपया यह 6-अंकीय कोड वेबसाइट पर दर्ज करें)\n\n⚠️ सुरक्षा सूचना: यह कोड केवल 10 मिनट के लिए मान्य है। किसी भी अनजान व्यक्ति के साथ इसे साझा न करें। JilaJobs आपसे कभी भी पैसे नहीं माँगता।\n\n━━━━━━━━━━━━━━━━━━━━\n📌 Ref ID: #JJ-${refId} • Time: ${timeStr} IST\n🌐 JilaJobs - Apne District Me Pao Verified Jobs`;

  const dispatchResult = await sendMessageWithFailover(digits, messageText, userType === 'employer' ? 'employer_otp' : 'candidate_otp');

  if (!dispatchResult.success || !dispatchResult.isRealSent) {
    return res.status(503).json({
      success: false,
      isRealSent: false,
      otp,
      message: dispatchResult.message || 'WhatsApp message could not be delivered.',
      directUrl: dispatchResult.directUrl,
    });
  }

  return res.json({
    success: true,
    isRealSent: dispatchResult.isRealSent,
    otp,
    sentViaDevice: dispatchResult.sentViaDevice,
    message: dispatchResult.message,
    directUrl: dispatchResult.directUrl,
  });
});

/**
 * API: Verify WhatsApp OTP
 */
app.post('/api/whatsapp/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  const digits = normalizePhone(phone);
  const cleanOtp = String(otp || '').trim();

  const stored = phoneOtpStore.get(digits) || phoneOtpStore.get(`91${digits}`);
  if (!stored) {
    return res.status(400).json({ success: false, message: 'OTP expired or not requested.' });
  }

  if (Date.now() > stored.expiresAt) {
    phoneOtpStore.delete(digits);
    phoneOtpStore.delete(`91${digits}`);
    return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
  }

  if (stored.otp === cleanOtp) {
    phoneOtpStore.delete(digits);
    phoneOtpStore.delete(`91${digits}`);
    return res.json({ success: true, message: 'WhatsApp number verified successfully.' });
  }

  return res.status(400).json({ success: false, message: 'Invalid OTP code entered.' });
});

/**
 * API: Send Job Application / Request Notification to Employer via WhatsApp
 */
app.post('/api/whatsapp/send-job-request', async (req, res) => {
  const {
    employerPhone,
    employerName = 'नियोक्ता',
    jobTitle = 'पद',
    candidateName = 'उम्मीदवार',
    candidatePhone = '',
    candidateEmail = '',
    candidateLocation = '',
    candidateEducation = '',
    candidateCompleteness = 85,
    candidateNote = '',
  } = req.body;

  const digits = normalizePhone(employerPhone);
  if (!digits || digits.length !== 10) {
    return res.status(400).json({ success: false, error: 'Valid 10-digit employer mobile number required.' });
  }

  const messageText = 
`🔔 *जिला जॉब्स (JilaJobs) - नया उम्मीदवार आवेदन!*
━━━━━━━━━━━━━━━━━━━━
नमस्ते *${employerName}* जी,

आपकी रिक्ति *"${jobTitle}"* के लिए एक नया उम्मीदवार आवेदन प्राप्त हुआ है:

👤 *उम्मीदवार का नाम:* ${candidateName}
📍 *स्थान:* ${candidateLocation || 'स्थानीय जिला'}
📞 *मोबाइल / WhatsApp:* +91 ${candidatePhone || 'पोर्टल पर उपलब्ध'}
🎓 *योग्यता:* ${candidateEducation || 'उपलब्ध'}
✅ *प्रोफाइल पूर्णता:* ${candidateCompleteness}%
${candidateEmail ? `📧 *ईमेल:* ${candidateEmail}\n` : ''}${candidateNote ? `💬 *नोट:* ${candidateNote}\n` : ''}
👉 *साक्षात्कार (Interview) या कार्यस्थल विजिट तय करने हेतु पोर्टल खोलें:*
http://localhost/job/employer/applicants

━━━━━━━━━━━━━━━━━━━━
🌐 *JilaJobs - जिला जॉब्स नियोक्ता पोर्टल*`;

  const dispatchResult = await sendMessageWithFailover(digits, messageText, userType === 'employer' ? 'employer_otp' : 'candidate_otp');
  return res.json(dispatchResult);
});

/**
 * API: Send Interview / Visiting Invitation via WhatsApp
 */
app.post('/api/whatsapp/send-interview', async (req, res) => {
  const {
    phone,
    candidateName = 'उम्मीदवार',
    companyName = 'नियोक्ता',
    jobTitle = 'पद',
    inviteType = 'interview',
    date = 'तारीख',
    time = 'समय',
    mode = 'Face to Face Interview',
    locationOrLink = 'कंपनी कार्यालय',
    contactPerson = 'HR Manager',
    instructions = '',
  } = req.body;

  const digits = normalizePhone(phone);
  if (!digits || digits.length !== 10) {
    return res.status(400).json({ success: false, error: 'Valid 10-digit candidate mobile number required.' });
  }

  const isVisit = inviteType === 'visit';
  const heading = isVisit 
    ? '🏢 *कंपनी / कार्यस्थल विजिट आमंत्रण (Workplace Visit)*'
    : '🎯 *साक्षात्कार आमंत्रण सूचना (Interview Call)*';

  const intro = isVisit
    ? `बधाई हो! *${companyName}* ने आपकी रिक्वेस्ट स्वीकार (Accept) कर ली है और आपको *${jobTitle}* पद हेतु कार्यस्थल / कंपनी विजिट (Visiting) के लिए आमंत्रित किया है:`
    : `बधाई हो! *${companyName}* ने आपकी रिक्वेस्ट स्वीकार (Accept) कर ली है और *${jobTitle}* पद हेतु साक्षात्कार तय किया है:`;

  const dateLabel = isVisit ? 'विजिट तारीख (Visiting Date)' : 'तारीख';
  const locationLabel = isVisit ? 'विजिट स्थल / पता' : 'स्थान / लिंक';

  const messageText = 
`${heading}
━━━━━━━━━━━━━━━━━━━━
नमस्ते *${candidateName}* जी,

${intro}

📅 *${dateLabel}:* ${date}
⏰ *समय:* ${time}
${!isVisit ? `📍 *माध्यम:* ${mode}\n` : ''}📌 *${locationLabel}:* ${locationOrLink || (isVisit ? 'कंपनी परिसर' : 'कंपनी कार्यालय')}
👤 *संपर्क सूत्र:* ${contactPerson}
${instructions ? `📝 *निर्देश:* ${instructions}\n` : ''}
⚠️ समय पर उपस्थित रहें एवं मूल दस्तावेज़ साथ लाएं। JilaJobs पर भर्ती 100% नि:शुल्क है।
━━━━━━━━━━━━━━━━━━━━
🌐 JilaJobs - Apne District Me Pao Verified Jobs`;

  const dispatchResult = await sendMessageWithFailover(digits, messageText, userType === 'employer' ? 'employer_otp' : 'candidate_otp');
  return res.json(dispatchResult);
});

/**
 * API: Send Candidate Job Alert via WhatsApp (with Failover)
 */
app.post('/api/whatsapp/send-candidate-alert', async (req, res) => {
  const { phone, candidateName, companyName, jobTitle, category, district, salaryText, jobLink, customMessage } = req.body;
  const digits = normalizePhone(phone);
  if (!digits || digits.length !== 10) {
    return res.status(400).json({ success: false, error: 'Valid 10-digit candidate mobile number required.' });
  }

  const messageText = customMessage || 
`*जिला जॉब्स (JilaJobs) - नई नौकरी का अवसर! 🎯*
━━━━━━━━━━━━━━━━━━━━
नमस्ते *${candidateName || 'उम्मीदवार'}* जी,

*${companyName}* ने आपके जिले (*${district || 'आपके जिले'}*) में आपकी पसंदीदा श्रेणी *"${category || 'नौकरी'}"* के लिए नई रिक्ति पोस्ट की है और आपकी प्रोफ़ाइल को सीधे आमंत्रित किया है:

💼 *पद (Role):* ${jobTitle}
🏢 *कंपनी:* ${companyName}
📍 *स्थान:* ${district}
${salaryText ? `💰 *वेतन:* ${salaryText}\n` : ''}
👉 *विवरण देखें व सीधे आवेदन करें:*
${jobLink || 'http://localhost/job/jobs'}

━━━━━━━━━━━━━━━━━━━━
🌐 *JilaJobs - जिला जॉब्स पोर्टल* (100% नि:शुल्क भर्ती)`;

  const dispatchResult = await sendMessageWithFailover(digits, messageText, userType === 'employer' ? 'employer_otp' : 'candidate_otp');
  return res.json(dispatchResult);
});

/**
 * API: Send Creator Promotion Invitation via WhatsApp (with Failover)
 */
app.post('/api/whatsapp/send-creator-invitation', async (req, res) => {
  const { phone, creatorName, shopName, campaignType, offerPrice, promotionTypes, preferredDate, message, employerPhone, shopAddress } = req.body;
  const digits = normalizePhone(phone);
  if (!digits || digits.length !== 10) {
    return res.status(400).json({ success: false, error: 'Valid 10-digit creator mobile number required.' });
  }

  const typesStr = Array.isArray(promotionTypes) ? promotionTypes.join(', ') : (promotionTypes || 'Instagram Reel');
  const messageText = 
`🎬 *नया प्रमोशन व दुकान प्रचार आमंत्रण (New Collaboration Request)*
━━━━━━━━━━━━━━━━━━━━
नमस्ते *${creatorName || 'क्रिएटर'}* जी,

बधाई हो! *${shopName}* ने JilaJobs के माध्यम से आपके साथ दुकान व बिज़नेस प्रमोशन का नया प्रस्ताव भेजा है:

🏢 *दुकान / बिज़नेस:* ${shopName}
📍 *स्थान:* ${shopAddress || 'लोकल स्टोर'}
🎯 *कैंपेन प्रकार:* ${campaignType || 'दुकान प्रचार'}
💰 *प्रस्तावित बजट:* ₹${offerPrice || '0'}
📹 *प्रचार माध्यम:* ${typesStr}
📅 *प्रस्तावित तारीख:* ${preferredDate || 'जल्द से जल्द'}
${message ? `💬 *संदेश:* "${message}"\n` : ''}${employerPhone ? `📞 *नियोक्ता संपर्क:* ${employerPhone}\n` : ''}
👉 आमंत्रण देखने व स्वीकार करने हेतु JilaJobs पर लॉगिन करें:
http://localhost/job/creator/invitations
━━━━━━━━━━━━━━━━━━━━
🌐 JilaJobs Creator Network`;

  const dispatchResult = await sendMessageWithFailover(digits, messageText, userType === 'employer' ? 'employer_otp' : 'candidate_otp');
  return res.json(dispatchResult);
});

// ----------------- SMTP EMAIL API ROUTES -----------------

function createSmtpTransporter(smtpConfig) {
  const host = (smtpConfig.host || 'smtp.gmail.com').trim();
  const port = Number(smtpConfig.port) || 587;
  const secure = smtpConfig.secure === true || port === 465;
  let user = (smtpConfig.user || '').trim();
  let pass = (smtpConfig.pass || '').trim();

  // If Gmail or Google Workspace, strip whitespace and hyphens from App Passwords
  if (host.includes('gmail') || host.includes('google')) {
    pass = pass.replace(/[\s\-]/g, '');
  }

  const transportCreator = nodemailer.createTransport || nodemailer.default?.createTransport;
  if (typeof transportCreator !== 'function') {
    throw new Error('nodemailer.createTransport function is not available.');
  }

  return transportCreator({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
}

app.post('/api/email/test', async (req, res) => {
  const { smtpConfig, targetEmail } = req.body;
  if (!smtpConfig || !smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
    return res.status(400).json({ success: false, message: 'Incomplete SMTP configuration details.' });
  }

  try {
    const transporter = createSmtpTransporter(smtpConfig);
    await transporter.verify();

    const fromAddress = smtpConfig.fromEmail
      ? `"${smtpConfig.fromName || 'JilaJobs'}" <${smtpConfig.fromEmail}>`
      : `"${smtpConfig.fromName || 'JilaJobs'}" <${smtpConfig.user}>`;

    await transporter.sendMail({
      from: fromAddress,
      to: targetEmail || smtpConfig.user,
      subject: 'JilaJobs SMTP Gateway Connection Verified ✅',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 24px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px;">
          <h2 style="color: #0f172a; margin-top: 0;">JilaJobs SMTP Gateway Verified</h2>
          <p style="color: #334155; font-size: 14px;">Your SMTP connection to <strong>${smtpConfig.host}:${smtpConfig.port}</strong> is successfully verified and fully operational.</p>
          <p style="color: #64748b; font-size: 12px; margin-top: 24px;">Timestamp: ${new Date().toISOString()}</p>
        </div>
      `,
    });

    return res.json({ success: true, message: `SMTP verification successful! Test message sent to ${targetEmail || smtpConfig.user}.` });
  } catch (err) {
    let msg = err?.message || 'SMTP connection failed';
    if (msg.includes('535') && (smtpConfig.host?.includes('gmail') || smtpConfig.host?.includes('google'))) {
      msg = "Gmail SMTP Auth Failed (535): You must use a 16-character Google App Password (not your regular Gmail password). Generate it at https://myaccount.google.com/apppasswords";
    }
    return res.status(500).json({ success: false, message: msg });
  }
});

app.post('/api/email/send-otp', async (req, res) => {
  const { email, name = 'User', userType = 'seeker', smtpConfig, otp: incomingOtp } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail || !cleanEmail.includes('@')) {
    return res.status(400).json({ success: false, message: 'Invalid email address provided.' });
  }

  const otp = incomingOtp && /^\d{6}$/.test(String(incomingOtp).trim())
    ? String(incomingOtp).trim()
    : Math.floor(100000 + Math.random() * 900000).toString();

  const expiresAt = Date.now() + 10 * 60 * 1000;
  emailOtpStore.set(cleanEmail, { otp, expiresAt, name });

  if (smtpConfig && smtpConfig.enabled && smtpConfig.host && smtpConfig.user && smtpConfig.pass) {
    try {
      const transporter = createSmtpTransporter(smtpConfig);
      const fromAddress = smtpConfig.fromEmail
        ? `"${smtpConfig.fromName || 'JilaJobs'}" <${smtpConfig.fromEmail}>`
        : `"${smtpConfig.fromName || 'JilaJobs'}" <${smtpConfig.user}>`;

      await transporter.sendMail({
        from: fromAddress,
        to: cleanEmail,
        subject: `Your JilaJobs Verification Code is: ${otp}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 32px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 20px;">
            <h1 style="color: #ea580c; font-size: 24px; margin: 0 0 16px 0; font-weight: 900;">JilaJobs</h1>
            <p style="color: #334155; font-size: 15px;">Hello <strong>${name}</strong>,</p>
            <p style="color: #334155; font-size: 14px;">Your 6-digit email verification code for JilaJobs ${userType === 'seeker' ? 'Candidate' : 'Employer'} portal is:</p>
            <div style="background: #f8fafc; border: 2px dashed #ea580c; border-radius: 12px; padding: 16px; text-align: center; margin: 24px 0;">
              <span style="font-size: 32px; font-weight: 900; letter-spacing: 6px; color: #0f172a;">${otp}</span>
            </div>
            <p style="color: #64748b; font-size: 12px;">This code is valid for 10 minutes. Please do not share it with anyone.</p>
          </div>
        `,
      });

      return res.json({ success: true, isRealSent: true, otp, message: `OTP sent via SMTP to ${cleanEmail}.` });
    } catch (err) {
      console.error('[Send Email OTP Error]:', err);
    }
  }

  return res.json({ success: true, isRealSent: false, otp, message: `OTP prepared for ${cleanEmail}.` });
});

app.post('/api/email/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanOtp = String(otp || '').trim();

  const stored = emailOtpStore.get(cleanEmail);
  if (!stored) {
    return res.status(400).json({ success: false, message: 'OTP expired or not requested.' });
  }

  if (Date.now() > stored.expiresAt) {
    emailOtpStore.delete(cleanEmail);
    return res.status(400).json({ success: false, message: 'Email OTP has expired.' });
  }

  if (stored.otp === cleanOtp) {
    emailOtpStore.delete(cleanEmail);
    return res.json({ success: true, message: 'Email address verified successfully.' });
  }

  return res.status(400).json({ success: false, message: 'Invalid OTP code entered.' });
});

app.post('/api/email/send-welcome', async (req, res) => {
  const { email, name = 'User', userType = 'seeker', district = 'your district', smtpConfig } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (smtpConfig && smtpConfig.enabled && smtpConfig.host && smtpConfig.user && smtpConfig.pass) {
    try {
      const transporter = createSmtpTransporter(smtpConfig);
      const fromAddress = smtpConfig.fromEmail
        ? `"${smtpConfig.fromName || 'JilaJobs'}" <${smtpConfig.fromEmail}>`
        : `"${smtpConfig.fromName || 'JilaJobs'}" <${smtpConfig.user}>`;

      await transporter.sendMail({
        from: fromAddress,
        to: cleanEmail,
        subject: `Welcome to JilaJobs, ${name}! 🎉`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 24px;">
            <h1 style="color: #ea580c; font-size: 26px; margin: 0 0 16px 0; font-weight: 900;">Welcome to JilaJobs!</h1>
            <p style="color: #334155; font-size: 15px;">Dear <strong>${name}</strong>,</p>
            <p style="color: #334155; font-size: 14px; line-height: 1.6;">
              Congratulations on registering on JilaJobs — the verified district employment exchange for ${district}.
            </p>
          </div>
        `,
      });
      return res.json({ success: true, message: `Welcome email sent to ${cleanEmail}.` });
    } catch (err) {
      console.error('[Send Welcome Email Error]:', err);
    }
  }

  return res.json({ success: true, isRealSent: false });
});

app.post('/api/email/send-job-request', async (req, res) => {
  const {
    employerEmail,
    employerName = 'Employer',
    jobTitle = 'Role',
    candidateName = 'Candidate',
    candidatePhone = '',
    candidateEmail = '',
    candidateLocation = '',
    candidateEducation = '',
    candidateCompleteness = 85,
    candidateNote = '',
    smtpConfig,
  } = req.body;

  const cleanEmail = String(employerEmail || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return res.status(400).json({ success: false, error: 'Valid employer email required.' });
  }

  if (smtpConfig && smtpConfig.enabled && smtpConfig.host && smtpConfig.user && smtpConfig.pass) {
    try {
      const transporter = createSmtpTransporter(smtpConfig);
      const fromAddress = smtpConfig.fromEmail
        ? `"${smtpConfig.fromName || 'JilaJobs'}" <${smtpConfig.fromEmail}>`
        : `"${smtpConfig.fromName || 'JilaJobs'}" <${smtpConfig.user}>`;

      await transporter.sendMail({
        from: fromAddress,
        to: cleanEmail,
        subject: `🔔 New Application: ${candidateName} applied for "${jobTitle}"`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 24px;">
            <h2 style="color: #0f172a; margin-top: 0;">New Job Application Received</h2>
            <p style="color: #334155; font-size: 15px;">Dear <strong>${employerName}</strong>,</p>
            <p style="color: #334155; font-size: 14px;"><strong>${candidateName}</strong> has applied for your vacancy: <strong>${jobTitle}</strong>.</p>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 20px; margin: 20px 0;">
              <p style="margin: 4px 0; font-size: 13px;">📍 Location: <strong>${candidateLocation || 'District'}</strong></p>
              <p style="margin: 4px 0; font-size: 13px;">📞 Phone: <strong>+91 ${candidatePhone || 'Available in portal'}</strong></p>
              <p style="margin: 4px 0; font-size: 13px;">🎓 Qualification: <strong>${candidateEducation || 'Available'}</strong></p>
              <p style="margin: 4px 0; font-size: 13px;">✅ Profile Completeness: <strong>${candidateCompleteness}%</strong></p>
            </div>
            <a href="http://localhost/job/employer/applicants" style="display: inline-block; padding: 12px 24px; background: #ea580c; color: #ffffff; font-weight: bold; font-size: 13px; border-radius: 12px; text-decoration: none;">
              Schedule Interview / View Details →
            </a>
          </div>
        `,
      });

      return res.json({ success: true, message: `Application alert email sent to ${cleanEmail}.` });
    } catch (err) {
      console.error('[Send Job Request Email Error]:', err);
    }
  }

  return res.json({ success: true, isRealSent: false, message: `Email queued for ${cleanEmail}.` });
});

app.post('/api/email/send-interview', async (req, res) => {
  const {
    email,
    candidateName = 'Candidate',
    companyName = 'Employer',
    jobTitle = 'Role',
    inviteType = 'interview',
    date = 'Date',
    time = 'Time',
    mode = 'In-Person',
    locationOrLink = 'Company Office',
    contactPerson = 'HR',
    instructions = '',
    smtpConfig,
  } = req.body;

  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return res.status(400).json({ success: false, error: 'Valid candidate email required.' });
  }

  const isVisit = inviteType === 'visit';

  if (smtpConfig && smtpConfig.enabled && smtpConfig.host && smtpConfig.user && smtpConfig.pass) {
    try {
      const transporter = createSmtpTransporter(smtpConfig);
      const fromAddress = smtpConfig.fromEmail
        ? `"${smtpConfig.fromName || 'JilaJobs'}" <${smtpConfig.fromEmail}>`
        : `"${smtpConfig.fromName || 'JilaJobs'}" <${smtpConfig.user}>`;

      await transporter.sendMail({
        from: fromAddress,
        to: cleanEmail,
        subject: `${isVisit ? '🏢 Workplace Visit Invitation' : '🎯 Interview Scheduled'}: ${jobTitle} at ${companyName} (${date})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 24px;">
            <h1 style="color: #0f172a; font-size: 22px; margin: 0 0 8px 0; font-weight: 900;">
              ${isVisit ? 'Workplace Visit Invitation' : 'Interview Scheduled'}
            </h1>
            <p style="color: #334155; font-size: 15px;">Dear <strong>${candidateName}</strong>,</p>
            <p style="color: #334155; font-size: 14px;"><strong>${companyName}</strong> has scheduled your ${isVisit ? 'workplace visit' : 'interview'} for <strong>${jobTitle}</strong>:</p>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 20px; margin: 20px 0;">
              <p style="margin: 4px 0; font-size: 14px;">📅 Date: <strong>${date}</strong></p>
              <p style="margin: 4px 0; font-size: 14px;">⏰ Time: <strong>${time}</strong></p>
              ${!isVisit ? `<p style="margin: 4px 0; font-size: 14px;">📍 Mode: <strong>${mode}</strong></p>` : ''}
              <p style="margin: 4px 0; font-size: 14px;">📌 Location: <strong>${locationOrLink || 'Company Premises'}</strong></p>
              <p style="margin: 4px 0; font-size: 14px;">👤 Contact Person: <strong>${contactPerson}</strong></p>
              ${instructions ? `<p style="margin: 4px 0; font-size: 13px; color: #475569;">📝 Instructions: ${instructions}</p>` : ''}
            </div>
            <p style="color: #64748b; font-size: 12px;">Please arrive on time with your identity and education credentials.</p>
          </div>
        `,
      });

      return res.json({ success: true, message: `Interview invitation email sent to ${cleanEmail}.` });
    } catch (err) {
      console.error('[Send Interview Email Error]:', err);
    }
  }

  return res.json({ success: true, isRealSent: false, message: `Email queued for ${cleanEmail}.` });
});

app.post('/api/email/send-candidate-alert', async (req, res) => {
  const { email, candidateName, companyName, jobTitle, category, district, salaryText, jobLink, smtpConfig } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return res.status(400).json({ success: false, error: 'Valid candidate email required.' });
  }

  if (smtpConfig && smtpConfig.enabled && smtpConfig.host && smtpConfig.user && smtpConfig.pass) {
    try {
      const transporter = createSmtpTransporter(smtpConfig);
      const fromAddress = smtpConfig.fromEmail
        ? `"${smtpConfig.fromName || 'JilaJobs'}" <${smtpConfig.fromEmail}>`
        : `"${smtpConfig.fromName || 'JilaJobs'}" <${smtpConfig.user}>`;

      await transporter.sendMail({
        from: fromAddress,
        to: cleanEmail,
        subject: `🎯 New Job Opportunity: ${jobTitle} at ${companyName} (${district})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 24px;">
            <div style="display: inline-block; padding: 6px 14px; background: #eff6ff; color: #1d4ed8; border-radius: 20px; font-size: 12px; font-weight: bold; margin-bottom: 12px;">
              🎯 New Vacancy Alert (${category || 'Job Opportunity'})
            </div>
            <h1 style="color: #0f172a; font-size: 22px; margin: 0 0 8px 0; font-weight: 900;">
              Job Opportunity for You
            </h1>
            <p style="color: #334155; font-size: 15px; line-height: 1.6;">
              Dear <strong>${candidateName || 'Candidate'}</strong>,<br/>
              <strong>${companyName}</strong> has posted a verified job vacancy in your preferred category in <strong>${district}</strong> and invited you to apply:
            </p>

            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 20px; margin: 20px 0;">
              <p style="margin: 4px 0; font-size: 15px; color: #0f172a;">💼 <strong>Role:</strong> ${jobTitle}</p>
              <p style="margin: 4px 0; font-size: 15px; color: #0f172a;">🏢 <strong>Company:</strong> ${companyName}</p>
              <p style="margin: 4px 0; font-size: 14px; color: #475569;">📍 <strong>District:</strong> ${district}</p>
              ${salaryText ? `<p style="margin: 4px 0; font-size: 14px; color: #16a34a;">💰 <strong>Salary:</strong> ${salaryText}</p>` : ''}
            </div>

            <div style="text-align: center; margin: 24px 0;">
              <a href="${jobLink || 'http://localhost/job/jobs'}" style="display: inline-block; padding: 12px 28px; background: #ea580c; color: #ffffff; font-weight: bold; font-size: 14px; border-radius: 12px; text-decoration: none;">
                View Details & Apply Now →
              </a>
            </div>

            <p style="color: #64748b; font-size: 12px; line-height: 1.6; margin: 20px 0 0 0;">
              JilaJobs is a 100% free hiring platform. Never pay any registration or processing fees.
            </p>
          </div>
        `,
      });

      return res.json({ success: true, message: `Job alert email sent to ${cleanEmail}.` });
    } catch (err) {
      console.error('[Send Candidate Alert Email Error]:', err);
      return res.json({ success: false, message: err.message });
    }
  }

  return res.json({
    success: true,
    isRealSent: false,
    message: `Email notification queued for ${cleanEmail}.`,
  });
});

/**
 * API: Send Creator Promotion Invitation Email via SMTP
 */
app.post('/api/email/send-creator-invitation', async (req, res) => {
  const { email, creatorName, shopName, campaignType, offerPrice, promotionTypes, preferredDate, message, employerPhone, shopAddress, smtpConfig } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail || !cleanEmail.includes('@')) {
    return res.status(400).json({ success: false, error: 'Valid creator email address required.' });
  }

  const cfg = smtpConfig || DEFAULT_SMTP_CONFIG;
  if (cfg.enabled && cfg.pass) {
    try {
      const transporter = createSmtpTransporter(cfg);
      const typesStr = Array.isArray(promotionTypes) ? promotionTypes.join(', ') : (promotionTypes || 'Instagram Reel');

      await transporter.sendMail({
        from: `"${cfg.fromName || 'JilaJobs Creator Network'}" <${cfg.fromEmail || cfg.user}>`,
        to: cleanEmail,
        subject: `🎬 नया दुकान प्रचार आमंत्रण — ${shopName} (बजट: ₹${offerPrice || 0})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
            <h1 style="color: #6b21a8; font-size: 22px; margin: 0 0 8px 0; font-weight: 900;">
              🎬 New Promotion Invitation
            </h1>
            <p style="color: #334155; font-size: 15px; line-height: 1.6;">
              Dear <strong>${creatorName || 'Creator'}</strong>,<br/>
              <strong>${shopName}</strong> has sent you a collaboration offer on JilaJobs Creator Network:
            </p>

            <div style="background: #faf5ff; border: 1px solid #f3e8ff; border-radius: 16px; padding: 20px; margin: 20px 0;">
              <p style="margin: 4px 0; font-size: 15px; color: #581c87;">🏢 <strong>Business / Shop:</strong> ${shopName}</p>
              <p style="margin: 4px 0; font-size: 15px; color: #581c87;">🎯 <strong>Campaign Type:</strong> ${campaignType}</p>
              <p style="margin: 4px 0; font-size: 16px; color: #16a34a; font-weight: bold;">💰 <strong>Offer Price:</strong> ₹${offerPrice}</p>
              <p style="margin: 4px 0; font-size: 14px; color: #475569;">📹 <strong>Deliverables:</strong> ${typesStr}</p>
              ${preferredDate ? `<p style="margin: 4px 0; font-size: 14px; color: #475569;">📅 <strong>Preferred Date:</strong> ${preferredDate}</p>` : ''}
              ${shopAddress ? `<p style="margin: 4px 0; font-size: 14px; color: #475569;">📍 <strong>Address:</strong> ${shopAddress}</p>` : ''}
              ${employerPhone ? `<p style="margin: 4px 0; font-size: 14px; color: #475569;">📞 <strong>Employer Phone:</strong> ${employerPhone}</p>` : ''}
              ${message ? `<p style="margin: 8px 0 0 0; font-size: 14px; color: #334155; font-style: italic;">💬 "${message}"</p>` : ''}
            </div>

            <div style="text-align: center; margin: 24px 0;">
              <a href="http://localhost/job/creator/invitations" style="display: inline-block; padding: 12px 28px; background: #7c3aed; color: #ffffff; font-weight: bold; font-size: 14px; border-radius: 12px; text-decoration: none;">
                View & Accept Invitation →
              </a>
            </div>

            <p style="color: #64748b; font-size: 12px; line-height: 1.6; margin: 20px 0 0 0;">
              JilaJobs Creator Network connects local shopkeepers and businesses with verified district creators.
            </p>
          </div>
        `,
      });

      return res.json({ success: true, message: `Promotion invitation email sent to ${cleanEmail}.` });
    } catch (err) {
      console.error('[Send Creator Invitation Email Error]:', err);
      return res.json({ success: false, message: err.message });
    }
  }

  return res.json({
    success: true,
    isRealSent: false,
    message: `Promotion invitation email queued for ${cleanEmail}.`,
  });
});

app.listen(PORT, () => {
  console.log(`[JilaJobs WhatsApp Multi-Device & SMTP Gateway Server] Running on http://localhost:${PORT}`);
});

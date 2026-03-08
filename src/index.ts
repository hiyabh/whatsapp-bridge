import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
  proto,
} from "@whiskeysockets/baileys";
import express from "express";
import * as qrcode from "qrcode-terminal";
import pino from "pino";
import { execSync } from "child_process";
import * as fs from "fs";

// --- Configuration ---
const MYBRAIN_URL = process.env.MYBRAIN_URL || "http://localhost:8080";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";
const MY_PHONE = process.env.MY_PHONE || "";
const PORT = parseInt(process.env.PORT || "3000");

// Auth store path
const AUTH_STORE = process.env.AUTH_STORE_PATH || "./auth_store";

// Clean stale session files on startup - keep only creds.json
// so Baileys renegotiates fresh Signal sessions each deploy.
function cleanStaleSessionFiles(): void {
  if (!fs.existsSync(`${AUTH_STORE}/creds.json`)) {
    console.log("[AUTH] No creds.json found - will show QR code");
    return;
  }
  console.log("[AUTH] Cleaning stale session files, keeping creds.json...");
  const files = fs.readdirSync(AUTH_STORE);
  let removed = 0;
  for (const file of files) {
    if (file === "creds.json") continue;
    // Keep app-state-sync-key files (encryption keys, don't change)
    if (file.startsWith("app-state-sync-key-")) continue;
    // Remove session, pre-key, and app-state-sync-version files (become stale)
    fs.unlinkSync(`${AUTH_STORE}/${file}`);
    removed++;
  }
  console.log(`[AUTH] Removed ${removed} stale files, keeping creds.json + sync keys`);
}

cleanStaleSessionFiles();

const logger = pino({ level: "warn" });

let sock: WASocket | null = null;
let isConnected = false;

// --- Message Queue (anti-ban) ---
interface QueueItem {
  jid: string;
  text: string;
  resolve: (value: boolean) => void;
}

const messageQueue: QueueItem[] = [];
let processingQueue = false;

// Track message IDs sent by the bot to avoid infinite loops
const botSentIds = new Set<string>();
// Track processed incoming message IDs to avoid duplicates
const processedMsgIds = new Set<string>();
const MAX_TRACKED_IDS = 500;

function addJitter(baseMs: number): number {
  const jitter = baseMs * 0.3 * (Math.random() * 2 - 1);
  return Math.round(baseMs + jitter);
}

async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;

  while (messageQueue.length > 0) {
    const item = messageQueue.shift();
    if (!item || !sock || !isConnected) {
      item?.resolve(false);
      continue;
    }

    try {
      const sent = await sock.sendMessage(item.jid, { text: item.text });
      // Track the sent message ID so we don't process our own replies
      if (sent?.key?.id) {
        botSentIds.add(sent.key.id);
        // Cleanup old IDs to prevent memory leak
        if (botSentIds.size > MAX_TRACKED_IDS) {
          const first = botSentIds.values().next().value;
          if (first) botSentIds.delete(first);
        }
      }
      item.resolve(true);
    } catch (err) {
      console.error("[SEND ERROR]", err);
      item.resolve(false);
    }

    // Anti-ban: 3-5 second delay between messages
    await new Promise((r) => setTimeout(r, addJitter(4000)));
  }

  processingQueue = false;
}

function queueMessage(jid: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    messageQueue.push({ jid, text, resolve });
    processQueue();
  });
}

// --- Extract text from message ---
function extractText(
  message: proto.IMessage | null | undefined
): string | null {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    null
  );
}

// --- WhatsApp Connection ---
async function connectWhatsApp(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_STORE);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[INIT] Using WA version: ${version.join(".")}`);

  sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: true,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  // Save credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Connection state management
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n[QR CODE] Scan with WhatsApp:\n");
      qrcode.generate(qr, { small: true });
      console.log("\n[QR CODE] Waiting for scan...\n");
    }

    if (connection === "open") {
      isConnected = true;
      console.log("[CONNECTED] WhatsApp bridge is ready!");
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const reason = DisconnectReason;

      if (statusCode === reason.loggedOut) {
        console.error("[LOGGED OUT] Session expired. Delete auth_store and re-scan QR.");
        return;
      }

      // Reconnect with backoff
      const delay = statusCode === 440 ? addJitter(60000) : addJitter(10000);
      console.log(
        `[DISCONNECTED] Status ${statusCode}. Reconnecting in ${Math.round(delay / 1000)}s...`
      );
      setTimeout(connectWhatsApp, delay);
    }
  });

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;

      // Skip messages sent by this bot (prevent infinite loop)
      if (msg.key.id && botSentIds.has(msg.key.id)) {
        botSentIds.delete(msg.key.id);
        continue;
      }

      // Deduplicate: skip messages we've already processed
      if (msg.key.id) {
        if (processedMsgIds.has(msg.key.id)) continue;
        processedMsgIds.add(msg.key.id);
        if (processedMsgIds.size > MAX_TRACKED_IDS) {
          const first = processedMsgIds.values().next().value;
          if (first) processedMsgIds.delete(first);
        }
      }

      const jid = msg.key.remoteJid;
      if (!jid) continue;

      // Only handle DMs (not groups)
      if (jid.endsWith("@g.us") || jid.endsWith("@newsletter")) continue;

      // Only respond in self-chat ("Message Yourself").
      // The bot runs on the user's own number as a linked device,
      // so it sees ALL messages. We only want to process messages
      // in the self-chat where remoteJid matches MY_PHONE.
      const chatPhone = jid.replace("@s.whatsapp.net", "").replace("@lid", "");
      if (MY_PHONE && chatPhone !== MY_PHONE) continue;

      const phone = MY_PHONE || chatPhone;

      const text = extractText(msg.message);
      if (!text) continue;

      console.log(`[MSG] From ${phone}: ${text.substring(0, 100)}`);

      try {
        // Forward to myBrain Python API
        const response = await fetch(`${MYBRAIN_URL}/whatsapp/incoming`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Bridge-Secret": BRIDGE_SECRET,
          },
          body: JSON.stringify({
            phone,
            text,
            message_id: msg.key.id || "",
          }),
        });

        if (!response.ok) {
          console.error(`[API ERROR] ${response.status}: ${await response.text()}`);
          continue;
        }

        const data = (await response.json()) as { reply: string };

        if (data.reply) {
          // Always reply to phone number JID (not LID which doesn't deliver)
          const replyJid = `${phone}@s.whatsapp.net`;
          // Anti-ban: wait 2-4 seconds before replying
          await new Promise((r) => setTimeout(r, addJitter(3000)));
          await queueMessage(replyJid, data.reply);
          console.log(`[REPLY] To ${phone}: ${data.reply.substring(0, 100)}`);
        }
      } catch (err) {
        console.error("[FORWARD ERROR]", err);
      }
    }
  });
}

// --- Express API ---
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    whatsapp: isConnected ? "connected" : "disconnected",
    queue: messageQueue.length,
  });
});

// Optional: endpoint for myBrain to proactively send messages
app.post("/send", async (req, res) => {
  const { phone, text, secret } = req.body;
  if (secret !== BRIDGE_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!phone || !text) {
    res.status(400).json({ error: "missing phone or text" });
    return;
  }

  const jid = `${phone}@s.whatsapp.net`;
  const sent = await queueMessage(jid, text);
  res.json({ success: sent });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`[HTTP] WhatsApp bridge running on :${PORT}`);
  connectWhatsApp();
});

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
} from "@whiskeysockets/baileys";
import express from "express";
import * as qrcode from "qrcode-terminal";
import pino from "pino";

// --- Configuration ---
const MYBRAIN_URL = process.env.MYBRAIN_URL || "http://localhost:8080";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";
const MY_PHONE = process.env.MY_PHONE || "";
const PORT = parseInt(process.env.PORT || "3000");

// Auth store path - local directory (survives restarts, not deploys)
const AUTH_STORE = process.env.AUTH_STORE_PATH || "./auth_store";

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
      await sock.sendMessage(item.jid, { text: item.text });
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

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // We handle QR manually
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
      // Skip own messages
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      if (!jid) continue;

      // Only handle DMs (not groups)
      if (jid.endsWith("@g.us") || jid.endsWith("@newsletter")) continue;

      // Extract sender phone number
      const phone = jid.replace("@s.whatsapp.net", "").replace("@lid", "");

      // Only respond to authorized user
      if (MY_PHONE && phone !== MY_PHONE) {
        console.log(`[SKIP] Unauthorized: ${phone}`);
        continue;
      }

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
          // Anti-ban: wait 2-4 seconds before replying
          await new Promise((r) => setTimeout(r, addJitter(3000)));
          await queueMessage(jid, data.reply);
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

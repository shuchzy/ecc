import cors from "cors";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { nanoid } from "nanoid";
import selfsigned from "selfsigned";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const certDir = path.join(dataDir, "certs");
const dbPath = path.join(dataDir, "room-panel.json");
const uploadsDir = path.join(dataDir, "uploads");
const campaignsPath = path.join(dataDir, "whatsapp-campaigns.json");
const hardwareCatalogPath = path.join(dataDir, "hardware-catalog.json");
const hardwareCatalogExtraPath = path.join(dataDir, "hardware-catalog-extra.json");
const supplierConfigPath = path.join(dataDir, "supplier-config.json");
const port = Number(process.env.PORT || 4177);
const httpsPort = Number(process.env.HTTPS_PORT || 4178);
const enableLocalHttps = process.env.ENABLE_LOCAL_HTTPS !== "0";
const sicpPort = Number(process.env.SICP_PORT || 5000);
const timeZone = process.env.ROOM_TIMEZONE || "Asia/Jerusalem";
const roomStreams = new Map();
const appUsername = process.env.APP_USERNAME || "ECC";
const appPassword = process.env.APP_PASSWORD || "180056700";
const authSessions = new Map();

if (process.env.SUPPLIER_TLS_REJECT_UNAUTHORIZED !== "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(certDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^\w.\-א-ת ]+/g, "_").slice(0, 90);
      cb(null, `${Date.now()}-${safeName}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const defaultDb = {
  rooms: [
    {
      id: "boardroom",
      name: "חדר הנהלה",
      floor: "קומה 12",
      zone: "אגף צפון",
      capacity: 10,
      email: process.env.EXCHANGE_ROOM_EMAIL || "boardroom@company.local",
      ledSettings: {
        mode: "auto",
        enabled: true,
        color: "#00ff00"
      },
      amenities: [
        { id: "seats", kind: "seats", label: "10 כסאות ארגונומיים" },
        { id: "display", kind: "display", label: "מסך 75 אינץ׳" },
        { id: "video", kind: "video", label: "מצלמת ועידה" },
        { id: "climate", kind: "climate", label: "מזגן עצמאי" },
        { id: "wifi", kind: "wifi", label: "Wi-Fi אורחים" },
        { id: "coffee", kind: "refreshments", label: "עמדת קפה סמוכה" }
      ]
    }
  ],
  events: [
    todayEvent("boardroom", "סנכרון הנהלה", 9, 0, 45),
    todayEvent("boardroom", "פגישת לקוחות", 11, 0, 60),
    todayEvent("boardroom", "סקירת פרויקט", 14, 30, 45)
  ],
  led: {}
};

function todayEvent(roomId, subject, hour, minute, durationMinutes) {
  const start = new Date();
  start.setHours(hour, minute, 0, 0);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  return {
    id: `${roomId}-${hour}-${minute}`,
    roomId,
    subject,
    start: start.toISOString(),
    end: end.toISOString(),
    organizer: "Demo"
  };
}

function readDb() {
  if (!fs.existsSync(dbPath)) writeDb(defaultDb);
  return JSON.parse(fs.readFileSync(dbPath, "utf8").replace(/^\uFEFF/, ""));
}

function writeDb(db) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  return db;
}

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(uploadsDir));
app.use((req, res, next) => {
  if (req.path === "/" || req.path.startsWith("/admin") || req.path.startsWith("/setup")) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: hasGraphConfig() ? "exchange" : "local-demo",
    addresses: localAddresses(),
    httpsAddresses: localAddresses("https", httpsPort)
  });
});

app.get("/api/auth/status", (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (username !== appUsername || password !== appPassword) {
    res.status(401).json({ error: "שם המשתמש או הסיסמה שגויים" });
    return;
  }

  const token = crypto.randomBytes(32).toString("base64url");
  authSessions.set(token, {
    createdAt: Date.now(),
    lastSeenAt: Date.now()
  });
  res.setHeader("Set-Cookie", buildAuthCookie(req, token));
  res.json({ authenticated: true });
});

app.post("/api/auth/logout", (req, res) => {
  const token = authToken(req);
  if (token) authSessions.delete(token);
  res.setHeader("Set-Cookie", buildAuthCookie(req, "", 0));
  res.json({ authenticated: false });
});

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) {
    next();
    return;
  }
  if (req.path.startsWith("/api/auth/") || req.path === "/api/health") {
    next();
    return;
  }
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "צריך להתחבר למערכת" });
    return;
  }
  next();
});

app.get("/api/whatsapp/config-status", (_req, res) => {
  const provider = whatsappProvider();
  res.json({
    ready: hasWhatsappConfig(),
    provider,
    phoneNumberId: maskValue(process.env.WHATSAPP_PHONE_NUMBER_ID),
    twilioAccountSid: maskValue(process.env.TWILIO_ACCOUNT_SID),
    twilioFrom: process.env.TWILIO_WHATSAPP_FROM || "",
    graphVersion: whatsappGraphVersion(),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
    canSendMediaByLink: Boolean(process.env.PUBLIC_BASE_URL),
    requiredEnv: provider === "twilio"
      ? ["WHATSAPP_PROVIDER=twilio", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"]
      : ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN"],
    optionalEnv: ["WHATSAPP_GRAPH_VERSION", "PUBLIC_BASE_URL"]
  });
});

app.get("/api/whatsapp/campaigns", (_req, res) => {
  res.json(readCampaignStore());
});

app.get("/api/hardware/catalog", (_req, res) => {
  res.json(readHardwareCatalog());
});

app.put("/api/hardware/catalog", (req, res) => {
  const incoming = normalizeHardwareCatalog(req.body);
  writeHardwareCatalog(incoming);
  res.json(incoming);
});

app.get("/api/suppliers/config", (_req, res) => {
  res.json(maskSupplierConfig(readSupplierConfig()));
});

app.put("/api/suppliers/config", (req, res) => {
  const current = readSupplierConfig();
  const next = normalizeSupplierConfig(req.body, current);
  writeSupplierConfig(next);
  res.json(maskSupplierConfig(next));
});

app.post("/api/suppliers/fetch-prices", async (req, res) => {
  try {
    const config = readSupplierConfig();
    const supplierId = String(req.body.supplierId || "morlevi");
    const segment = String(req.body.segment || "memory");
    const supplier = config.suppliers.find((item) => item.id === supplierId);
    if (!supplier) {
      res.status(404).json({ error: "הספק לא נמצא בהגדרות" });
      return;
    }
    if (!supplier.enabled) {
      res.status(400).json({ error: "הספק לא פעיל כרגע" });
      return;
    }
    if (!supplier.username || !supplier.password) {
      res.status(400).json({ error: "חסר שם משתמש או סיסמה לספק" });
      return;
    }
    const capabilities = supplierCapabilities(supplier);
    if (!capabilities.implemented.includes(segment)) {
      res.status(501).json({ error: `${supplier.label} מוגדר במערכת, אבל אין עדיין חיבור שליפה אוטומטי עבור ${segmentLabel(segment)}` });
      return;
    }

    const result = supplier.adapter === "morlevi"
      ? await fetchMorLeviPrices(supplier, segment)
      : supplier.adapter === "crg"
        ? await fetchCrgPrices(supplier, segment)
        : null;
    if (!result) {
      res.status(501).json({ error: `${supplier.label} מוגדר במערכת, אבל מתאם השליפה שלו עדיין לא מומש` });
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "שליפת המחירים נכשלה" });
  }
});

app.post("/api/whatsapp/contacts/parse", upload.single("contacts"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Contact file is required" });
    return;
  }

  const raw = fs.readFileSync(req.file.path, "utf8").replace(/^\uFEFF/, "");
  const defaultCountry = String(req.body.defaultCountry || "972");
  const contacts = parseContacts(raw, defaultCountry);
  res.json({
    filename: req.file.originalname,
    totalRows: raw.split(/\r?\n/).filter(Boolean).length,
    contacts,
    skipped: Math.max(0, raw.split(/\r?\n/).filter(Boolean).length - contacts.length)
  });
});

app.post("/api/whatsapp/media", upload.single("media"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Media file is required" });
    return;
  }

  const relativeUrl = `/uploads/${encodeURIComponent(req.file.filename)}`;
  res.status(201).json({
    id: nanoid(10),
    originalName: req.file.originalname,
    filename: req.file.filename,
    mimeType: req.file.mimetype,
    size: req.file.size,
    mediaKind: whatsappMediaKind(req.file.mimetype),
    url: relativeUrl,
    publicUrl: process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}${relativeUrl}` : ""
  });
});

app.post("/api/whatsapp/campaigns", (req, res) => {
  const store = readCampaignStore();
  const contacts = normalizeCampaignContacts(req.body.contacts);
  if (!contacts.length) {
    res.status(400).json({ error: "At least one opted-in contact is required" });
    return;
  }

  const campaign = {
    id: nanoid(12),
    name: String(req.body.name || "קמפיין חדש").trim().slice(0, 120),
    mode: req.body.mode === "template" ? "template" : "session",
    message: String(req.body.message || "").trim().slice(0, 4096),
    templateName: String(req.body.templateName || "").trim(),
    templateLanguage: String(req.body.templateLanguage || "he").trim(),
    templateVariables: Array.isArray(req.body.templateVariables) ? req.body.templateVariables.map((item) => String(item)) : [],
    media: normalizeMedia(req.body.media),
    contacts,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "draft",
    stats: { queued: contacts.length, sent: 0, failed: 0, skipped: 0 },
    results: []
  };

  if (campaign.mode === "template" && !campaign.templateName) {
    res.status(400).json({ error: "Template name is required for marketing/template campaigns" });
    return;
  }
  if (campaign.mode === "session" && !campaign.message && !campaign.media?.url) {
    res.status(400).json({ error: "Message or media is required" });
    return;
  }

  store.campaigns.unshift(campaign);
  writeCampaignStore(store);
  res.status(201).json(campaign);
});

app.post("/api/whatsapp/campaigns/:campaignId/send", async (req, res) => {
  const store = readCampaignStore();
  const campaign = store.campaigns.find((item) => item.id === req.params.campaignId);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  const dryRun = req.body.dryRun === true;
  if (!dryRun && !hasWhatsappConfig()) {
    res.status(400).json({ error: missingWhatsappConfigMessage() });
    return;
  }
  if (!dryRun && campaign.media?.url && !campaign.media.publicUrl && !process.env.PUBLIC_BASE_URL) {
    res.status(400).json({ error: "PUBLIC_BASE_URL is required to send media by link" });
    return;
  }

  campaign.status = dryRun ? "tested" : "sending";
  campaign.updatedAt = new Date().toISOString();
  campaign.results = [];
  campaign.stats = { queued: campaign.contacts.length, sent: 0, failed: 0, skipped: 0 };
  writeCampaignStore(store);

  for (const contact of campaign.contacts) {
    if (!contact.optIn) {
      campaign.stats.skipped += 1;
      campaign.results.push({ phone: contact.phone, status: "skipped", reason: "missing opt-in" });
      continue;
    }

    try {
      const result = dryRun ? { dryRun: true, to: contact.phone } : await sendWhatsappCampaignMessage(campaign, contact);
      campaign.stats.sent += 1;
      campaign.results.push({ phone: contact.phone, name: contact.name, status: dryRun ? "dry-run" : "sent", response: result });
    } catch (error) {
      campaign.stats.failed += 1;
      campaign.results.push({ phone: contact.phone, name: contact.name, status: "failed", reason: error.message });
    }

    campaign.updatedAt = new Date().toISOString();
    writeCampaignStore(store);
    if (!dryRun) await delay(Number(process.env.WHATSAPP_SEND_DELAY_MS || 900));
  }

  campaign.status = dryRun ? "tested" : "completed";
  campaign.updatedAt = new Date().toISOString();
  writeCampaignStore(store);
  res.json(campaign);
});

app.get("/api/rooms", (_req, res) => {
  res.json({ rooms: readDb().rooms });
});

app.put("/api/rooms/:roomId", (req, res) => {
  const db = readDb();
  const index = db.rooms.findIndex((item) => item.id === req.params.roomId);
  if (index === -1) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  db.rooms[index] = {
    ...db.rooms[index],
    name: req.body.name || db.rooms[index].name,
    floor: req.body.floor || db.rooms[index].floor,
    zone: req.body.zone || db.rooms[index].zone,
    capacity: Number(req.body.capacity || db.rooms[index].capacity),
    email: req.body.email || db.rooms[index].email,
    sicpHost: req.body.sicpHost || db.rooms[index].sicpHost,
    ledSettings: normalizeLedSettings(req.body.ledSettings, db.rooms[index].ledSettings),
    amenities: normalizeAmenities(req.body.amenities, db.rooms[index].amenities)
  };
  writeDb(db);
  broadcastRoomUpdate(req.params.roomId, "room");
  res.json(db.rooms[index]);
});

app.get("/api/rooms/:roomId/status", async (req, res) => {
  try {
    const status = await roomStatus(req.params.roomId);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message || "Room status failed" });
  }
});

app.post("/api/rooms/:roomId/display-heartbeat", (req, res) => {
  const db = readDb();
  const room = db.rooms.find((item) => item.id === req.params.roomId);
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  const detectedIp = normalizeRemoteIp(req.ip || req.socket.remoteAddress || "");
  const userAgent = req.get("user-agent") || "";
  const isDisplayClient = req.body.displayClient === true || userAgent.includes("10BDL5051T");
  if (!isDisplayClient) {
    res.json({ ok: true, ignored: true, reason: "not-display-client", detectedIp, sicpHost: room.sicpHost || "" });
    return;
  }

  room.display = {
    ip: detectedIp,
    userAgent,
    lastSeen: new Date().toISOString()
  };
  const usableDetectedIp = usableDisplayIp(detectedIp);
  room.sicpHost = req.body.sicpHost || room.sicpHost || usableDetectedIp;
  writeDb(db);
  res.json({ ok: true, display: room.display, sicpHost: room.sicpHost, sicpPort });
});

app.get("/api/rooms/:roomId/stream", (req, res) => {
  const roomId = req.params.roomId;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders?.();

  const clients = roomStreams.get(roomId) || new Set();
  const client = { res };
  clients.add(client);
  roomStreams.set(roomId, clients);

  sendStreamMessage(res, "connected", { roomId, at: new Date().toISOString() });
  const heartbeat = setInterval(() => {
    sendStreamMessage(res, "heartbeat", { roomId, at: new Date().toISOString() });
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(client);
    if (!clients.size) roomStreams.delete(roomId);
  });
});

app.post("/api/rooms/:roomId/book", async (req, res) => {
  try {
    const durationMinutes = Math.max(15, Math.min(240, Number(req.body.durationMinutes || 30)));
    const subject = String(req.body.subject || "פגישה מהירה").slice(0, 120);
    const result = await bookRoom(req.params.roomId, { durationMinutes, subject });
    res.status(201).json(result);
  } catch (error) {
    res.status(409).json({ error: error.message || "Booking failed" });
  }
});

app.get("/api/rooms/:roomId/events", (req, res) => {
  const db = readDb();
  res.json({ events: db.events.filter((event) => event.roomId === req.params.roomId) });
});

app.put("/api/rooms/:roomId/events", (req, res) => {
  const db = readDb();
  const incoming = Array.isArray(req.body.events) ? req.body.events : [];
  db.events = [
    ...db.events.filter((event) => event.roomId !== req.params.roomId),
    ...incoming.map((event, index) => ({
      id: event.id || `manual-${Date.now()}-${index}`,
      roomId: req.params.roomId,
      subject: event.subject || "פגישה",
      start: event.start,
      end: event.end,
      organizer: event.organizer || "Admin"
    }))
  ];
  writeDb(db);
  broadcastRoomUpdate(req.params.roomId, "events");
  res.json({ events: db.events.filter((event) => event.roomId === req.params.roomId) });
});

app.post("/api/rooms/:roomId/led", async (req, res) => {
  const db = readDb();
  const room = db.rooms.find((item) => item.id === req.params.roomId);
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  room.ledSettings = normalizeLedSettings(req.body, room.ledSettings);
  const led = resolveLedState(room.ledSettings, "free");
  db.led[req.params.roomId] = led;
  writeDb(db);
  await syncLed(req.params.roomId, led);
  broadcastRoomUpdate(req.params.roomId, "led");
  res.json({ ok: true, led });
});

async function roomStatus(roomId) {
  const db = readDb();
  const room = db.rooms.find((item) => item.id === roomId) || db.rooms[0];
  const now = new Date();
  const events = await getEvents(room, startOfToday(now), endOfToday(now));
  const sorted = events.sort((a, b) => new Date(a.start) - new Date(b.start));
  const currentEvent = sorted.find((event) => new Date(event.start) <= now && new Date(event.end) > now);
  const next = sorted.find((event) => new Date(event.start) > now);
  const status = currentEvent ? "busy" : "free";
  const led = resolveLedState(room.ledSettings, status);

  db.led[room.id] = led;
  writeDb(db);
  await syncLed(room.id, led);

  return {
    room,
    now: now.toISOString(),
    source: hasGraphConfig() ? "exchange" : "local-demo",
    current: currentEvent ? { status, ...currentEvent } : { status: "free", start: now.toISOString(), end: next?.start || endOfToday(now).toISOString() },
    next,
    timeline: buildTimeline(sorted, now),
    led
  };
}

async function bookRoom(roomId, booking) {
  const db = readDb();
  const room = db.rooms.find((item) => item.id === roomId) || db.rooms[0];
  const now = roundUpToNextFive(new Date());
  const end = new Date(now.getTime() + booking.durationMinutes * 60000);
  const events = await getEvents(room, now, end);
  const overlap = events.find((event) => new Date(event.start) < end && new Date(event.end) > now);
  if (overlap) throw new Error(`החדר תפוס עד ${new Date(overlap.end).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}`);

  if (hasGraphConfig()) {
    const graphEvent = await createGraphEvent(room, {
      subject: booking.subject,
      start: now,
      end
    });
    broadcastRoomUpdate(room.id, "booking");
    return { ok: true, event: graphEvent, source: "exchange" };
  }

  const event = {
    id: `local-${Date.now()}`,
    roomId: room.id,
    subject: booking.subject,
    start: now.toISOString(),
    end: end.toISOString(),
    organizer: "Room panel"
  };
  db.events.push(event);
  writeDb(db);
  broadcastRoomUpdate(room.id, "booking");
  return { ok: true, event, source: "local-demo" };
}

async function getEvents(room, from, to) {
  if (hasGraphConfig()) return getGraphEvents(room, from, to);
  return readDb().events
    .filter((event) => event.roomId === room.id)
    .filter((event) => new Date(event.start) < to && new Date(event.end) > from);
}

async function getGraphEvents(room, from, to) {
  const token = await graphToken();
  const url = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(room.email)}/calendarView`);
  url.searchParams.set("startDateTime", from.toISOString());
  url.searchParams.set("endDateTime", to.toISOString());
  url.searchParams.set("$select", "id,subject,start,end,organizer");
  url.searchParams.set("$orderby", "start/dateTime");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: `outlook.timezone="${timeZone}"`
    }
  });
  if (!response.ok) throw new Error(`Exchange read failed: ${response.status}`);
  const data = await response.json();
  return (data.value || []).map((event) => ({
    id: event.id,
    roomId: room.id,
    subject: event.subject || "פגישה",
    start: graphDate(event.start),
    end: graphDate(event.end),
    organizer: event.organizer?.emailAddress?.name || ""
  }));
}

async function createGraphEvent(room, event) {
  const token = await graphToken();
  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(room.email)}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      subject: event.subject,
      start: { dateTime: event.start.toISOString(), timeZone },
      end: { dateTime: event.end.toISOString(), timeZone },
      location: { displayName: room.name }
    })
  });
  if (!response.ok) throw new Error(`Exchange booking failed: ${response.status}`);
  return response.json();
}

async function graphToken() {
  const tenant = process.env.MS_TENANT_ID;
  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });
  const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`Microsoft auth failed: ${response.status}`);
  const data = await response.json();
  return data.access_token;
}

function hasGraphConfig() {
  return Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.EXCHANGE_ROOM_EMAIL);
}

function normalizeAmenities(incoming, fallback) {
  if (!Array.isArray(incoming)) return fallback;
  return incoming
    .filter((item) => item && item.label)
    .map((item, index) => ({
      id: item.id || `amenity-${Date.now()}-${index}`,
      kind: item.kind || "display",
      label: String(item.label).slice(0, 80)
    }));
}

function normalizeLedSettings(incoming = {}, fallback = {}) {
  const mode = incoming.mode === "manual" ? "manual" : "auto";
  return {
    mode,
    enabled: incoming.enabled === false ? false : true,
    color: normalizeHexColor(incoming.color || fallback.color || "#00ff00")
  };
}

function resolveLedState(settings = {}, roomStatus = "free") {
  const normalized = normalizeLedSettings(settings);
  const autoColor = roomStatus === "busy" ? "#ff0000" : "#00ff00";
  const color = normalized.mode === "manual" ? normalized.color : autoColor;
  return {
    enabled: normalized.enabled,
    color,
    colorName: colorName(color),
    mode: normalized.mode,
    updatedAt: new Date().toISOString()
  };
}

function normalizeHexColor(value = "#00ff00") {
  const raw = String(value).trim().toLowerCase();
  const match = raw.match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toLowerCase()}` : "#00ff00";
}

function colorName(hex) {
  if (hex === "#ff0000") return "red";
  if (hex === "#00ff00") return "green";
  return "custom";
}

function broadcastRoomUpdate(roomId, reason) {
  const clients = roomStreams.get(roomId);
  if (!clients?.size) return;
  const payload = { roomId, reason, at: new Date().toISOString() };
  for (const client of clients) {
    sendStreamMessage(client.res, "room:update", payload);
  }
}

function sendStreamMessage(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function syncLed(roomId, led) {
  if (process.env.LED_WEBHOOK_URL) {
    await fetch(process.env.LED_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, ...led })
    }).catch(() => {});
  }

  const db = readDb();
  const room = db.rooms.find((item) => item.id === roomId);
  const host = process.env.SICP_HOST || firstUsableSicpHost(room?.sicpHost, room?.display?.ip);
  if (host) {
    await sendSicpLed(host, led).catch((error) => {
      console.warn(`SICP LED update failed for ${host}:${sicpPort}`, error.message);
    });
  } else {
    console.warn(`SICP LED update skipped for ${roomId}: no display IP configured`);
  }
}

function sendSicpLed(host, led) {
  const rgb = led.enabled === false ? [0x00, 0x00, 0x00] : hexToRgb(led.color);
  const payload = [0x09, 0x01, 0x00, 0xf3, led.enabled === false ? 0x00 : 0x01, ...rgb];
  const checksum = payload.reduce((xor, value) => xor ^ value, 0);
  const command = Buffer.from([...payload, checksum]);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: sicpPort, timeout: 2500 }, () => {
      socket.write(command);
      socket.end();
    });
    socket.once("close", resolve);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
    socket.once("error", reject);
  });
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex).slice(1);
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ];
}

function normalizeRemoteIp(value) {
  return String(value).replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");
}

function usableDisplayIp(value) {
  const ip = normalizeRemoteIp(value);
  if (!ip || ["127.0.0.1", "::1"].includes(ip)) return "";
  if (localIps().includes(ip)) return "";
  return ip;
}

function firstUsableSicpHost(...values) {
  for (const value of values) {
    const ip = usableDisplayIp(value);
    if (ip) return ip;
  }
  return "";
}

function buildTimeline(events, now) {
  const dayEnd = endOfToday(now);
  const upcoming = events.filter((event) => new Date(event.end) > now);
  const slots = [];
  let cursor = new Date(now);

  for (const event of upcoming) {
    const start = new Date(event.start);
    const end = new Date(event.end);
    if (start > cursor) {
      slots.push({ status: "free", start: cursor.toISOString(), end: start.toISOString(), subject: "פנוי" });
    }
    slots.push({ status: "busy", ...event });
    cursor = end > cursor ? end : cursor;
    if (slots.length >= 8) break;
  }

  if (slots.length < 8 && cursor < dayEnd) {
    slots.push({ status: "free", start: cursor.toISOString(), end: dayEnd.toISOString(), subject: "פנוי" });
  }

  return slots.slice(0, 8);
}

function startOfToday(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function endOfToday(date) {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
}

function roundUpToNextFive(date) {
  const value = new Date(date);
  value.setSeconds(0, 0);
  const minutes = value.getMinutes();
  value.setMinutes(minutes + ((5 - (minutes % 5)) % 5));
  return value;
}

function graphDate(value) {
  if (!value?.dateTime) return new Date().toISOString();
  return new Date(value.dateTime.endsWith("Z") ? value.dateTime : `${value.dateTime}Z`).toISOString();
}

function localIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === "IPv4" && !net.internal)
    .map((net) => net.address);
}

function localAddresses(protocol = "http", selectedPort = port) {
  return localIps().map((address) => `${protocol}://${address}:${selectedPort}`);
}

function readCampaignStore() {
  if (!fs.existsSync(campaignsPath)) {
    writeCampaignStore({ campaigns: [] });
  }
  return JSON.parse(fs.readFileSync(campaignsPath, "utf8").replace(/^\uFEFF/, ""));
}

function writeCampaignStore(store) {
  fs.writeFileSync(campaignsPath, JSON.stringify({ campaigns: store.campaigns || [] }, null, 2));
}

function readHardwareCatalog() {
  if (!fs.existsSync(hardwareCatalogPath)) {
    writeHardwareCatalog({ updatedAt: new Date().toISOString(), sources: [], items: [] });
  }
  const base = JSON.parse(fs.readFileSync(hardwareCatalogPath, "utf8").replace(/^\uFEFF/, ""));
  const extra = fs.existsSync(hardwareCatalogExtraPath)
    ? JSON.parse(fs.readFileSync(hardwareCatalogExtraPath, "utf8").replace(/^\uFEFF/, ""))
    : { items: [] };
  const byId = new Map();
  for (const item of [...(base.items || []), ...generatedHardwareItems(), ...(extra.items || [])]) {
    byId.set(item.id, withPartNumber(item));
  }
  return {
    ...base,
    updatedAt: maxIsoDate(base.updatedAt, extra.updatedAt),
    items: [...byId.values()].sort(sortHardwareItem)
  };
}

function writeHardwareCatalog(catalog) {
  fs.writeFileSync(hardwareCatalogPath, JSON.stringify(catalog, null, 2));
}

function normalizeHardwareCatalog(catalog) {
  const allowedTypes = new Set(["motherboard", "cpu", "gpu", "memory"]);
  return {
    updatedAt: new Date().toISOString(),
    sources: Array.isArray(catalog.sources) ? catalog.sources.slice(0, 20).map((source) => ({
      label: String(source.label || "").slice(0, 120),
      url: String(source.url || "").slice(0, 500)
    })) : [],
    items: Array.isArray(catalog.items) ? catalog.items
      .filter((item) => item && allowedTypes.has(item.type))
      .slice(0, 2000)
      .map((item) => ({
        ...item,
        id: String(item.id || nanoid(10)).slice(0, 80),
        type: item.type,
        brand: String(item.brand || "").slice(0, 80),
        model: String(item.model || "").slice(0, 180)
      })) : []
  };
}

function withPartNumber(item) {
  if (item.partNumber) return item;
  if (item.type === "motherboard") return { ...item, partNumber: asusBoardPartNumber(item.model) };
  if (item.type === "gpu") return { ...item, partNumber: asusGpuPartNumber(item.series || "ASUS", item.gpuChip || item.model) };
  if (item.type === "cpu") return { ...item, partNumber: intelCpuPartNumber(item.model) };
  if (item.type === "memory") {
    const kitMatch = String(item.kit || "").match(/(\d+)x(\d+)GB/i);
    const count = kitMatch ? Number(kitMatch[1]) : item.moduleCount || 1;
    const moduleGb = kitMatch ? Number(kitMatch[2]) : item.moduleCapacityGb || item.capacityGb || "";
    return { ...item, partNumber: kingstonMemoryPartNumber(item.series || "Kingston", item.speedMt || "", moduleGb, count, item.memoryType || "") };
  }
  return item;
}

function maxIsoDate(...values) {
  return values.filter(Boolean).sort().at(-1) || new Date().toISOString();
}

function sortHardwareItem(a, b) {
  const typeOrder = { motherboard: 0, cpu: 1, gpu: 2, memory: 3 };
  return (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9)
    || String(a.brand).localeCompare(String(b.brand))
    || String(a.series || "").localeCompare(String(b.series || ""))
    || String(a.model).localeCompare(String(b.model));
}

function generatedHardwareItems() {
  return [
    ...generateAsusMotherboards(),
    ...generateAsusGraphicsCards(),
    ...generateIntelProcessors(),
    ...generateKingstonMemoryKits()
  ];
}

function generateAsusMotherboards() {
  const boards = [
    ["ROG MAXIMUS Z890 EXTREME", "ROG Maximus", "LGA1851", "Intel Z890", "E-ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["ROG MAXIMUS Z890 APEX", "ROG Maximus", "LGA1851", "Intel Z890", "ATX", ["DDR5", "CUDIMM"], 2, 96, "PCIe 5.0 x16"],
    ["ROG MAXIMUS Z890 HERO", "ROG Maximus", "LGA1851", "Intel Z890", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["ROG MAXIMUS Z890 HERO BTF", "ROG Maximus", "LGA1851", "Intel Z890", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX Z890-E GAMING WIFI", "ROG Strix", "LGA1851", "Intel Z890", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX Z890-F GAMING WIFI", "ROG Strix", "LGA1851", "Intel Z890", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX Z890-A GAMING WIFI", "ROG Strix", "LGA1851", "Intel Z890", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX Z890-H GAMING WIFI", "ROG Strix", "LGA1851", "Intel Z890", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX Z890-I GAMING WIFI", "ROG Strix", "LGA1851", "Intel Z890", "Mini-ITX", ["DDR5", "CUDIMM"], 2, 96, "PCIe 5.0 x16"],
    ["ProArt Z890-CREATOR WIFI", "ProArt", "LGA1851", "Intel Z890", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["TUF GAMING Z890-PRO WIFI", "TUF Gaming", "LGA1851", "Intel Z890", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["TUF GAMING Z890-PLUS WIFI", "TUF Gaming", "LGA1851", "Intel Z890", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["PRIME Z890-P WIFI", "Prime", "LGA1851", "Intel Z890", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["PRIME Z890-P", "Prime", "LGA1851", "Intel Z890", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["PRIME Z890M-PLUS WIFI", "Prime", "LGA1851", "Intel Z890", "Micro-ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX B860-F GAMING WIFI", "ROG Strix", "LGA1851", "Intel B860", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX B860-A GAMING WIFI", "ROG Strix", "LGA1851", "Intel B860", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX B860-G GAMING WIFI", "ROG Strix", "LGA1851", "Intel B860", "Micro-ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX B860-I GAMING WIFI", "ROG Strix", "LGA1851", "Intel B860", "Mini-ITX", ["DDR5", "CUDIMM"], 2, 96, "PCIe 5.0 x16"],
    ["TUF GAMING B860-PLUS WIFI", "TUF Gaming", "LGA1851", "Intel B860", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["TUF GAMING B860M-PLUS WIFI", "TUF Gaming", "LGA1851", "Intel B860", "Micro-ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["TUF GAMING B860M-PLUS", "TUF Gaming", "LGA1851", "Intel B860", "Micro-ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["PRIME B860-PLUS WIFI", "Prime", "LGA1851", "Intel B860", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["PRIME B860-PLUS", "Prime", "LGA1851", "Intel B860", "ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 5.0 x16"],
    ["PRIME B860M-A WIFI", "Prime", "LGA1851", "Intel B860", "Micro-ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 4.0 x16"],
    ["PRIME B860M-A", "Prime", "LGA1851", "Intel B860", "Micro-ATX", ["DDR5", "CUDIMM"], 4, 192, "PCIe 4.0 x16"],
    ["PRIME B860M-K", "Prime", "LGA1851", "Intel B860", "Micro-ATX", ["DDR5", "CUDIMM"], 2, 96, "PCIe 4.0 x16"],
    ["PRIME H810M-A-CSM", "Prime CSM", "LGA1851", "Intel H810", "Micro-ATX", ["DDR5"], 2, 96, "PCIe 4.0 x16"],
    ["PRIME H810M-A WIFI", "Prime", "LGA1851", "Intel H810", "Micro-ATX", ["DDR5"], 2, 96, "PCIe 4.0 x16"],
    ["PRIME H810M-A", "Prime", "LGA1851", "Intel H810", "Micro-ATX", ["DDR5"], 2, 96, "PCIe 4.0 x16"],
    ["ROG MAXIMUS Z790 EXTREME", "ROG Maximus", "LGA1700", "Intel Z790", "E-ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["ROG MAXIMUS Z790 APEX", "ROG Maximus", "LGA1700", "Intel Z790", "ATX", ["DDR5"], 2, 96, "PCIe 5.0 x16"],
    ["ROG MAXIMUS Z790 HERO", "ROG Maximus", "LGA1700", "Intel Z790", "ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX Z790-E GAMING WIFI", "ROG Strix", "LGA1700", "Intel Z790", "ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX Z790-F GAMING WIFI", "ROG Strix", "LGA1700", "Intel Z790", "ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX Z790-A GAMING WIFI", "ROG Strix", "LGA1700", "Intel Z790", "ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX Z790-A GAMING WIFI D4", "ROG Strix", "LGA1700", "Intel Z790", "ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["ROG STRIX Z790-H GAMING WIFI", "ROG Strix", "LGA1700", "Intel Z790", "ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX Z790-I GAMING WIFI", "ROG Strix", "LGA1700", "Intel Z790", "Mini-ITX", ["DDR5"], 2, 96, "PCIe 5.0 x16"],
    ["ProArt Z790-CREATOR WIFI", "ProArt", "LGA1700", "Intel Z790", "ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["TUF GAMING Z790-PLUS WIFI", "TUF Gaming", "LGA1700", "Intel Z790", "ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["TUF GAMING Z790-PLUS WIFI D4", "TUF Gaming", "LGA1700", "Intel Z790", "ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["TUF GAMING Z790-PLUS D4", "TUF Gaming", "LGA1700", "Intel Z790", "ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["PRIME Z790-A WIFI", "Prime", "LGA1700", "Intel Z790", "ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["PRIME Z790-P WIFI", "Prime", "LGA1700", "Intel Z790", "ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["PRIME Z790-P", "Prime", "LGA1700", "Intel Z790", "ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["PRIME Z790M-PLUS", "Prime", "LGA1700", "Intel Z790", "Micro-ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["PRIME Z790-P WIFI D4", "Prime", "LGA1700", "Intel Z790", "ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["PRIME Z790-P D4", "Prime", "LGA1700", "Intel Z790", "ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["PRIME Z790M-PLUS D4", "Prime", "LGA1700", "Intel Z790", "Micro-ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["TUF GAMING H770-PRO WIFI", "TUF Gaming", "LGA1700", "Intel H770", "ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["PRIME H770-PLUS D4", "Prime", "LGA1700", "Intel H770", "ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["ROG STRIX B760-F GAMING WIFI", "ROG Strix", "LGA1700", "Intel B760", "ATX", ["DDR5"], 4, 192, "PCIe 5.0 x16"],
    ["ROG STRIX B760-A GAMING WIFI D4", "ROG Strix", "LGA1700", "Intel B760", "ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["ROG STRIX B760-G GAMING WIFI D4", "ROG Strix", "LGA1700", "Intel B760", "Micro-ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["ROG STRIX B760-I GAMING WIFI", "ROG Strix", "LGA1700", "Intel B760", "Mini-ITX", ["DDR5"], 2, 96, "PCIe 5.0 x16"],
    ["ProArt B760-CREATOR D4", "ProArt", "LGA1700", "Intel B760", "ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["TUF GAMING B760-PLUS WIFI D4", "TUF Gaming", "LGA1700", "Intel B760", "ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["TUF GAMING B760M-PLUS WIFI D4", "TUF Gaming", "LGA1700", "Intel B760", "Micro-ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["TUF GAMING B760M-PLUS D4", "TUF Gaming", "LGA1700", "Intel B760", "Micro-ATX", ["DDR4"], 4, 128, "PCIe 5.0 x16"],
    ["PRIME B760-PLUS D4", "Prime", "LGA1700", "Intel B760", "ATX", ["DDR4"], 4, 128, "PCIe 4.0 x16"],
    ["PRIME B760M-A WIFI D4", "Prime", "LGA1700", "Intel B760", "Micro-ATX", ["DDR4"], 4, 128, "PCIe 4.0 x16"],
    ["PRIME B760M-A D4", "Prime", "LGA1700", "Intel B760", "Micro-ATX", ["DDR4"], 4, 128, "PCIe 4.0 x16"],
    ["PRIME B760M-K D4", "Prime", "LGA1700", "Intel B760", "Micro-ATX", ["DDR4"], 2, 64, "PCIe 4.0 x16"]
  ];

  return boards.map(([model, series, socket, chipset, formFactor, memoryTypes, memorySlots, maxMemoryGb, pcieGpuSlot]) => ({
    id: `mb-asus-${slug(model)}`,
    type: "motherboard",
    brand: "ASUS",
    model,
    partNumber: asusBoardPartNumber(model),
    series,
    socket,
    chipset,
    memoryTypes,
    memorySlots,
    maxMemoryGb,
    formFactor,
    pcieGpuSlot,
    notes: "ASUS motherboard catalog option; verify exact regional availability and QVL before purchase."
  }));
}

function generateAsusGraphicsCards() {
  const chips = [
    ["GeForce RTX 5090", "32GB GDDR7", "PCIe 5.0 x16", 1000],
    ["GeForce RTX 5080", "16GB GDDR7", "PCIe 5.0 x16", 850],
    ["GeForce RTX 5070 Ti", "16GB GDDR7", "PCIe 5.0 x16", 750],
    ["GeForce RTX 5070", "12GB GDDR7", "PCIe 5.0 x16", 650],
    ["GeForce RTX 5060 Ti 16GB", "16GB GDDR7", "PCIe 5.0 x8", 650],
    ["GeForce RTX 5060", "8GB GDDR7", "PCIe 5.0 x8", 550],
    ["GeForce RTX 4090", "24GB GDDR6X", "PCIe 4.0 x16", 1000],
    ["GeForce RTX 4080 SUPER", "16GB GDDR6X", "PCIe 4.0 x16", 850],
    ["GeForce RTX 4070 Ti SUPER", "16GB GDDR6X", "PCIe 4.0 x16", 750],
    ["GeForce RTX 4070 SUPER", "12GB GDDR6X", "PCIe 4.0 x16", 650],
    ["GeForce RTX 4060 Ti 16GB", "16GB GDDR6", "PCIe 4.0 x8", 550],
    ["GeForce RTX 4060", "8GB GDDR6", "PCIe 4.0 x8", 550],
    ["GeForce RTX 3050", "8GB GDDR6", "PCIe 4.0 x8", 450],
    ["Radeon RX 7900 XTX", "24GB GDDR6", "PCIe 4.0 x16", 850],
    ["Radeon RX 7800 XT", "16GB GDDR6", "PCIe 4.0 x16", 750],
    ["Radeon RX 7600 XT", "16GB GDDR6", "PCIe 4.0 x8", 600]
  ];
  const seriesByChip = {
    "GeForce RTX 5090": ["ROG Matrix Platinum", "ROG Astral LC", "ROG Astral", "TUF Gaming"],
    "GeForce RTX 5080": ["ROG Astral", "ROG Strix", "TUF Gaming", "Prime"],
    "GeForce RTX 5070 Ti": ["ROG Strix", "TUF Gaming", "Prime"],
    "GeForce RTX 5070": ["TUF Gaming", "Prime", "Dual"],
    "GeForce RTX 5060 Ti 16GB": ["TUF Gaming", "Prime", "Dual"],
    "GeForce RTX 5060": ["Prime", "Dual"],
    "GeForce RTX 4090": ["ROG Strix", "TUF Gaming"],
    "GeForce RTX 4080 SUPER": ["ROG Strix", "TUF Gaming", "ProArt"],
    "GeForce RTX 4070 Ti SUPER": ["ROG Strix", "TUF Gaming", "ProArt"],
    "GeForce RTX 4070 SUPER": ["TUF Gaming", "Dual"],
    "GeForce RTX 4060 Ti 16GB": ["TUF Gaming", "Dual"],
    "GeForce RTX 4060": ["TUF Gaming", "Dual"],
    "GeForce RTX 3050": ["Dual", "Phoenix"],
    "Radeon RX 7900 XTX": ["TUF Gaming"],
    "Radeon RX 7800 XT": ["TUF Gaming", "Dual"],
    "Radeon RX 7600 XT": ["Dual"]
  };

  return chips.flatMap(([chip, memory, bus, recommendedPsuW]) => (seriesByChip[chip] || ["ASUS"]).map((series) => ({
    id: `gpu-asus-${slug(series)}-${slug(chip)}`,
    type: "gpu",
    brand: "ASUS",
    model: `${series} ${chip}${series.includes("ROG") || series.includes("TUF") ? " OC Edition" : ""}`,
    partNumber: asusGpuPartNumber(series, chip),
    series,
    gpuChip: chip,
    memory,
    bus,
    recommendedPsuW,
    powerConnector: chip.includes("RTX 50") ? "16-pin 12V-2x6" : chip.includes("RTX 40") ? "16-pin 12VHPWR / 8-pin by model" : "8-pin / 16-pin by model",
    outputs: "HDMI, DisplayPort",
    notes: "ASUS graphics card catalog option; confirm exact SKU length, slots and connector on the product page."
  })));
}

function generateIntelProcessors() {
  const cpus = [
    ["Core Ultra 9 285K", "Core Ultra 200S", "LGA1851", "24 cores: 8P + 16E", 24, 5.7, 125, 250, ["DDR5", "CUDIMM"], "Intel Graphics", true],
    ["Core Ultra 9 285", "Core Ultra 200S", "LGA1851", "24 cores: 8P + 16E", 24, 5.6, 65, 182, ["DDR5", "CUDIMM"], "Intel Graphics", false],
    ["Core Ultra 7 265K", "Core Ultra 200S", "LGA1851", "20 cores: 8P + 12E", 20, 5.5, 125, 250, ["DDR5", "CUDIMM"], "Intel Graphics", true],
    ["Core Ultra 7 265KF", "Core Ultra 200S", "LGA1851", "20 cores: 8P + 12E", 20, 5.5, 125, 250, ["DDR5", "CUDIMM"], "None", true],
    ["Core Ultra 7 265", "Core Ultra 200S", "LGA1851", "20 cores: 8P + 12E", 20, 5.3, 65, 182, ["DDR5", "CUDIMM"], "Intel Graphics", false],
    ["Core Ultra 5 245K", "Core Ultra 200S", "LGA1851", "14 cores: 6P + 8E", 14, 5.2, 125, 159, ["DDR5", "CUDIMM"], "Intel Graphics", true],
    ["Core Ultra 5 245KF", "Core Ultra 200S", "LGA1851", "14 cores: 6P + 8E", 14, 5.2, 125, 159, ["DDR5", "CUDIMM"], "None", true],
    ["Core Ultra 5 245", "Core Ultra 200S", "LGA1851", "14 cores: 6P + 8E", 14, 5.1, 65, 121, ["DDR5", "CUDIMM"], "Intel Graphics", false],
    ["Core Ultra 5 235", "Core Ultra 200S", "LGA1851", "14 cores", 14, 5.0, 65, 121, ["DDR5", "CUDIMM"], "Intel Graphics", false],
    ["Core Ultra 3 205", "Core Ultra 200S", "LGA1851", "8 cores", 8, 4.9, 57, 76, ["DDR5", "CUDIMM"], "Intel Graphics", false],
    ["Core i9-14900KS", "14th Gen Core", "LGA1700", "24 cores: 8P + 16E", 32, 6.2, 150, 253, ["DDR5", "DDR4"], "Intel UHD 770", true],
    ["Core i9-14900K", "14th Gen Core", "LGA1700", "24 cores: 8P + 16E", 32, 6.0, 125, 253, ["DDR5", "DDR4"], "Intel UHD 770", true],
    ["Core i9-14900KF", "14th Gen Core", "LGA1700", "24 cores: 8P + 16E", 32, 6.0, 125, 253, ["DDR5", "DDR4"], "None", true],
    ["Core i9-14900", "14th Gen Core", "LGA1700", "24 cores: 8P + 16E", 32, 5.8, 65, 219, ["DDR5", "DDR4"], "Intel UHD 770", false],
    ["Core i7-14700K", "14th Gen Core", "LGA1700", "20 cores: 8P + 12E", 28, 5.6, 125, 253, ["DDR5", "DDR4"], "Intel UHD 770", true],
    ["Core i7-14700KF", "14th Gen Core", "LGA1700", "20 cores: 8P + 12E", 28, 5.6, 125, 253, ["DDR5", "DDR4"], "None", true],
    ["Core i7-14700", "14th Gen Core", "LGA1700", "20 cores: 8P + 12E", 28, 5.4, 65, 219, ["DDR5", "DDR4"], "Intel UHD 770", false],
    ["Core i5-14600K", "14th Gen Core", "LGA1700", "14 cores: 6P + 8E", 20, 5.3, 125, 181, ["DDR5", "DDR4"], "Intel UHD 770", true],
    ["Core i5-14600KF", "14th Gen Core", "LGA1700", "14 cores: 6P + 8E", 20, 5.3, 125, 181, ["DDR5", "DDR4"], "None", true],
    ["Core i5-14500", "14th Gen Core", "LGA1700", "14 cores: 6P + 8E", 20, 5.0, 65, 154, ["DDR5", "DDR4"], "Intel UHD 770", false],
    ["Core i5-14400", "14th Gen Core", "LGA1700", "10 cores: 6P + 4E", 16, 4.7, 65, 148, ["DDR5", "DDR4"], "Intel UHD 730", false],
    ["Core i5-14400F", "14th Gen Core", "LGA1700", "10 cores: 6P + 4E", 16, 4.7, 65, 148, ["DDR5", "DDR4"], "None", false],
    ["Core i3-14100", "14th Gen Core", "LGA1700", "4 cores: 4P + 0E", 8, 4.7, 60, 110, ["DDR5", "DDR4"], "Intel UHD 730", false],
    ["Core i3-14100F", "14th Gen Core", "LGA1700", "4 cores: 4P + 0E", 8, 4.7, 58, 110, ["DDR5", "DDR4"], "None", false],
    ["Core i9-13900K", "13th Gen Core", "LGA1700", "24 cores: 8P + 16E", 32, 5.8, 125, 253, ["DDR5", "DDR4"], "Intel UHD 770", true],
    ["Core i9-13900KF", "13th Gen Core", "LGA1700", "24 cores: 8P + 16E", 32, 5.8, 125, 253, ["DDR5", "DDR4"], "None", true],
    ["Core i7-13700K", "13th Gen Core", "LGA1700", "16 cores: 8P + 8E", 24, 5.4, 125, 253, ["DDR5", "DDR4"], "Intel UHD 770", true],
    ["Core i5-13600K", "13th Gen Core", "LGA1700", "14 cores: 6P + 8E", 20, 5.1, 125, 181, ["DDR5", "DDR4"], "Intel UHD 770", true],
    ["Core i5-13400F", "13th Gen Core", "LGA1700", "10 cores: 6P + 4E", 16, 4.6, 65, 148, ["DDR5", "DDR4"], "None", false],
    ["Core i9-12900K", "12th Gen Core", "LGA1700", "16 cores: 8P + 8E", 24, 5.2, 125, 241, ["DDR5", "DDR4"], "Intel UHD 770", true],
    ["Core i7-12700K", "12th Gen Core", "LGA1700", "12 cores: 8P + 4E", 20, 5.0, 125, 190, ["DDR5", "DDR4"], "Intel UHD 770", true],
    ["Core i5-12600K", "12th Gen Core", "LGA1700", "10 cores: 6P + 4E", 16, 4.9, 125, 150, ["DDR5", "DDR4"], "Intel UHD 770", true]
  ];

  return cpus.map(([model, series, socket, cores, threads, maxBoostGhz, basePowerW, turboPowerW, memorySupport, integratedGraphics, unlocked]) => ({
    id: `cpu-intel-${slug(model)}`,
    type: "cpu",
    brand: "Intel",
    model,
    partNumber: intelCpuPartNumber(model),
    series,
    socket,
    cores,
    threads,
    maxBoostGhz,
    basePowerW,
    turboPowerW,
    memorySupport,
    integratedGraphics,
    unlocked,
    notes: "Intel desktop processor catalog option; check Intel ARK and motherboard CPU support list for exact stepping/BIOS support."
  }));
}

function generateKingstonMemoryKits() {
  const families = [
    { series: "FURY Renegade DDR5", memoryType: "DDR5", moduleType: "UDIMM", speeds: [6000, 6400, 6800, 7200, 7600, 8000, 8400], modules: [16, 24, 32, 48], counts: [1, 2, 4], profile: "Intel XMP 3.0", voltage: "1.35V-1.45V" },
    { series: "FURY Renegade DDR5 RGB", memoryType: "DDR5", moduleType: "UDIMM", speeds: [6000, 6400, 6800, 7200, 7600, 8000], modules: [16, 24, 32, 48], counts: [1, 2, 4], profile: "Intel XMP 3.0", voltage: "1.35V-1.45V" },
    { series: "FURY Renegade CUDIMM", memoryType: "CUDIMM", moduleType: "CUDIMM", speeds: [8000, 8400, 8800], modules: [24, 48], counts: [1, 2], profile: "Intel XMP 3.0", voltage: "1.4V-1.45V" },
    { series: "FURY Beast DDR5", memoryType: "DDR5", moduleType: "UDIMM", speeds: [5200, 5600, 6000, 6400, 6800], modules: [8, 16, 24, 32, 48, 64], counts: [1, 2, 4], profile: "Intel XMP 3.0 / Plug N Play", voltage: "1.25V-1.4V" },
    { series: "FURY Beast DDR5 RGB", memoryType: "DDR5", moduleType: "UDIMM", speeds: [5200, 5600, 6000, 6400, 6800], modules: [8, 16, 24, 32, 48, 64], counts: [1, 2, 4], profile: "Intel XMP 3.0 / Plug N Play", voltage: "1.25V-1.4V" },
    { series: "FURY Impact DDR5", memoryType: "DDR5", moduleType: "SODIMM", speeds: [4800, 5200, 5600, 6000, 6400], modules: [8, 16, 32, 64], counts: [1, 2], profile: "Plug N Play", voltage: "1.1V-1.35V" },
    { series: "FURY Beast DDR4", memoryType: "DDR4", moduleType: "UDIMM", speeds: [2666, 3000, 3200, 3600], modules: [8, 16, 32], counts: [1, 2, 4], profile: "Intel XMP", voltage: "1.2V-1.35V" },
    { series: "FURY Beast DDR4 RGB", memoryType: "DDR4", moduleType: "UDIMM", speeds: [2666, 3000, 3200, 3600], modules: [8, 16, 32], counts: [1, 2, 4], profile: "Intel XMP", voltage: "1.2V-1.35V" },
    { series: "ValueRAM DDR5", memoryType: "DDR5", moduleType: "UDIMM", speeds: [4800, 5200, 5600, 6000], modules: [8, 16, 32, 48, 64], counts: [1], profile: "JEDEC", voltage: "1.1V" },
    { series: "Server Premier DDR5 ECC", memoryType: "DDR5 ECC", moduleType: "ECC UDIMM/RDIMM by SKU", speeds: [4800, 5600, 6400], modules: [16, 32, 64, 96, 128], counts: [1], profile: "JEDEC", voltage: "1.1V" }
  ];

  return families.flatMap((family) => family.speeds.flatMap((speedMt) => family.modules.flatMap((moduleGb) => family.counts.map((count) => {
    const capacityGb = moduleGb * count;
    const kit = `${count}x${moduleGb}GB`;
    return {
      id: `ram-kingston-${slug(family.series)}-${speedMt}-${kit.toLowerCase()}`,
      type: "memory",
      brand: "Kingston",
      model: `${family.series} ${capacityGb}GB Kit ${speedMt}MT/s (${kit})`,
      partNumber: kingstonMemoryPartNumber(family.series, speedMt, moduleGb, count, family.memoryType),
      series: family.series,
      memoryType: family.memoryType,
      moduleType: family.moduleType,
      capacityGb,
      kit,
      moduleCount: count,
      moduleCapacityGb: moduleGb,
      speedMt,
      casLatency: speedMt >= 7600 ? "CL38-CL42" : speedMt >= 6000 ? "CL30-CL40" : "JEDEC / CL by SKU",
      voltage: family.voltage,
      profile: family.profile,
      notes: `${kit} Kingston memory option. Confirm exact part number, height and motherboard QVL before purchase.`
    };
  }))));
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function asusBoardPartNumber(model) {
  return String(model).toUpperCase().replace(/\s+/g, "-");
}

function asusGpuPartNumber(series, chip) {
  const seriesCode = {
    "ROG Matrix Platinum": "ROG-MATRIX",
    "ROG Astral LC": "ROG-ASTRAL-LC",
    "ROG Astral": "ROG-ASTRAL",
    "ROG Strix": "ROG-STRIX",
    "TUF Gaming": "TUF",
    "ProArt": "PROART",
    "Prime": "PRIME",
    "Dual": "DUAL",
    "Phoenix": "PH"
  }[series] || slug(series).toUpperCase();
  return `${seriesCode}-${gpuChipCode(chip)}${series.includes("ROG") || series.includes("TUF") ? "-O" : ""}`;
}

function gpuChipCode(chip) {
  return String(chip)
    .toUpperCase()
    .replace("GEFORCE ", "")
    .replace("RADEON ", "")
    .replace(/\s+/g, "-")
    .replace("RTX-", "RTX")
    .replace("RX-", "RX");
}

function intelCpuPartNumber(model) {
  const cleaned = String(model).replace(/^Core\s+/i, "");
  return `INTEL-${cleaned.toUpperCase().replace(/\s+/g, "-")}`;
}

function kingstonMemoryPartNumber(series, speedMt, moduleGb, count, memoryType) {
  const prefix = series.includes("Renegade CUDIMM") ? "KF5C"
    : series.includes("Renegade") ? "KF5R"
      : series.includes("Beast DDR5") ? "KF5B"
        : series.includes("Impact DDR5") ? "KF5I"
          : series.includes("Beast DDR4") ? "KF4B"
            : series.includes("ValueRAM") ? "KVR"
              : series.includes("Server Premier") ? "KSM"
                : memoryType.includes("DDR4") ? "KF4" : "KF5";
  const rgb = series.includes("RGB") ? "RGB" : "";
  const kitSuffix = count > 1 ? `K${count}` : "";
  const typeSuffix = memoryType.includes("ECC") ? "E" : memoryType === "CUDIMM" ? "C" : "";
  return `${prefix}${speedMt}${typeSuffix}${rgb}-${moduleGb}G${kitSuffix}`;
}

function parseContacts(raw, defaultCountry = "972") {
  const rows = raw
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  if (!rows.length) return [];

  const firstCells = splitDelimitedRow(rows[0]);
  const hasHeader = firstCells.some((cell) => /phone|mobile|טלפון|נייד|name|שם|opt/i.test(cell));
  const headers = hasHeader ? firstCells.map((cell) => cell.trim().toLowerCase()) : [];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const contacts = [];
  const seen = new Set();

  for (const row of dataRows) {
    const cells = splitDelimitedRow(row);
    const phoneValue = hasHeader ? cellByHeader(cells, headers, ["phone", "mobile", "טלפון", "נייד", "מספר"]) : cells[0];
    const phone = normalizePhone(phoneValue, defaultCountry);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);

    const name = hasHeader ? cellByHeader(cells, headers, ["name", "שם", "לקוח"]) : cells[1] || "";
    const optValue = hasHeader ? cellByHeader(cells, headers, ["optin", "opt_in", "consent", "אישור", "מאשר"]) : cells[2] || "yes";
    contacts.push({
      id: nanoid(8),
      phone,
      name: String(name || "").trim(),
      optIn: parseOptIn(optValue)
    });
  }

  return contacts;
}

function splitDelimitedRow(row) {
  const delimiter = row.includes("\t") ? "\t" : row.includes(";") ? ";" : ",";
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === '"' && row[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function cellByHeader(cells, headers, options) {
  for (const option of options) {
    const index = headers.findIndex((header) => header.includes(option.toLowerCase()));
    if (index >= 0) return cells[index] || "";
  }
  return "";
}

function normalizePhone(value, defaultCountry = "972") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `${defaultCountry}${digits.slice(1)}`;
  if (!/^\d{8,15}$/.test(digits)) return "";
  return digits;
}

function parseOptIn(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  return !["no", "false", "0", "לא", "לא מאשר", "n"].includes(normalized);
}

function normalizeCampaignContacts(contacts) {
  if (!Array.isArray(contacts)) return [];
  const seen = new Set();
  return contacts
    .map((contact) => ({
      id: contact.id || nanoid(8),
      phone: normalizePhone(contact.phone),
      name: String(contact.name || "").trim().slice(0, 120),
      optIn: contact.optIn !== false
    }))
    .filter((contact) => {
      if (!contact.phone || seen.has(contact.phone)) return false;
      seen.add(contact.phone);
      return true;
    });
}

function normalizeMedia(media) {
  if (!media?.url) return null;
  return {
    originalName: String(media.originalName || "media").slice(0, 160),
    mimeType: String(media.mimeType || "application/octet-stream"),
    mediaKind: whatsappMediaKind(media.mimeType),
    url: String(media.url),
    publicUrl: String(media.publicUrl || "")
  };
}

function isAuthenticated(req) {
  const token = authToken(req);
  if (!token) return false;
  const session = authSessions.get(token);
  if (!session) return false;
  const maxAgeMs = 12 * 60 * 60 * 1000;
  if (Date.now() - session.createdAt > maxAgeMs) {
    authSessions.delete(token);
    return false;
  }
  session.lastSeenAt = Date.now();
  return true;
}

function authToken(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies.ecc_price_auth || "";
}

function parseCookies(header) {
  return String(header || "").split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index <= 0) return cookies;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

function buildAuthCookie(req, token, maxAge = 12 * 60 * 60) {
  const secure = req.secure || req.get("x-forwarded-proto") === "https";
  return [
    `ecc_price_auth=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

function defaultSupplierConfig() {
  return {
    suppliers: [
      {
        id: "morlevi",
        label: "מור לוי",
        adapter: "morlevi",
        baseUrl: "https://www.morlevi.co.il",
        loginUrl: "https://www.morlevi.co.il/User/Login",
        username: "shuchz@gmail.com",
        password: process.env.MORLEVI_PASSWORD || "",
        enabled: true,
        segments: {
          memory: ["/Cat/149"],
          gpu: ["/Cat/82"],
          cpu: ["/Cat/32", "/Cat/33"]
        }
      },
      {
        id: "cms",
        label: "CMS",
        adapter: "",
        baseUrl: "https://cms.co.il",
        loginUrl: "",
        username: "",
        password: "",
        enabled: false,
        segments: { memory: [], gpu: [], cpu: [] }
      },
      {
        id: "crg",
        label: "CRG",
        adapter: "crg",
        baseUrl: "https://cre.mycloud.co.il",
        loginUrl: "https://cre.mycloud.co.il/system/login",
        username: "Nati.David@easx.co.il",
        password: process.env.CRG_PASSWORD || "",
        enabled: true,
        segments: { memory: [], gpu: [], cpu: [] }
      }
    ]
  };
}

function readSupplierConfig() {
  if (!fs.existsSync(supplierConfigPath)) writeSupplierConfig(defaultSupplierConfig());
  const parsed = JSON.parse(fs.readFileSync(supplierConfigPath, "utf8").replace(/^\uFEFF/, ""));
  return normalizeSupplierConfig(parsed, defaultSupplierConfig());
}

function writeSupplierConfig(config) {
  fs.writeFileSync(supplierConfigPath, JSON.stringify(config, null, 2));
  return config;
}

function normalizeSupplierConfig(incoming, fallback = defaultSupplierConfig()) {
  const fallbackById = new Map((fallback.suppliers || []).map((supplier) => [supplier.id, supplier]));
  const supplierIds = ["morlevi", "cms", "crg"];
  const incomingById = new Map((incoming.suppliers || []).map((supplier) => [supplier.id, supplier]));
  return {
    suppliers: supplierIds.map((id) => {
      const base = fallbackById.get(id) || {};
      const item = incomingById.get(id) || {};
      return {
        id,
        label: String(item.label || base.label || id),
        adapter: String(item.adapter ?? base.adapter ?? "").trim(),
        baseUrl: String(item.baseUrl ?? base.baseUrl ?? "").trim(),
        loginUrl: String(item.loginUrl ?? base.loginUrl ?? "").trim(),
        username: String(item.username ?? base.username ?? "").trim(),
        password: item.password === "__KEEP__" ? String(base.password || "") : String(item.password ?? base.password ?? ""),
        enabled: item.enabled ?? base.enabled ?? false,
        segments: normalizeSupplierSegments(item.segments || base.segments)
      };
    })
  };
}

function normalizeSupplierSegments(segments = {}) {
  return {
    memory: normalizeUrlList(segments.memory),
    gpu: normalizeUrlList(segments.gpu),
    cpu: normalizeUrlList(segments.cpu)
  };
}

function normalizeUrlList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function maskSupplierConfig(config) {
  return {
    suppliers: config.suppliers.map((supplier) => ({
      ...supplier,
      password: "",
      hasPassword: Boolean(supplier.password),
      capabilities: supplierCapabilities(supplier)
    }))
  };
}

function supplierCapabilities(supplier) {
  const implemented = {
    morlevi: ["memory", "gpu", "cpu"],
    crg: ["memory", "gpu", "cpu"]
  }[supplier.adapter] || [];
  return {
    implemented,
    canFetch: implemented.length > 0,
    note: implemented.length
      ? "חיבור שליפה פעיל"
      : "פרטי הספק שמורים, אבל חיבור השליפה האוטומטי עדיין לא מומש"
  };
}

function segmentLabel(segment) {
  return {
    memory: "זיכרונות",
    gpu: "כרטיסי מסך",
    cpu: "מעבדים"
  }[segment] || segment;
}

async function fetchMorLeviPrices(supplier, segment) {
  const baseUrl = supplier.baseUrl.replace(/\/+$/, "") || "https://www.morlevi.co.il";
  const cookieJar = new Map();
  const loginPage = await supplierFetch(`${baseUrl}/User/Login`, { cookieJar });
  const loginHtml = await loginPage.text();
  const token = firstMatch(loginHtml, /name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/i)
    || firstMatch(loginHtml, /value="([^"]+)"\s+name="__RequestVerificationToken"/i);
  if (!token) throw new Error("לא נמצא אסימון התחברות במור לוי");

  const loginBody = new URLSearchParams({
    Email: supplier.username,
    Password: supplier.password,
    returnUrl: "",
    __RequestVerificationToken: token
  });
  const loginResponse = await supplierFetch(`${baseUrl}/loginpost`, {
    method: "POST",
    cookieJar,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: loginBody
  });
  const loginResult = await loginResponse.json().catch(() => ({}));
  if (!loginResponse.ok || loginResult.success !== true) {
    throw new Error(loginResult.message || "התחברות למור לוי נכשלה");
  }

  const urls = supplier.segments?.[segment] || [];
  if (!urls.length) throw new Error("לא הוגדרו כתובות לסגמנט שנבחר");

  const products = [];
  const seen = new Set();
  for (const segmentUrl of urls) {
    const pageUrls = await morLeviPageUrls(baseUrl, segmentUrl, cookieJar);
    for (const pageUrl of pageUrls) {
      const response = await supplierFetch(pageUrl, { cookieJar });
      const html = await response.text();
      for (const product of parseMorLeviProducts(html, baseUrl, segment)) {
        if (seen.has(product.id)) continue;
        seen.add(product.id);
        products.push(product);
      }
    }
  }

  products.sort((a, b) => (a.price || Number.MAX_SAFE_INTEGER) - (b.price || Number.MAX_SAFE_INTEGER));
  return {
    supplierId: supplier.id,
    supplierLabel: supplier.label,
    segment,
    fetchedAt: new Date().toISOString(),
    count: products.length,
    products
  };
}

const crgSegmentCategories = {
  memory: [115],
  gpu: [116, 117, 118, 119, 133],
  cpu: [121, 122, 123, 128]
};

async function fetchCrgPrices(supplier, segment) {
  const baseUrl = supplier.baseUrl.replace(/\/+$/, "") || "https://cre.mycloud.co.il";
  const fingerprint = Number(process.env.CRG_CLIENT_FINGERPRINT || 123456789);
  const { sessionId, cookieJar } = await crgLogin(supplier, baseUrl, fingerprint);
  const response = await supplierFetch(`${baseUrl}/api/Dino/Items/GetItems`, {
    method: "POST",
    cookieJar,
    headers: crgHeaders(baseUrl, sessionId, fingerprint, `${baseUrl}/pages/catalogueN`),
    body: "{}"
  });
  const data = await response.json().catch(() => ({}));
  const groups = data?.Entity?.Groups;
  if (!response.ok || !Array.isArray(groups)) {
    throw new Error(data.ResponseMessage || "שליפת הפריטים מ-CRG נכשלה");
  }

  const categoryIds = crgSegmentCategories[segment] || [];
  const seen = new Set();
  const products = groups
    .flatMap((group) => Array.isArray(group.Items) ? group.Items : [])
    .filter((item) => crgItemMatchesSegment(item, categoryIds))
    .map((item) => parseCrgProduct(item, segment, baseUrl))
    .filter((product) => {
      if (!product.id || seen.has(product.id)) return false;
      seen.add(product.id);
      return true;
    });

  products.sort((a, b) => (a.price || Number.MAX_SAFE_INTEGER) - (b.price || Number.MAX_SAFE_INTEGER));
  return {
    supplierId: supplier.id,
    supplierLabel: supplier.label,
    segment,
    fetchedAt: new Date().toISOString(),
    count: products.length,
    products
  };
}

async function crgLogin(supplier, baseUrl, fingerprint) {
  const cookieJar = new Map();
  await supplierFetch(`${baseUrl}/system/login`, { cookieJar });
  const response = await supplierFetch(`${baseUrl}/api/Login/Login`, {
    method: "POST",
    cookieJar,
    headers: crgHeaders(baseUrl, "", fingerprint, `${baseUrl}/system/login`),
    body: JSON.stringify({
      UserName: supplier.username,
      SecureKey: supplier.password,
      SecureKeyType: "Password",
      Language: "EN",
      ModulesVersion: [],
      ClientFingerprint: fingerprint
    })
  });
  const data = await response.json().catch(() => ({}));
  const sessionId = data?.Entity?.SessionID;
  if (!response.ok || data.IsSuccess !== true || !sessionId) {
    throw new Error(data.ResponseMessage || data?.Entity?.CheckResultMessage || "התחברות ל-CRG נכשלה");
  }
  return { sessionId, cookieJar };
}

function crgHeaders(baseUrl, sessionId, fingerprint, referer) {
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": baseUrl,
    "Referer": referer,
    "m4u-language": "EN",
    "m4u-client-fingerprint": String(fingerprint)
  };
  if (sessionId) headers["m4u-session"] = sessionId;
  return headers;
}

function crgItemMatchesSegment(item, categoryIds) {
  const ids = [
    Number(item.MainCategoryID),
    Number(item.ItemGroupCode)
  ].filter(Number.isFinite);
  return ids.some((id) => categoryIds.includes(id));
}

function parseCrgProduct(item, segment, baseUrl) {
  const priceDetails = item.PriceDetails || {};
  const price = Number(priceDetails.FinalPrice ?? priceDetails.Price);
  const currency = priceDetails.CurrencySymbol || "$";
  const title = [
    item.ItemName,
    item.ItemDescription,
    item.ItemCode,
    item.SuppCatNum,
    `CRG ${item.EntryID || ""}`
  ].map(cleanHtml).find(Boolean) || "";
  return {
    id: String(item.EntryID || item.ItemCode || item.SuppCatNum || title),
    segment,
    title,
    sku: cleanHtml(item.ItemCode || item.SuppCatNum || ""),
    manufacturerSku: cleanHtml(item.SuppCatNum || item.ItemCode || ""),
    stock: item.IsInStock ? "זמין במלאי" : "מלאי חסר",
    price: Number.isFinite(price) ? price : null,
    priceText: Number.isFinite(price) ? `${currency}${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "",
    url: item.EntryID ? `${baseUrl}/pages/item/${item.EntryID}` : "",
    supplierCategory: cleanHtml(item.MainCategoryName || ""),
    manufacturer: cleanHtml(item.ManufacturerName || ""),
    vendor: cleanHtml(item.VendorName || "")
  };
}

async function morLeviPageUrls(baseUrl, segmentUrl, cookieJar) {
  const firstUrl = absoluteSupplierUrl(baseUrl, segmentUrl);
  const response = await supplierFetch(firstUrl, { cookieJar });
  const html = await response.text();
  const pages = new Set([firstUrl]);
  const pageMatches = html.matchAll(/href="(\?page=(\d+))"/gi);
  for (const match of pageMatches) {
    const page = Number(match[2]);
    if (Number.isFinite(page) && page <= 8) {
      const url = new URL(firstUrl);
      url.searchParams.set("page", String(page));
      pages.add(url.toString());
    }
  }
  return [...pages];
}

async function supplierFetch(url, options = {}) {
  if (process.env.SUPPLIER_TLS_REJECT_UNAUTHORIZED !== "1") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
    ...(options.headers || {})
  };
  const cookie = cookieHeader(options.cookieJar);
  if (cookie) headers.Cookie = cookie;
  let response;
  try {
    response = await fetch(url, { ...options, headers, redirect: "manual" });
  } catch (error) {
    response = await supplierHttpRequest(url, { ...options, headers });
  }
  storeCookies(options.cookieJar, response.headers.getSetCookie?.() || response.headers.get("set-cookie"));
  if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
    return supplierFetch(new URL(response.headers.get("location"), url).toString(), options);
  }
  return response;
}

function supplierHttpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;
    const body = requestBodyBuffer(options.body);
    const headers = { ...(options.headers || {}) };
    if (body && !headers["Content-Length"]) headers["Content-Length"] = Buffer.byteLength(body);
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      headers,
      rejectUnauthorized: process.env.SUPPLIER_TLS_REJECT_UNAUTHORIZED === "1"
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          url,
          headers: responseHeaders(response.headers),
          text: async () => buffer.toString("utf8"),
          json: async () => JSON.parse(buffer.toString("utf8") || "{}")
        });
      });
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function requestBodyBuffer(body) {
  if (!body) return null;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof body === "string") return body;
  return String(body);
}

function responseHeaders(headers) {
  return {
    get(name) {
      const value = headers[String(name || "").toLowerCase()];
      return Array.isArray(value) ? value.join(", ") : value || null;
    },
    getSetCookie() {
      const value = headers["set-cookie"];
      return Array.isArray(value) ? value : value ? [value] : [];
    }
  };
}

function storeCookies(cookieJar, setCookies) {
  if (!cookieJar || !setCookies) return;
  const cookies = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const entry of cookies) {
    const [pair] = String(entry).split(";");
    const index = pair.indexOf("=");
    if (index > 0) cookieJar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

function cookieHeader(cookieJar) {
  if (!cookieJar?.size) return "";
  return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function parseMorLeviProducts(html, baseUrl, segment) {
  const blocks = html.match(/<div class="product-thumb">[\s\S]*?<div class="clearfix"><\/div>\s*<\/div>/g) || [];
  return blocks.map((block) => {
    const relativeUrl = firstMatch(block, /<a class="thumb" href="([^"]+)"/i) || firstMatch(block, /<a href="([^"]+)">\s*<h5/i);
    const id = firstMatch(relativeUrl || block, /product\/(\d+)/i) || firstMatch(block, /basket-add="([^"]+)"/i);
    const title = cleanHtml(firstMatch(block, /<h5 class="title"[^>]*>([\s\S]*?)<\/h5>/i));
    const sku = cleanHtml(firstMatch(block, /data-sku="([^"]+)"[^>]*>\s*\1\s*<\/span>/i))
      || cleanHtml(firstMatch(block, /מק"ט מור לוי:[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i));
    const manufacturerSku = cleanHtml(firstMatch(block, /מק"ט יצרן:[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i));
    const stock = cleanHtml(firstMatch(block, /<div class='stockMsg[^']*'>([\s\S]*?)<\/div>/i));
    const rawPrice = cleanHtml(firstMatch(block, /<small class="price">\s*([\s\S]*?)\s*<\/small>/i));
    const price = Number(rawPrice.replace(/[^\d.]/g, ""));
    return {
      id: id || sku || title,
      segment,
      title,
      sku,
      manufacturerSku,
      stock,
      price: Number.isFinite(price) ? price : null,
      priceText: rawPrice || "",
      url: relativeUrl ? absoluteSupplierUrl(baseUrl, relativeUrl) : ""
    };
  }).filter((product) => product.title && product.id);
}

function absoluteSupplierUrl(baseUrl, value) {
  return new URL(value || "/", baseUrl).toString();
}

function firstMatch(value, regex) {
  const match = String(value || "").match(regex);
  return match ? match[1] : "";
}

function cleanHtml(value = "") {
  return decodeHtml(String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function decodeHtml(value = "") {
  const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return named[entity.toLowerCase()] || "";
  });
}

function whatsappMediaKind(mimeType = "") {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

function hasWhatsappConfig() {
  if (whatsappProvider() === "twilio") {
    return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);
  }
  return Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN);
}

function whatsappProvider() {
  return String(process.env.WHATSAPP_PROVIDER || "meta").trim().toLowerCase() === "twilio" ? "twilio" : "meta";
}

function missingWhatsappConfigMessage() {
  if (whatsappProvider() === "twilio") {
    return "Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or TWILIO_WHATSAPP_FROM";
  }
  return "Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN";
}

function whatsappGraphVersion() {
  return process.env.WHATSAPP_GRAPH_VERSION || "v25.0";
}

function maskValue(value = "") {
  if (!value) return "";
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

async function sendWhatsappCampaignMessage(campaign, contact) {
  if (whatsappProvider() === "twilio") {
    return sendTwilioWhatsappMessage(campaign, contact);
  }
  return sendMetaWhatsappMessage(campaign, contact);
}

async function sendMetaWhatsappMessage(campaign, contact) {
  const payload = campaign.mode === "template"
    ? buildTemplatePayload(campaign, contact)
    : buildSessionPayload(campaign, contact);
  const response = await fetch(`https://graph.facebook.com/${whatsappGraphVersion()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `WhatsApp send failed: ${response.status}`);
  }
  return data;
}

async function sendTwilioWhatsappMessage(campaign, contact) {
  const body = campaign.mode === "template"
    ? buildTwilioTemplateBody(campaign, contact)
    : buildTwilioSessionBody(campaign, contact);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(process.env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error_message || `Twilio send failed: ${response.status}`);
  }
  return data;
}

function buildTwilioSessionBody(campaign, contact) {
  const params = new URLSearchParams({
    From: normalizeTwilioWhatsappAddress(process.env.TWILIO_WHATSAPP_FROM),
    To: normalizeTwilioWhatsappAddress(contact.phone)
  });
  const message = personalize(campaign.message, contact);
  if (message) params.set("Body", message);
  if (campaign.media?.url) params.append("MediaUrl", campaignMediaPublicUrl(campaign));
  return params;
}

function buildTwilioTemplateBody(campaign, contact) {
  const params = new URLSearchParams({
    From: normalizeTwilioWhatsappAddress(process.env.TWILIO_WHATSAPP_FROM),
    To: normalizeTwilioWhatsappAddress(contact.phone)
  });
  const contentSid = campaign.templateName || process.env.TWILIO_CONTENT_SID;
  if (contentSid?.startsWith("HX")) {
    params.set("ContentSid", contentSid);
    const variables = twilioContentVariables(campaign, contact);
    if (Object.keys(variables).length) params.set("ContentVariables", JSON.stringify(variables));
    return params;
  }

  const fallback = personalize(campaign.message, contact);
  if (fallback) params.set("Body", fallback);
  if (campaign.media?.url) params.append("MediaUrl", campaignMediaPublicUrl(campaign));
  return params;
}

function twilioContentVariables(campaign, contact) {
  const values = campaign.templateVariables.length
    ? campaign.templateVariables
    : [campaign.message].filter(Boolean);
  return values.reduce((result, value, index) => {
    const text = personalize(value, contact);
    if (text) result[String(index + 1)] = text;
    return result;
  }, {});
}

function normalizeTwilioWhatsappAddress(value) {
  const raw = String(value || "").trim();
  if (raw.startsWith("whatsapp:")) return raw;
  const phone = raw.startsWith("+") ? raw : `+${normalizePhone(raw)}`;
  return `whatsapp:${phone}`;
}

function campaignMediaPublicUrl(campaign) {
  if (campaign.media?.publicUrl) return campaign.media.publicUrl;
  if (!process.env.PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL is required to send media through Twilio");
  return `${process.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}${campaign.media.url}`;
}

function buildSessionPayload(campaign, contact) {
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: contact.phone
  };
  const message = personalize(campaign.message, contact);
  if (!campaign.media?.url) {
    return { ...base, type: "text", text: { preview_url: true, body: message } };
  }

  const mediaUrl = campaignMediaPublicUrl(campaign);
  const mediaKind = campaign.media.mediaKind || whatsappMediaKind(campaign.media.mimeType);
  return {
    ...base,
    type: mediaKind,
    [mediaKind]: {
      link: mediaUrl,
      ...(mediaKind === "document" ? { filename: campaign.media.originalName } : {}),
      ...(message ? { caption: message } : {})
    }
  };
}

function buildTemplatePayload(campaign, contact) {
  const components = [];
  const variables = campaign.templateVariables.length
    ? campaign.templateVariables
    : [campaign.message].filter(Boolean);
  const parameters = variables
    .map((value) => personalize(value, contact))
    .filter(Boolean)
    .map((text) => ({ type: "text", text }));
  if (parameters.length) {
    components.push({ type: "body", parameters });
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: contact.phone,
    type: "template",
    template: {
      name: campaign.templateName,
      language: { code: campaign.templateLanguage || "he" },
      ...(components.length ? { components } : {})
    }
  };
}

function personalize(text, contact) {
  return String(text || "")
    .replaceAll("{{name}}", contact.name || "")
    .replaceAll("{{phone}}", contact.phone || "")
    .trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function certificateOptions() {
  const keyPath = path.join(certDir, "local-signage.key");
  const certPath = path.join(certDir, "local-signage.crt");
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const pem = await selfsigned.generate([{ name: "commonName", value: "Room Panel" }], { days: 3650, keySize: 2048 });
    fs.writeFileSync(keyPath, pem.private);
    fs.writeFileSync(certPath, pem.cert);
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

const dist = path.join(root, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(port, "0.0.0.0", () => {
  console.log(`Room Panel running on http://localhost:${port}`);
  for (const address of localAddresses()) console.log(`LAN: ${address}`);
});

if (enableLocalHttps) {
  https.createServer(await certificateOptions(), app).listen(httpsPort, "0.0.0.0", () => {
    console.log(`Room Panel HTTPS running on https://localhost:${httpsPort}`);
    for (const address of localAddresses("https", httpsPort)) console.log(`LAN HTTPS: ${address}`);
  });
}

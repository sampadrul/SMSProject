// Load env vars
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const twilio = require("twilio");
const {
  getAuthUrl,
  exchangeCodeForToken,
  uploadBufferToDrive
} = require("./googleDrive");

const app = express();

// ---------- Middleware ----------
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(__dirname));

// ---------- Paths ----------
const DATA_DIR = path.join(__dirname, "data");
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

const GLOBAL_CONTACTS_FILE = path.join(DATA_DIR, "global-contacts.json");
const CAMPAIGNS_FILE = path.join(DATA_DIR, "campaigns.json");
const CAMPAIGN_CONTACTS_FILE = path.join(DATA_DIR, "campaign-contacts.json");
const PHOTOS_FILE = path.join(DATA_DIR, "photos.json");
const SEND_LOG_FILE = path.join(DATA_DIR, "send-log.json");
const OPT_OUTS_FILE = path.join(DATA_DIR, "opt-outs.json");

// ---------- Init ----------
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
ensureDir(DATA_DIR);
ensureDir(DOWNLOADS_DIR);

// Serve downloaded images
app.use("/downloads", express.static(DOWNLOADS_DIR));

// ---------- Helpers ----------
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error("Error reading JSON", file, e);
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("Error writing JSON", file, e);
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+1" + digits.slice(1);
  if (digits.length > 0) return "+" + digits;
  return null;
}

function extFromContentType(contentType) {
  const lower = String(contentType || "").toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("gif")) return "gif";
  if (lower.includes("webp")) return "webp";
  return "bin";
}

async function computeImageHash(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

// ---------- Loaders ----------
function loadGlobalContacts() {
  const data = readJson(GLOBAL_CONTACTS_FILE, { contacts: [] });
  if (Array.isArray(data)) return { contacts: data };
  if (!Array.isArray(data.contacts)) data.contacts = [];
  return data;
}
function saveGlobalContacts(data) {
  writeJson(GLOBAL_CONTACTS_FILE, data);
}

function loadCampaigns() {
  const data = readJson(CAMPAIGNS_FILE, { campaigns: [] });
  if (Array.isArray(data)) return { campaigns: data };
  if (!Array.isArray(data.campaigns)) data.campaigns = [];
  return data;
}
function saveCampaigns(data) {
  writeJson(CAMPAIGNS_FILE, data);
}

function loadCampaignContacts() {
  const data = readJson(CAMPAIGN_CONTACTS_FILE, { memberships: [] });
  if (Array.isArray(data)) return { memberships: data };
  if (!Array.isArray(data.memberships)) data.memberships = [];
  return data;
}
function saveCampaignContacts(data) {
  writeJson(CAMPAIGN_CONTACTS_FILE, data);
}

function loadPhotos() {
  const data = readJson(PHOTOS_FILE, { photos: [] });
  if (Array.isArray(data)) return { photos: data };
  if (!Array.isArray(data.photos)) data.photos = [];
  return data;
}
function savePhotos(data) {
  writeJson(PHOTOS_FILE, data);
}

function loadSendLog() {
  const data = readJson(SEND_LOG_FILE, { events: [] });
  if (Array.isArray(data)) return { events: data };
  if (!Array.isArray(data.events)) data.events = [];
  return data;
}
function saveSendLog(data) {
  writeJson(SEND_LOG_FILE, data);
}

function loadOptOuts() {
  const data = readJson(OPT_OUTS_FILE, { phoneNumbers: [] });
  if (Array.isArray(data)) return { phoneNumbers: data };
  if (!Array.isArray(data.phoneNumbers)) data.phoneNumbers = [];
  return data;
}
function saveOptOuts(data) {
  writeJson(OPT_OUTS_FILE, data);
}

// ---------- Twilio ----------
function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

async function sendSmsViaTwilio({ to, body }) {
  const client = getTwilioClient();
  if (!client) throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");

  const payload = { to, body };

  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    payload.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  } else if (process.env.TWILIO_PHONE_NUMBER) {
    payload.from = process.env.TWILIO_PHONE_NUMBER;
  } else {
    throw new Error("Missing TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER");
  }

  const msg = await client.messages.create(payload);

  return {
    sid: msg.sid,
    status: msg.status,
    to: msg.to,
    from: msg.from || null,
    messagingServiceSid: msg.messagingServiceSid || null
  };
}

// ---------- Health ----------
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ---------- Google OAuth ----------
app.get("/google/auth", (req, res) => {
  try {
    const url = getAuthUrl();
    res.send(`
      <h2>Google Drive Authorization</h2>
      <p>1) Click this link and approve access:</p>
      <p><a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a></p>
      <p>2) After approving, Google will show you a code. Paste it here:</p>
      <form method="POST" action="/google/auth">
        <input name="code" style="width: 600px;" />
        <button type="submit">Submit</button>
      </form>
    `);
  } catch (e) {
    res.status(500).send("Error: " + e.message);
  }
});

app.post("/google/auth", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const code = (req.body.code || "").trim();
    if (!code) return res.status(400).send("Missing code.");
    await exchangeCodeForToken(code);
    res.send("✅ Authorized! You can close this tab and return to the app.");
  } catch (e) {
    res.status(500).send("Error exchanging code: " + e.message);
  }
});

// ---------- Global contacts ----------
app.get("/api/global-contacts", (req, res) => {
  const { contacts } = loadGlobalContacts();
  res.json({ contacts });
});

app.post("/api/global-contacts", (req, res) => {
  const { name, phoneNumber } = req.body || {};
  const norm = normalizePhone(phoneNumber);
  if (!norm) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  const data = loadGlobalContacts();

  const existing = data.contacts.find(c => normalizePhone(c.phoneNumber) === norm);
  if (existing) {
    return res.json({ contact: existing });
  }

  const contact = {
    id: makeId("contact"),
    name: name?.trim() || norm,
    phoneNumber: norm,
    createdAt: new Date().toISOString()
  };

  data.contacts.push(contact);
  saveGlobalContacts(data);

  res.json({ contact });
});

app.delete("/api/global-contacts/:id", (req, res) => {
  const id = req.params.id;
  const data = loadGlobalContacts();
  const idx = data.contacts.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: "Contact not found" });

  data.contacts.splice(idx, 1);
  saveGlobalContacts(data);
  res.json({ ok: true });
});

// ---------- Campaigns ----------
app.get("/api/campaigns", (req, res) => {
  const campaignsData = loadCampaigns();
  const cc = loadCampaignContacts();
  const photosData = loadPhotos();

  const campaigns = campaignsData.campaigns.map(c => ({
    ...c,
    contactCount: cc.memberships.filter(m => m.campaignId === c.id).length,
    responseCount: photosData.photos.filter(p => p.campaignId === c.id).length
  }));

  res.json({ campaigns });
});

app.post("/api/campaigns", (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }

  const existing = loadCampaigns();
  const campaigns = Array.isArray(existing.campaigns)
    ? existing.campaigns
    : Array.isArray(existing)
      ? existing
      : [];

  const now = new Date().toISOString();

  const campaign = {
    id: makeId("camp"),
    name: name.trim(),
    createdAt: now,
    updatedAt: now,
    lastUpdated: now,
    contactCount: 0,
    responseCount: 0,
    sendCount: 0,
    isLocked: false,
    lockedAt: null,
    message: ""
  };

  campaigns.push(campaign);
  saveCampaigns({ campaigns });
  res.json({ campaign });
});

app.get("/api/campaigns/:id", (req, res) => {
  const id = req.params.id;
  const campaignsData = loadCampaigns();
  const cc = loadCampaignContacts();
  const photosData = loadPhotos();

  const campaign = campaignsData.campaigns.find(c => c.id === id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  res.json({
    campaign: {
      ...campaign,
      contactCount: cc.memberships.filter(m => m.campaignId === id).length,
      responseCount: photosData.photos.filter(p => p.campaignId === id).length
    }
  });
});

// ---------- Campaign contacts ----------
app.get("/api/contacts", (req, res) => {
  const { campaignId } = req.query;
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });

  const global = loadGlobalContacts();
  const cc = loadCampaignContacts();

  const contacts = cc.memberships
    .filter(m => m.campaignId === campaignId)
    .map(m => {
      const contact = global.contacts.find(c => c.id === m.contactId);
      return {
        ...m,
        name: contact ? contact.name : "(deleted contact)",
        phoneNumber: contact ? contact.phoneNumber : ""
      };
    });

  res.json({ contacts });
});

app.post("/api/contacts", (req, res) => {
  const { campaignId, contactId } = req.body || {};
  if (!campaignId || !contactId) {
    return res.status(400).json({ error: "campaignId and contactId required" });
  }

  const global = loadGlobalContacts();
  const cc = loadCampaignContacts();
  const campaignsData = loadCampaigns();

  const contact = global.contacts.find(c => c.id === contactId);
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  const existing = cc.memberships.find(
    m => m.campaignId === campaignId && m.contactId === contactId
  );
  if (existing) return res.json({ membership: existing });

  const now = new Date().toISOString();
  const membership = {
    id: makeId("member"),
    campaignId,
    contactId,
    createdAt: now,
    firstSentAt: null,
    lastOutboundAt: null
  };

  cc.memberships.push(membership);
  saveCampaignContacts(cc);

  const campaign = campaignsData.campaigns.find(c => c.id === campaignId);
  if (campaign) {
    campaign.contactCount = cc.memberships.filter(m => m.campaignId === campaignId).length;
    campaign.updatedAt = now;
    campaign.lastUpdated = now;
    saveCampaigns(campaignsData);
  }

  res.json({ membership });
});

app.delete("/api/contacts/:id", (req, res) => {
  const membershipId = req.params.id;
  const cc = loadCampaignContacts();
  const idx = cc.memberships.findIndex(m => m.id === membershipId);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const membership = cc.memberships[idx];
  cc.memberships.splice(idx, 1);
  saveCampaignContacts(cc);

  const campaignsData = loadCampaigns();
  const campaign = campaignsData.campaigns.find(c => c.id === membership.campaignId);
  if (campaign) {
    const now = new Date().toISOString();
    campaign.contactCount = cc.memberships.filter(m => m.campaignId === membership.campaignId).length;
    campaign.updatedAt = now;
    campaign.lastUpdated = now;
    saveCampaigns(campaignsData);
  }

  res.json({ ok: true });
});

// ---------- Send log ----------
app.get("/api/send-log", (req, res) => {
  const { campaignId } = req.query;
  const data = loadSendLog();
  let events = data.events || [];
  if (campaignId) events = events.filter(e => e.campaignId === campaignId);
  res.json({ events });
});

// ---------- Send campaign ----------
app.post("/api/send-campaign", async (req, res) => {
  const { campaignId, message } = req.body || {};
  if (!campaignId) {
    return res.status(400).json({ error: "campaignId is required" });
  }

  const campaignsData = loadCampaigns();
  const cc = loadCampaignContacts();
  const sendLog = loadSendLog();
  const globalContacts = loadGlobalContacts();
  const optOuts = loadOptOuts();

  const campaigns = campaignsData.campaigns;
  const campIdx = campaigns.findIndex(c => c.id === campaignId);
  if (campIdx === -1) {
    return res.status(404).json({ error: "Campaign not found" });
  }

  const camp = campaigns[campIdx];
  const now = new Date().toISOString();
  const isInitial = !camp.isLocked;

  let effectiveMessage = camp.message || "";

  if (isInitial) {
    const trimmed = (message || "").trim();
    if (!trimmed) {
      return res.status(400).json({ error: "Message is required for initial send" });
    }
    effectiveMessage = trimmed;
    camp.message = trimmed;
    camp.isLocked = true;
    camp.lockedAt = now;
  } else {
    if (!effectiveMessage) {
      return res.status(400).json({
        error: "Campaign has no stored message; cannot do incremental send"
      });
    }
  }

  const allMemberships = cc.memberships.filter(m => m.campaignId === campaignId);
  const targetMemberships = isInitial
    ? allMemberships
    : allMemberships.filter(m => !m.firstSentAt);

  if (targetMemberships.length === 0) {
    return res.json({
      ok: true,
      sendType: isInitial ? "initial" : "incremental",
      updatedCount: 0,
      sentAt: now,
      message: effectiveMessage,
      twilioAcceptedCount: 0,
      twilioFailedCount: 0,
      results: []
    });
  }

  const results = [];
  let acceptedCount = 0;
  let failedCount = 0;

  for (const membership of targetMemberships) {
    const contact = globalContacts.contacts.find(c => c.id === membership.contactId);

    if (!contact || !contact.phoneNumber) {
      failedCount++;
      results.push({
        membershipId: membership.id,
        contactId: membership.contactId,
        phoneNumber: null,
        ok: false,
        error: "Missing contact or phone number"
      });
      continue;
    }

    const normalized = normalizePhone(contact.phoneNumber);
    if (optOuts.phoneNumbers.includes(normalized)) {
      failedCount++;
      results.push({
        membershipId: membership.id,
        contactId: membership.contactId,
        phoneNumber: contact.phoneNumber,
        ok: false,
        error: "Contact is opted out"
      });
      continue;
    }

    try {
      const twilioResult = await sendSmsViaTwilio({
        to: contact.phoneNumber,
        body: effectiveMessage
      });

      membership.lastOutboundAt = now;
      if (!membership.firstSentAt) membership.firstSentAt = now;

      acceptedCount++;
      results.push({
        membershipId: membership.id,
        contactId: membership.contactId,
        phoneNumber: contact.phoneNumber,
        ok: true,
        twilioSid: twilioResult.sid,
        twilioStatus: twilioResult.status
      });
    } catch (err) {
      failedCount++;
      results.push({
        membershipId: membership.id,
        contactId: membership.contactId,
        phoneNumber: contact.phoneNumber,
        ok: false,
        error: err.message || "Twilio send failed"
      });
    }
  }

  saveCampaignContacts(cc);

  camp.sendCount = (camp.sendCount || 0) + 1;
  camp.lastUpdated = now;
  camp.updatedAt = now;
  camp.contactCount = cc.memberships.filter(m => m.campaignId === campaignId).length;
  camp.responseCount = loadPhotos().photos.filter(p => p.campaignId === campaignId).length;
  saveCampaigns({ campaigns });

  const event = {
    id: makeId("send"),
    campaignId,
    type: isInitial ? "initial" : "incremental",
    sentAt: now,
    targetCount: targetMemberships.length,
    acceptedCount,
    failedCount,
    message: effectiveMessage,
    results
  };
  sendLog.events.push(event);
  saveSendLog(sendLog);

  return res.json({
    ok: true,
    sendType: isInitial ? "initial" : "incremental",
    updatedCount: acceptedCount,
    sentAt: now,
    message: effectiveMessage,
    twilioAcceptedCount: acceptedCount,
    twilioFailedCount: failedCount,
    results
  });
});

// ---------- Photos ----------
app.get("/api/photos", (req, res) => {
  const { campaignId, contactId } = req.query;
  const photosData = loadPhotos();
  const contactsData = loadGlobalContacts();

  let photos = photosData.photos || [];
  if (campaignId) photos = photos.filter(p => p.campaignId === campaignId);
  if (contactId) photos = photos.filter(p => p.contactId === contactId);

  const grouped = new Map();

  for (const p of photos) {
    const key = `${p.phoneNumber || "unknown"}__${p.contactId || "none"}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(p);
  }

  const data = [];
  for (const [key, arr] of grouped.entries()) {
    const [phone, cId] = key.split("__");
    const contact = cId !== "none"
      ? contactsData.contacts.find(c => c.id === cId)
      : null;

    data.push({
      phoneNumber: phone === "unknown" ? "" : phone,
      contactId: cId === "none" ? null : cId,
      name: contact ? contact.name : "",
      photos: arr.map(p => ({
        id: p.id,
        filename: p.filename,
        createdAt: p.createdAt,
        url: `/downloads/${encodeURIComponent((p.phoneNumber || "unknown").replace(/[^\d+]/g, ""))}/${encodeURIComponent(p.filename)}`,
        contentHash: p.contentHash || null,
        similarInOtherCampaigns: p.similarInOtherCampaigns || [],
        driveFileId: p.driveFileId || null,
        driveWebViewLink: p.driveWebViewLink || null
      }))
    });
  }

  res.json({ data });
});

// ---------- Contact details ----------
app.get("/api/contact-details/:id", (req, res) => {
  const { id } = req.params;
  const contacts = loadGlobalContacts();
  const campaigns = loadCampaigns();
  const memberships = loadCampaignContacts();
  const photos = loadPhotos();

  const contact = contacts.contacts.find(c => c.id === id);
  if (!contact) {
    return res.status(404).json({ error: "Contact not found" });
  }

  const mems = memberships.memberships.filter(m => m.contactId === id);

  const campaignsInfo = mems.map(m => {
    const camp = campaigns.campaigns.find(c => c.id === m.campaignId);
    const photoCount = photos.photos.filter(
      p => p.contactId === id && p.campaignId === m.campaignId
    ).length;

    return {
      campaignId: m.campaignId,
      campaignName: camp?.name || "(deleted campaign)",
      firstSentAt: m.firstSentAt || null,
      lastOutboundAt: m.lastOutboundAt || null,
      addedAt: m.createdAt,
      photoCount
    };
  });

  const contactPhotos = photos.photos
    .filter(p => p.contactId === id)
    .map(p => {
      const camp = campaigns.campaigns.find(c => c.id === p.campaignId);
      return {
        id: p.id,
        filename: p.filename,
        createdAt: p.createdAt,
        campaignId: p.campaignId,
        campaignName: camp?.name || null,
        url: `/downloads/${encodeURIComponent((p.phoneNumber || "unknown").replace(/[^\d+]/g, ""))}/${encodeURIComponent(p.filename)}`,
        similarInOtherCampaigns: p.similarInOtherCampaigns || [],
        driveWebViewLink: p.driveWebViewLink || null
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({
    contact,
    campaigns: campaignsInfo,
    photos: contactPhotos
  });
});

// ---------- Dev simulate inbound ----------
app.post("/api/dev/simulate-inbound", async (req, res) => {
  try {
    const { phoneNumber, mediaUrl, contentType } = req.body || {};
    if (!phoneNumber || !mediaUrl) {
      return res.status(400).json({
        error: "phoneNumber and mediaUrl are required"
      });
    }

    const port = process.env.PORT || 3001;
    const url = `http://localhost:${port}/twilio/inbound`;

    const formBody = new URLSearchParams({
      From: phoneNumber,
      NumMedia: "1",
      MediaUrl0: mediaUrl,
      MediaContentType0: contentType || "image/jpeg"
    }).toString();

    await axios.post(url, formBody, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("Error in /api/dev/simulate-inbound:", e);
    res.status(500).json({ error: e.message || "Error simulating inbound" });
  }
});

// ---------- Twilio inbound ----------
app.post("/twilio/inbound", async (req, res) => {
  console.log("=== TWILIO INBOUND HIT ===", new Date().toISOString());
  console.log("Headers:", req.headers["content-type"]);
  console.log("Body:", req.body);


  try {
    const rawFrom = req.body.From || "";
    const from = normalizePhone(rawFrom);
    const bodyRaw = String(req.body.Body || "").trim();
    const bodyUpper = bodyRaw.toUpperCase();
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    console.log("Raw From:", rawFrom);
    console.log("Normalized From:", from);
    console.log("NumMedia:", numMedia);

    // STOP / HELP / START handling
    if (bodyUpper === "STOP") {
      const optOuts = loadOptOuts();
      if (from && !optOuts.phoneNumbers.includes(from)) {
        optOuts.phoneNumbers.push(from);
        saveOptOuts(optOuts);
      }
      return res
        .status(200)
        .send("<Response><Message>You have been unsubscribed and will no longer receive messages.</Message></Response>");
    }

    if (bodyUpper === "HELP") {
      return res
        .status(200)
        .send("<Response><Message>Photo Campaign tool support. Reply STOP to unsubscribe.</Message></Response>");
    }

    if (bodyUpper === "START") {
      const optOuts = loadOptOuts();
      if (from) {
        optOuts.phoneNumbers = optOuts.phoneNumbers.filter(n => n !== from);
        saveOptOuts(optOuts);
      }
      return res
        .status(200)
        .send("<Response><Message>You are opted in to receive messages from the Photo Campaign tool. Reply STOP to opt out.</Message></Response>");
    }

    const globalContacts = loadGlobalContacts();
    const cc = loadCampaignContacts();
    const campaignsData = loadCampaigns();
    const photosData = loadPhotos();

    const matchedContact = globalContacts.contacts
      .map(c => ({ ...c, phoneNorm: normalizePhone(c.phoneNumber) }))
      .find(c => c.phoneNorm === from) || null;

    if (!matchedContact) {
      console.warn("⚠ No matching global contact for phone:", from);
    } else {
      console.log("Matched contact:", matchedContact.id, matchedContact.name);
    }

    let campaignId = null;
    let contactId = matchedContact ? matchedContact.id : null;
    let assignedFromLastOutboundAt = null;

    if (matchedContact) {
      const memberships = cc.memberships.filter(m => m.contactId === matchedContact.id);

      if (memberships.length > 0) {
        let latestMembership = null;
        let latestTs = null;

        for (const m of memberships) {
          if (!m.lastOutboundAt) continue;
          const ts = new Date(m.lastOutboundAt).getTime();
          if (latestTs === null || ts > latestTs) {
            latestTs = ts;
            latestMembership = m;
          }
        }

        if (latestMembership) {
          campaignId = latestMembership.campaignId;
          contactId = latestMembership.contactId;
          assignedFromLastOutboundAt = latestMembership.lastOutboundAt;
          console.log("Assigned via lastOutboundAt to campaign:", campaignId);
        } else {
          campaignId = memberships[0].campaignId;
          contactId = memberships[0].contactId;
          console.log("No lastOutboundAt found; fallback campaign:", campaignId);
        }
      }
    }

    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const contentType = req.body.MediaContentType0 || "image/jpeg";
      const ext = extFromContentType(contentType);

      console.log("Media URL:", mediaUrl);
      console.log("Content-Type:", contentType);

      const safeFrom = (from || "unknown").replace(/[^\d+]/g, "");
      const fromFolder = path.join(DOWNLOADS_DIR, safeFrom || "unknown");
      ensureDir(fromFolder);

      const filename = `${Date.now()}.${ext}`;
      const filePath = path.join(fromFolder, filename);

      console.log("Saving to local:", filePath);

      const response = await axios.get(mediaUrl, {
  responseType: "arraybuffer",
  auth: {
    username: process.env.TWILIO_ACCOUNT_SID,
    password: process.env.TWILIO_AUTH_TOKEN
  }
});
      const buffer = response.data;

      fs.writeFileSync(filePath, buffer);
      console.log("Saved image locally.");

      let contentHash = null;
      try {
        contentHash = await computeImageHash(buffer);
        console.log("Computed contentHash:", contentHash);
      } catch (e) {
        console.warn("Could not compute image hash:", e.message || e);
      }

      let driveFileId = null;
      let driveWebViewLink = null;

      const driveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
      if (driveFolderId) {
        try {
          const uploadResult = await uploadBufferToDrive({
            buffer,
            filename,
            mimeType: contentType,
            folderId: driveFolderId
          });
          driveFileId = uploadResult.id;
          driveWebViewLink = uploadResult.webViewLink || null;
          console.log("Uploaded to Google Drive:", driveFileId, driveWebViewLink);
        } catch (e) {
          console.warn("Failed to upload to Google Drive:", e.message || e);
        }
      } else {
        console.log("No GOOGLE_DRIVE_FOLDER_ID set; skipping Drive upload.");
      }

      let similarInOtherCampaigns = [];
      if (contentHash) {
        const exactMatches = (photosData.photos || []).filter(
          p => p.contentHash === contentHash && p.campaignId && p.campaignId !== campaignId
        );

        similarInOtherCampaigns = exactMatches.map(m => ({
          campaignId: m.campaignId,
          contactId: m.contactId || null,
          photoId: m.id
        }));

        for (const m of exactMatches) {
          m.similarInOtherCampaigns = m.similarInOtherCampaigns || [];
          const already = m.similarInOtherCampaigns.some(
            x => x.campaignId === campaignId
          );
          if (!already && campaignId) {
            m.similarInOtherCampaigns.push({
              campaignId,
              contactId,
              photoId: null
            });
          }
        }
      }

      const now = new Date().toISOString();

      const photoRecord = {
        id: makeId("photo"),
        phoneNumber: from,
        filename,
        createdAt: now,
        campaignId: campaignId || null,
        contactId: contactId || null,
        assignedFromLastOutboundAt: assignedFromLastOutboundAt || null,
        contentHash,
        similarInOtherCampaigns,
        driveFileId,
        driveWebViewLink
      };

      photosData.photos.push(photoRecord);
      savePhotos(photosData);

      console.log("Saved photo record:", photoRecord);

      if (campaignId) {
        const campaign = campaignsData.campaigns.find(c => c.id === campaignId);
        if (campaign) {
          campaign.responseCount = photosData.photos.filter(p => p.campaignId === campaignId).length;
          campaign.updatedAt = now;
          campaign.lastUpdated = now;
          saveCampaigns(campaignsData);
        }
      }
    } else {
      console.log("No media in this message.");
    }

    res.status(200).send("<Response></Response>");
  } catch (err) {
    console.error("Error in /twilio/inbound handler:", err?.message || err);
    res.status(500).send("Error");
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Health check at http://localhost:${PORT}/health`);
});
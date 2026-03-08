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
  uploadBufferToDrive,
  getDriveClient,
  getRefreshToken,
  getCredentials
} = require("./googleDrive");
const { db, stmts } = require("./db");

const session = require("express-session");
const bcrypt = require("bcryptjs");

const app = express();

// ---------- Middleware ----------
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Session middleware — stores a cookie so the server remembers you're logged in
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-fallback-secret",
  resave: false,              // don't re-save session if nothing changed
  saveUninitialized: false,   // don't create session until something is stored
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,  // stay logged in for 7 days
    httpOnly: true,           // JS can't read the cookie (security)
    secure: false             // set to true when behind HTTPS in production
  }
}));

// Auth check — this function blocks unauthenticated requests
function requireAuth(req, res, next) {
  if (req.session && req.session.isAuthenticated) return next();
  // API calls get a 401; page requests get redirected to login
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated" });
  return res.redirect("/login.html");
}

// Login endpoint — compare submitted password against the stored hash
app.post("/api/login", async (req, res) => {
  const { password } = req.body;
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash) return res.status(500).json({ error: "No password configured" });

  const match = await bcrypt.compare(password || "", hash);
  if (!match) return res.status(401).json({ error: "Wrong password" });

  req.session.isAuthenticated = true;
  res.json({ ok: true });
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Public files — login page, Twilio webhook, health check, and static assets
// These are served WITHOUT auth so the login page itself can load
app.use("/login.html", express.static(path.join(__dirname, "login.html")));
app.use("/optin.html", express.static(path.join(__dirname, "optin.html")));
app.use("/privacy.html", express.static(path.join(__dirname, "privacy.html")));
app.use("/terms.html", express.static(path.join(__dirname, "terms.html")));

// Everything else requires login
app.use((req, res, next) => {
  // Skip auth for: login API, Twilio webhook, health check
  if (req.path === "/api/login" || req.path.startsWith("/twilio/") || req.path === "/health") {
    return next();
  }
  // Apply auth to all other routes
  requireAuth(req, res, next);
});

// Static files (now behind auth)
app.use(express.static(__dirname));

// ---------- Paths ----------
const DOWNLOADS_DIR = path.join(__dirname, "downloads");
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
ensureDir(DOWNLOADS_DIR);

// Serve downloaded images
app.use("/downloads", express.static(DOWNLOADS_DIR));

// ---------- Helpers ----------
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

// Helper: convert SQLite campaign row (isLocked is 0/1) to API format (true/false)
function campaignToApi(row) {
  if (!row) return null;
  return { ...row, isLocked: !!row.isLocked };
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

// ---------- Root ----------
app.get("/", (req, res) => {
  if (req.session && req.session.isAuthenticated) {
    return res.redirect("/dashboard.html");
  }
  res.redirect("/login.html");
});

// ---------- Health ----------
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ---------- Google OAuth ----------
app.get("/google/auth", (req, res) => {
  try {
    // Show current connection status
    const hasRefreshToken = !!getRefreshToken();
    const statusHtml = hasRefreshToken
      ? `<p style="color:green;font-weight:bold;">Google Drive is currently connected.</p>
         <p>Re-authorize below if you need a new refresh token:</p>`
      : `<p style="color:orange;font-weight:bold;">Google Drive is not yet connected.</p>`;

    const url = getAuthUrl();
    res.send(`
      <h2>Google Drive Authorization</h2>
      ${statusHtml}
      <p>1) Click this link and approve access:</p>
      <p><a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a></p>
      <p>2) After approving, Google will show you a code. Paste it here:</p>
      <form method="POST" action="/google/auth">
        <input name="code" style="width: 600px;" />
        <button type="submit">Submit</button>
      </form>
      <p><a href="/">Back to app</a></p>
    `);
  } catch (e) {
    res.status(500).send("Error: " + e.message);
  }
});

app.post("/google/auth", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const code = (req.body.code || "").trim();
    if (!code) return res.status(400).send("Missing code.");
    const tokens = await exchangeCodeForToken(code);
    // Show the refresh token so the user can copy it into cloud env vars
    const refreshToken = tokens.refresh_token || "(no refresh token returned — you may already have one)";
    res.send(`
      <h2>Authorized!</h2>
      <p>Google Drive is connected. The token file has been saved locally.</p>
      <h3>For cloud deployment (Railway):</h3>
      <p>Copy this refresh token into your <code>GOOGLE_OAUTH_REFRESH_TOKEN</code> env var:</p>
      <pre style="background:#f0f0f0;padding:12px;border-radius:4px;word-break:break-all;max-width:800px;">${refreshToken}</pre>
      <p style="color:#666;">You only need to do this once. The refresh token is long-lived.</p>
      <p><a href="/">Back to app</a></p>
    `);
  } catch (e) {
    res.status(500).send("Error exchanging code: " + e.message);
  }
});

// ---------- Global contacts ----------
app.get("/api/global-contacts", (req, res) => {
  const contacts = stmts.getAllContacts.all();
  res.json({ contacts });
});

app.post("/api/global-contacts", (req, res) => {
  const { name, phoneNumber } = req.body || {};
  const norm = normalizePhone(phoneNumber);
  if (!norm) return res.status(400).json({ error: "Invalid phone number" });

  const existing = stmts.getContactByPhone.get(norm);
  if (existing) return res.json({ contact: existing });

  const contact = {
    id: makeId("contact"),
    name: name?.trim() || norm,
    phoneNumber: norm,
    createdAt: new Date().toISOString()
  };
  stmts.insertContact.run(contact);
  res.json({ contact });
});

app.delete("/api/global-contacts/:id", (req, res) => {
  const contact = stmts.getContactById.get(req.params.id);
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  stmts.deleteContact.run(req.params.id);
  res.json({ ok: true });
});

// ---------- Campaigns ----------
app.get("/api/campaigns", (req, res) => {
  const rows = stmts.getAllCampaigns.all();
  const campaigns = rows.map(c => {
    const contactCount = stmts.countMembershipsByCampaign.get(c.id).count;
    const responseCount = stmts.countPhotosByCampaign.get(c.id).count;
    return { ...campaignToApi(c), contactCount, responseCount };
  });
  res.json({ campaigns });
});

app.post("/api/campaigns", (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });

  const now = new Date().toISOString();
  const campaign = {
    id: makeId("camp"),
    name: name.trim(),
    createdAt: now,
    updatedAt: now,
    lastUpdated: now,
    sendCount: 0,
    isLocked: 0,
    lockedAt: null,
    message: ""
  };
  stmts.insertCampaign.run(campaign);
  res.json({ campaign: { ...campaignToApi(campaign), contactCount: 0, responseCount: 0 } });
});

app.get("/api/campaigns/:id", (req, res) => {
  const row = stmts.getCampaignById.get(req.params.id);
  if (!row) return res.status(404).json({ error: "Campaign not found" });

  const contactCount = stmts.countMembershipsByCampaign.get(row.id).count;
  const responseCount = stmts.countPhotosByCampaign.get(row.id).count;
  res.json({ campaign: { ...campaignToApi(row), contactCount, responseCount } });
});

// ---------- Campaign contacts ----------
app.get("/api/contacts", (req, res) => {
  const { campaignId } = req.query;
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });

  const memberships = stmts.getMembershipsByCampaign.all(campaignId);
  const contacts = memberships.map(m => {
    const contact = stmts.getContactById.get(m.contactId);
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
  if (!campaignId || !contactId) return res.status(400).json({ error: "campaignId and contactId required" });

  const contact = stmts.getContactById.get(contactId);
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  const existing = stmts.getMembershipByCampaignAndContact.get(campaignId, contactId);
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
  stmts.insertMembership.run(membership);

  // Update campaign metadata
  const camp = stmts.getCampaignById.get(campaignId);
  if (camp) {
    stmts.updateCampaign.run({ ...camp, updatedAt: now, lastUpdated: now });
  }

  res.json({ membership });
});

app.delete("/api/contacts/:id", (req, res) => {
  const membership = stmts.getMembershipById.get(req.params.id);
  if (!membership) return res.status(404).json({ error: "Not found" });

  stmts.deleteMembership.run(req.params.id);

  const camp = stmts.getCampaignById.get(membership.campaignId);
  if (camp) {
    const now = new Date().toISOString();
    stmts.updateCampaign.run({ ...camp, updatedAt: now, lastUpdated: now });
  }

  res.json({ ok: true });
});

// ---------- Send log ----------
app.get("/api/send-log", (req, res) => {
  const { campaignId } = req.query;
  let events = campaignId
    ? stmts.getSendLogByCampaign.all(campaignId)
    : stmts.getAllSendLog.all();
  // Parse JSON results column back to arrays
  events = events.map(e => ({ ...e, results: JSON.parse(e.results || "[]") }));
  res.json({ events });
});

// ---------- Send campaign ----------
app.post("/api/send-campaign", async (req, res) => {
  const { campaignId, message } = req.body || {};
  if (!campaignId) return res.status(400).json({ error: "campaignId is required" });

  const camp = stmts.getCampaignById.get(campaignId);
  if (!camp) return res.status(404).json({ error: "Campaign not found" });

  const now = new Date().toISOString();
  const isInitial = !camp.isLocked;

  let effectiveMessage = camp.message || "";

  if (isInitial) {
    const trimmed = (message || "").trim();
    if (!trimmed) return res.status(400).json({ error: "Message is required for initial send" });
    effectiveMessage = trimmed;
    camp.message = trimmed;
    camp.isLocked = 1;
    camp.lockedAt = now;
  } else {
    if (!effectiveMessage) {
      return res.status(400).json({ error: "Campaign has no stored message; cannot do incremental send" });
    }
  }

  const allMemberships = stmts.getMembershipsByCampaign.all(campaignId);
  const targetMemberships = isInitial
    ? allMemberships
    : allMemberships.filter(m => !m.firstSentAt);

  if (targetMemberships.length === 0) {
    // Still save lock state if initial
    if (isInitial) stmts.updateCampaign.run({ ...camp, updatedAt: now, lastUpdated: now });
    return res.json({
      ok: true, sendType: isInitial ? "initial" : "incremental",
      updatedCount: 0, sentAt: now, message: effectiveMessage,
      twilioAcceptedCount: 0, twilioFailedCount: 0, results: []
    });
  }

  const results = [];
  let acceptedCount = 0;
  let failedCount = 0;

  for (const membership of targetMemberships) {
    const contact = stmts.getContactById.get(membership.contactId);

    if (!contact || !contact.phoneNumber) {
      failedCount++;
      results.push({ membershipId: membership.id, contactId: membership.contactId, phoneNumber: null, ok: false, error: "Missing contact or phone number" });
      continue;
    }

    const normalized = normalizePhone(contact.phoneNumber);
    if (stmts.isOptedOut.get(normalized)) {
      failedCount++;
      results.push({ membershipId: membership.id, contactId: membership.contactId, phoneNumber: contact.phoneNumber, ok: false, error: "Contact is opted out" });
      continue;
    }

    try {
      const twilioResult = await sendSmsViaTwilio({ to: contact.phoneNumber, body: effectiveMessage });

      stmts.updateMembership.run({
        id: membership.id,
        firstSentAt: membership.firstSentAt || now,
        lastOutboundAt: now
      });

      acceptedCount++;
      results.push({ membershipId: membership.id, contactId: membership.contactId, phoneNumber: contact.phoneNumber, ok: true, twilioSid: twilioResult.sid, twilioStatus: twilioResult.status });
    } catch (err) {
      failedCount++;
      results.push({ membershipId: membership.id, contactId: membership.contactId, phoneNumber: contact.phoneNumber, ok: false, error: err.message || "Twilio send failed" });
    }
  }

  // Update campaign
  camp.sendCount = (camp.sendCount || 0) + 1;
  camp.updatedAt = now;
  camp.lastUpdated = now;
  stmts.updateCampaign.run(camp);

  // Log the send event
  stmts.insertSendLog.run({
    id: makeId("send"),
    campaignId,
    type: isInitial ? "initial" : "incremental",
    sentAt: now,
    targetCount: targetMemberships.length,
    acceptedCount,
    failedCount,
    message: effectiveMessage,
    results: JSON.stringify(results)
  });

  return res.json({
    ok: true, sendType: isInitial ? "initial" : "incremental",
    updatedCount: acceptedCount, sentAt: now, message: effectiveMessage,
    twilioAcceptedCount: acceptedCount, twilioFailedCount: failedCount, results
  });
});

// ---------- Photo URL helper ----------
// If a photo was uploaded to Google Drive, serve it via our proxy.
// Otherwise fall back to the local downloads/ path.
function photoUrl(p) {
  if (p.driveFileId) return `/api/photos/serve/${p.id}`;
  return `/downloads/${encodeURIComponent((p.phoneNumber || "unknown").replace(/[^\d+]/g, ""))}/${encodeURIComponent(p.filename)}`;
}

// Proxy endpoint: streams a photo from Google Drive through our server.
// This keeps photos private (behind login) and doesn't require local files.
app.get("/api/photos/serve/:id", async (req, res) => {
  try {
    const photo = db.prepare("SELECT * FROM photos WHERE id = ?").get(req.params.id);
    if (!photo) return res.status(404).send("Photo not found");

    // If we have a Drive file, stream it from Google Drive
    if (photo.driveFileId) {
      try {
        const drive = getDriveClient();
        const driveRes = await drive.files.get(
          { fileId: photo.driveFileId, alt: "media" },
          { responseType: "stream" }
        );
        // Forward the content type from Drive
        const contentType = driveRes.headers["content-type"] || "image/jpeg";
        res.set("Content-Type", contentType);
        res.set("Cache-Control", "public, max-age=86400"); // cache for 1 day
        driveRes.data.pipe(res);
        return;
      } catch (driveErr) {
        console.warn("Drive fetch failed, falling back to local:", driveErr.message);
      }
    }

    // Fallback: serve from local downloads/ directory
    const safePhone = (photo.phoneNumber || "unknown").replace(/[^\d+]/g, "");
    const filePath = path.join(DOWNLOADS_DIR, safePhone, photo.filename);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }

    res.status(404).send("Photo file not found");
  } catch (err) {
    console.error("Error serving photo:", err.message);
    res.status(500).send("Error");
  }
});

// ---------- Photos ----------
app.get("/api/photos", (req, res) => {
  const { campaignId, contactId } = req.query;

  let photos;
  if (campaignId) photos = stmts.getPhotosByCampaign.all(campaignId);
  else if (contactId) photos = stmts.getPhotosByContact.all(contactId);
  else photos = stmts.getAllPhotos.all();

  // Parse the JSON column and group by sender
  const grouped = new Map();
  for (const p of photos) {
    const key = `${p.phoneNumber || "unknown"}__${p.contactId || "none"}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(p);
  }

  const data = [];
  for (const [key, arr] of grouped.entries()) {
    const [phone, cId] = key.split("__");
    const contact = cId !== "none" ? stmts.getContactById.get(cId) : null;

    data.push({
      phoneNumber: phone === "unknown" ? "" : phone,
      contactId: cId === "none" ? null : cId,
      name: contact ? contact.name : "",
      photos: arr.map(p => ({
        id: p.id,
        filename: p.filename,
        createdAt: p.createdAt,
        url: photoUrl(p),
        contentHash: p.contentHash || null,
        similarInOtherCampaigns: JSON.parse(p.similarInOtherCampaigns || "[]"),
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
  const contact = stmts.getContactById.get(id);
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  const mems = stmts.getMembershipsByContact.all(id);

  const campaignsInfo = mems.map(m => {
    const camp = stmts.getCampaignById.get(m.campaignId);
    const photoCountRow = db.prepare("SELECT COUNT(*) as count FROM photos WHERE contactId = ? AND campaignId = ?").get(id, m.campaignId);
    return {
      campaignId: m.campaignId,
      campaignName: camp?.name || "(deleted campaign)",
      firstSentAt: m.firstSentAt || null,
      lastOutboundAt: m.lastOutboundAt || null,
      addedAt: m.createdAt,
      photoCount: photoCountRow.count
    };
  });

  const contactPhotos = stmts.getPhotosByContact.all(id).map(p => {
    const camp = p.campaignId ? stmts.getCampaignById.get(p.campaignId) : null;
    return {
      id: p.id,
      filename: p.filename,
      createdAt: p.createdAt,
      campaignId: p.campaignId,
      campaignName: camp?.name || null,
      url: photoUrl(p),
      similarInOtherCampaigns: JSON.parse(p.similarInOtherCampaigns || "[]"),
      driveWebViewLink: p.driveWebViewLink || null
    };
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ contact, campaigns: campaignsInfo, photos: contactPhotos });
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
  console.log("Body:", req.body);

  try {
    const rawFrom = req.body.From || "";
    const from = normalizePhone(rawFrom);
    const bodyRaw = String(req.body.Body || "").trim();
    const bodyUpper = bodyRaw.toUpperCase();
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    // STOP / HELP / START handling
    if (bodyUpper === "STOP") {
      if (from) stmts.insertOptOut.run(from);
      return res.status(200).send("<Response><Message>You have been unsubscribed and will no longer receive messages.</Message></Response>");
    }
    if (bodyUpper === "HELP") {
      return res.status(200).send("<Response><Message>Photo Campaign tool support. Reply STOP to unsubscribe.</Message></Response>");
    }
    if (bodyUpper === "START") {
      if (from) stmts.deleteOptOut.run(from);
      return res.status(200).send("<Response><Message>You are opted in to receive messages from the Photo Campaign tool. Reply STOP to opt out.</Message></Response>");
    }

    // Find the contact by phone number
    const matchedContact = from ? stmts.getContactByPhone.get(from) : null;

    if (!matchedContact) {
      console.warn("No matching contact for phone:", from);
    } else {
      console.log("Matched contact:", matchedContact.id, matchedContact.name);
    }

    let campaignId = null;
    let contactId = matchedContact ? matchedContact.id : null;
    let assignedFromLastOutboundAt = null;

    if (matchedContact) {
      const memberships = stmts.getMembershipsByContact.all(matchedContact.id);

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
        } else {
          campaignId = memberships[0].campaignId;
          contactId = memberships[0].contactId;
        }
      }
    }

    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const contentType = req.body.MediaContentType0 || "image/jpeg";
      const ext = extFromContentType(contentType);

      const safeFrom = (from || "unknown").replace(/[^\d+]/g, "");
      const fromFolder = path.join(DOWNLOADS_DIR, safeFrom || "unknown");
      ensureDir(fromFolder);

      const filename = `${Date.now()}.${ext}`;
      const filePath = path.join(fromFolder, filename);

      const response = await axios.get(mediaUrl, {
        responseType: "arraybuffer",
        auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
      });
      const buffer = response.data;

      fs.writeFileSync(filePath, buffer);
      console.log("Saved image locally:", filePath);

      let contentHash = null;
      try {
        contentHash = await computeImageHash(buffer);
      } catch (e) {
        console.warn("Could not compute image hash:", e.message || e);
      }

      let driveFileId = null;
      let driveWebViewLink = null;

      const driveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
      if (driveFolderId) {
        try {
          const uploadResult = await uploadBufferToDrive({ buffer, filename, mimeType: contentType, folderId: driveFolderId });
          driveFileId = uploadResult.id;
          driveWebViewLink = uploadResult.webViewLink || null;
          console.log("Uploaded to Google Drive:", driveFileId);
        } catch (e) {
          console.warn("Failed to upload to Google Drive:", e.message || e);
        }
      }

      // Check for duplicate images across campaigns
      let similarInOtherCampaigns = [];
      if (contentHash) {
        const exactMatches = stmts.getPhotosByHash.all(contentHash)
          .filter(p => p.campaignId && p.campaignId !== campaignId);

        similarInOtherCampaigns = exactMatches.map(m => ({
          campaignId: m.campaignId, contactId: m.contactId || null, photoId: m.id
        }));

        // Update existing photos to cross-reference this new one
        for (const m of exactMatches) {
          const existing = JSON.parse(m.similarInOtherCampaigns || "[]");
          if (campaignId && !existing.some(x => x.campaignId === campaignId)) {
            existing.push({ campaignId, contactId, photoId: null });
            stmts.updatePhotoSimilar.run(JSON.stringify(existing), m.id);
          }
        }
      }

      const now = new Date().toISOString();

      stmts.insertPhoto.run({
        id: makeId("photo"),
        phoneNumber: from,
        filename,
        createdAt: now,
        campaignId: campaignId || null,
        contactId: contactId || null,
        assignedFromLastOutboundAt: assignedFromLastOutboundAt || null,
        contentHash,
        similarInOtherCampaigns: JSON.stringify(similarInOtherCampaigns),
        driveFileId,
        driveWebViewLink
      });

      // Update campaign response count
      if (campaignId) {
        const camp = stmts.getCampaignById.get(campaignId);
        if (camp) {
          stmts.updateCampaign.run({ ...camp, updatedAt: now, lastUpdated: now });
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
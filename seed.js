/**
 * seed.js — Populate the database with realistic test data
 *
 * Run:  node seed.js
 *
 * What it does:
 *   1. Wipes all existing data (same as the /api/wipe endpoint)
 *   2. Inserts 8 contacts with realistic names and fake +1555 numbers
 *   3. Creates 2 campaigns: one active/locked, one closed
 *   4. Adds memberships (all 8 in wedding, 6 in baby shower)
 *   5. Creates send log entries with realistic results JSON
 *   6. Downloads 15 random photos from picsum.photos, saves locally,
 *      and inserts DB rows so the photo serve endpoint works
 *   7. Prints a summary with gallery URLs for quick testing
 *
 * Why this exists:
 *   Building up test data by hand is tedious, and every real send costs
 *   money via Twilio. This script + MOCK_TWILIO=true means you can develop
 *   and test every page for free.
 */

require("dotenv").config();
const { db, stmts } = require("./db");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ---------- Helpers ----------

// Same ID format the server uses: prefix_timestamp_hexrandom
function makeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
}

// Generate a deterministic-looking ISO timestamp in the past
// daysAgo = how many days before "now" this event happened
function pastDate(daysAgo, hoursOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(d.getHours() - hoursOffset);
  return d.toISOString();
}

// Download a file from a URL, following redirects (picsum redirects to its CDN)
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, { timeout: 10000 }, (res) => {
      // picsum.photos returns a 302 redirect to the actual image
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(destPath); // remove the empty file
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", (err) => {
        fs.unlinkSync(destPath);
        reject(err);
      });
    });
    req.on("timeout", () => {
      req.destroy();
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(new Error(`Timeout downloading ${url}`));
    });
    req.on("error", (err) => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

// ---------- Test data ----------

const contacts = [
  { name: "Sarah Chen",       phone: "+15551001001" },
  { name: "Marcus Johnson",   phone: "+15551001002" },
  { name: "Emily Rodriguez",  phone: "+15551001003" },
  { name: "David Kim",        phone: "+15551001004" },
  { name: "Rachel Thompson",  phone: "+15551001005" },
  { name: "James Wilson",     phone: "+15551001006" },
  { name: "Ashley Martinez",  phone: "+15551001007" },
  { name: "Tyler Brooks",     phone: "+15551001008" },
];

// ---------- Main seed function ----------

async function seed() {
  console.log("Wiping all existing data...");

  // Same wipe logic as the /api/wipe endpoint in server.js
  db.exec(`
    DELETE FROM photos;
    DELETE FROM send_log;
    DELETE FROM campaign_contacts;
    DELETE FROM campaigns;
    DELETE FROM global_contacts;
    DELETE FROM opt_outs;
  `);

  // Also clean out any leftover downloaded photos
  const downloadsDir = path.join(__dirname, "downloads");
  if (fs.existsSync(downloadsDir)) {
    fs.rmSync(downloadsDir, { recursive: true, force: true });
    console.log("  Cleared downloads/ folder");
  }
  fs.mkdirSync(downloadsDir, { recursive: true });

  // ---- 1. Contacts ----
  console.log("Inserting contacts...");
  const contactRows = contacts.map((c, i) => ({
    id: makeId("cont"),
    name: c.name,
    phoneNumber: c.phone,
    createdAt: pastDate(30 - i), // staggered creation dates
  }));
  // Small delay between IDs so timestamps differ
  for (const c of contactRows) {
    stmts.insertContact.run(c);
  }

  // ---- 2. Campaigns ----
  console.log("Inserting campaigns...");
  const weddingToken = crypto.randomBytes(16).toString("hex");
  const babyShowerToken = crypto.randomBytes(16).toString("hex");

  const wedding = {
    id: makeId("camp"),
    name: "Johnson Wedding",
    createdAt: pastDate(14),
    updatedAt: pastDate(1),
    lastUpdated: pastDate(1),
    sendCount: 2,
    isLocked: 1,         // locked = contacts can't be edited
    lockedAt: pastDate(12),
    message: "Hi {name}! We'd love for you to share your photos from the Johnson wedding. Just reply to this number with any pictures you took — they'll be added to our shared album!",
    driveFolderId: null,
    shareToken: weddingToken,
    isClosed: 0,
    closedAt: null,
  };

  const babyShower = {
    id: makeId("camp"),
    name: "Martinez Baby Shower",
    createdAt: pastDate(21),
    updatedAt: pastDate(5),
    lastUpdated: pastDate(5),
    sendCount: 2,
    isLocked: 1,
    lockedAt: pastDate(19),
    message: "Hey {name}! Thanks for coming to Ashley's baby shower! Reply with any photos you snapped and we'll add them to the keepsake album.",
    driveFolderId: null,
    shareToken: babyShowerToken,
    isClosed: 1,         // this campaign is finished
    closedAt: pastDate(5),
  };

  stmts.insertCampaign.run(wedding);
  stmts.insertCampaign.run(babyShower);

  // ---- 3. Memberships ----
  // All 8 contacts in the wedding, first 6 in the baby shower
  console.log("Inserting memberships...");
  const weddingMembers = contactRows.map((c) => ({
    id: makeId("mem"),
    campaignId: wedding.id,
    contactId: c.id,
    createdAt: pastDate(13),
    firstSentAt: pastDate(12),        // all were sent the initial message
    lastOutboundAt: pastDate(12),
  }));

  const babyShowerMembers = contactRows.slice(0, 6).map((c) => ({
    id: makeId("mem"),
    campaignId: babyShower.id,
    contactId: c.id,
    createdAt: pastDate(20),
    firstSentAt: pastDate(19),
    lastOutboundAt: pastDate(5),     // last outbound was the gallery link
  }));

  for (const m of weddingMembers) stmts.insertMembership.run(m);
  for (const m of babyShowerMembers) stmts.insertMembership.run(m);

  // ---- 4. Send logs ----
  // Each campaign has 2 sends: initial campaign send + a follow-up
  console.log("Inserting send logs...");

  function makeSendResults(members, contactMap) {
    return members.map((m) => {
      const contact = contactMap.get(m.contactId);
      return {
        contactId: m.contactId,
        contactName: contact.name,
        phone: contact.phoneNumber,
        status: "accepted",
        sid: "MOCK_" + crypto.randomBytes(16).toString("hex"),
      };
    });
  }

  const contactMap = new Map(contactRows.map((c) => [c.id, c]));

  // Wedding: initial send (all 8), then incremental (0 — everyone was already sent)
  const weddingSend1 = {
    id: makeId("send"),
    campaignId: wedding.id,
    type: "campaign",
    sentAt: pastDate(12),
    targetCount: 8,
    acceptedCount: 8,
    failedCount: 0,
    message: wedding.message,
    results: JSON.stringify(makeSendResults(weddingMembers, contactMap)),
  };

  const weddingSend2 = {
    id: makeId("send"),
    campaignId: wedding.id,
    type: "campaign",
    sentAt: pastDate(7),
    targetCount: 0,
    acceptedCount: 0,
    failedCount: 0,
    message: wedding.message,
    results: JSON.stringify([]),
  };

  // Baby shower: initial send (6), then gallery-link send (6)
  const babyShowerSend1 = {
    id: makeId("send"),
    campaignId: babyShower.id,
    type: "campaign",
    sentAt: pastDate(19),
    targetCount: 6,
    acceptedCount: 6,
    failedCount: 0,
    message: babyShower.message,
    results: JSON.stringify(makeSendResults(babyShowerMembers, contactMap)),
  };

  const babyShowerSend2 = {
    id: makeId("send"),
    campaignId: babyShower.id,
    type: "gallery-link",
    sentAt: pastDate(5),
    targetCount: 6,
    acceptedCount: 6,
    failedCount: 0,
    message: "Thanks for sharing your baby shower photos! View the full album here: http://localhost:3000/gallery.html?token=" + babyShowerToken,
    results: JSON.stringify(makeSendResults(babyShowerMembers, contactMap)),
  };

  stmts.insertSendLog.run(weddingSend1);
  stmts.insertSendLog.run(weddingSend2);
  stmts.insertSendLog.run(babyShowerSend1);
  stmts.insertSendLog.run(babyShowerSend2);

  // ---- 5. Photos ----
  // Download random photos from picsum.photos and save them locally.
  // 10 for the wedding (from various contacts), 5 for the baby shower
  console.log("Downloading photos from picsum.photos (this may take a moment)...");

  // Assign photos to specific contacts to make it realistic
  // Wedding: spread across 5 senders, baby shower: 3 senders
  const weddingPhotoAssignments = [
    contactRows[0], contactRows[0], contactRows[0],  // Sarah sent 3
    contactRows[1], contactRows[1],                    // Marcus sent 2
    contactRows[2], contactRows[2],                    // Emily sent 2
    contactRows[3],                                    // David sent 1
    contactRows[4], contactRows[4],                    // Rachel sent 2
  ];

  const babyShowerPhotoAssignments = [
    contactRows[0], contactRows[0],  // Sarah sent 2
    contactRows[2], contactRows[2],  // Emily sent 2
    contactRows[5],                   // James sent 1
  ];

  const allAssignments = [
    ...weddingPhotoAssignments.map((c) => ({ contact: c, campaign: wedding })),
    ...babyShowerPhotoAssignments.map((c) => ({ contact: c, campaign: babyShower })),
  ];

  let photoCount = 0;
  for (const { contact, campaign } of allAssignments) {
    const safePhone = contact.phoneNumber.replace(/[^\d+]/g, "");
    const phoneDir = path.join(downloadsDir, safePhone);
    if (!fs.existsSync(phoneDir)) fs.mkdirSync(phoneDir, { recursive: true });

    // Filename matches the pattern the inbound webhook uses
    const timestamp = Date.now() + photoCount; // ensure unique filenames
    const filename = `${timestamp}.jpg`;
    const filePath = path.join(phoneDir, filename);

    try {
      // Each picsum URL with a unique seed gives a different image
      await downloadFile(`https://picsum.photos/seed/${photoCount + 100}/800/600`, filePath);

      // Compute content hash (same as the inbound webhook does)
      const fileBuffer = fs.readFileSync(filePath);
      const contentHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

      // Figure out a realistic "received" time
      const daysAgo = campaign === wedding ? 11 - photoCount * 0.3 : 8 - photoCount * 0.5;

      stmts.insertPhoto.run({
        id: makeId("photo"),
        phoneNumber: contact.phoneNumber,
        filename,
        createdAt: pastDate(Math.max(1, Math.round(daysAgo))),
        campaignId: campaign.id,
        contactId: contact.id,
        assignedFromLastOutboundAt: campaign === wedding ? pastDate(12) : pastDate(19),
        contentHash,
        similarInOtherCampaigns: "[]",
        driveFileId: null,       // no Drive — photos serve from local fallback
        driveWebViewLink: null,
      });

      photoCount++;
      process.stdout.write(`  Downloaded ${photoCount}/${allAssignments.length}\r`);
    } catch (err) {
      console.error(`  Failed to download photo ${photoCount + 1}: ${err.message}`);
    }
  }

  console.log(); // newline after progress counter

  // ---- Summary ----
  const port = process.env.PORT || 3000;
  const base = `http://localhost:${port}`;

  console.log("\n========================================");
  console.log("  Seed complete!");
  console.log("========================================");
  console.log(`  Contacts:    ${contactRows.length}`);
  console.log(`  Campaigns:   2`);
  console.log(`  Memberships: ${weddingMembers.length + babyShowerMembers.length}`);
  console.log(`  Send logs:   4`);
  console.log(`  Photos:      ${photoCount}`);
  console.log("----------------------------------------");
  console.log("  Gallery URLs:");
  console.log(`    Wedding:      ${base}/gallery.html?token=${weddingToken}`);
  console.log(`    Baby Shower:  ${base}/gallery.html?token=${babyShowerToken}`);
  console.log("========================================\n");

}

module.exports = { seed };

// When run directly from the CLI (node seed.js), execute and exit.
// When imported by another file (require('./seed')), just export the function.
if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}

/**
 * db.js — SQLite database layer
 *
 * Replaces the JSON file storage with a single SQLite database.
 * Each old JSON file maps to a table:
 *   global-contacts.json  → global_contacts
 *   campaigns.json        → campaigns
 *   campaign-contacts.json → campaign_contacts
 *   photos.json           → photos
 *   send-log.json         → send_log
 *   opt-outs.json         → opt_outs
 *
 * Why SQLite?
 *   - Handles concurrent reads/writes safely (JSON files can't)
 *   - Single file — easy to back up, easy to mount as a volume in the cloud
 *   - Real queries instead of reading entire files into memory
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// DATA_DIR can be overridden via env var (for Railway persistent volumes)
// Defaults to ./data (same place JSON files lived)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "app.db");
const db = new Database(DB_PATH);

// WAL mode = faster writes, allows concurrent reads while writing
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------- Schema ----------
// These CREATE TABLE IF NOT EXISTS statements are safe to run every time
// the server starts — they only create tables if they don't already exist.

db.exec(`
  CREATE TABLE IF NOT EXISTS global_contacts (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    phoneNumber   TEXT NOT NULL,
    createdAt     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    createdAt     TEXT NOT NULL,
    updatedAt     TEXT NOT NULL,
    lastUpdated   TEXT NOT NULL,
    sendCount     INTEGER NOT NULL DEFAULT 0,
    isLocked      INTEGER NOT NULL DEFAULT 0,
    lockedAt      TEXT,
    message       TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS campaign_contacts (
    id            TEXT PRIMARY KEY,
    campaignId    TEXT NOT NULL,
    contactId     TEXT NOT NULL,
    createdAt     TEXT NOT NULL,
    firstSentAt   TEXT,
    lastOutboundAt TEXT,
    FOREIGN KEY (campaignId) REFERENCES campaigns(id),
    FOREIGN KEY (contactId) REFERENCES global_contacts(id)
  );

  CREATE TABLE IF NOT EXISTS photos (
    id                        TEXT PRIMARY KEY,
    phoneNumber               TEXT,
    filename                  TEXT NOT NULL,
    createdAt                 TEXT NOT NULL,
    campaignId                TEXT,
    contactId                 TEXT,
    assignedFromLastOutboundAt TEXT,
    contentHash               TEXT,
    similarInOtherCampaigns   TEXT NOT NULL DEFAULT '[]',
    driveFileId               TEXT,
    driveWebViewLink          TEXT
  );

  CREATE TABLE IF NOT EXISTS send_log (
    id            TEXT PRIMARY KEY,
    campaignId    TEXT NOT NULL,
    type          TEXT NOT NULL,
    sentAt        TEXT NOT NULL,
    targetCount   INTEGER NOT NULL DEFAULT 0,
    acceptedCount INTEGER NOT NULL DEFAULT 0,
    failedCount   INTEGER NOT NULL DEFAULT 0,
    message       TEXT NOT NULL DEFAULT '',
    results       TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS opt_outs (
    phoneNumber   TEXT PRIMARY KEY
  );
`);

// ---------- Migrations ----------
// SQLite doesn't support IF NOT EXISTS for columns, so we try the ALTER
// and catch the error if the column already exists. This is safe to run
// on every server start — the first time it adds the column, after that
// the error is silently ignored.
try {
  db.exec("ALTER TABLE campaigns ADD COLUMN driveFolderId TEXT");
  console.log("Migration: added driveFolderId column to campaigns");
} catch (e) {
  // "duplicate column name" means it already exists — that's fine
}

// ---------- Prepared statements ----------
// Preparing statements ahead of time makes them faster and safer (auto-escapes values)

// Global contacts
const stmts = {
  // Global contacts
  getAllContacts: db.prepare("SELECT * FROM global_contacts ORDER BY createdAt DESC"),
  getContactById: db.prepare("SELECT * FROM global_contacts WHERE id = ?"),
  getContactByPhone: db.prepare("SELECT * FROM global_contacts WHERE phoneNumber = ?"),
  insertContact: db.prepare("INSERT INTO global_contacts (id, name, phoneNumber, createdAt) VALUES (@id, @name, @phoneNumber, @createdAt)"),
  deleteContact: db.prepare("DELETE FROM global_contacts WHERE id = ?"),

  // Campaigns
  getAllCampaigns: db.prepare("SELECT * FROM campaigns ORDER BY createdAt DESC"),
  getCampaignById: db.prepare("SELECT * FROM campaigns WHERE id = ?"),
  insertCampaign: db.prepare("INSERT INTO campaigns (id, name, createdAt, updatedAt, lastUpdated, sendCount, isLocked, lockedAt, message, driveFolderId) VALUES (@id, @name, @createdAt, @updatedAt, @lastUpdated, @sendCount, @isLocked, @lockedAt, @message, @driveFolderId)"),
  updateCampaign: db.prepare("UPDATE campaigns SET name=@name, updatedAt=@updatedAt, lastUpdated=@lastUpdated, sendCount=@sendCount, isLocked=@isLocked, lockedAt=@lockedAt, message=@message, driveFolderId=@driveFolderId WHERE id=@id"),

  // Campaign contacts (memberships)
  getMembershipsByCampaign: db.prepare("SELECT * FROM campaign_contacts WHERE campaignId = ?"),
  getMembershipsByContact: db.prepare("SELECT * FROM campaign_contacts WHERE contactId = ?"),
  getMembershipById: db.prepare("SELECT * FROM campaign_contacts WHERE id = ?"),
  getMembershipByCampaignAndContact: db.prepare("SELECT * FROM campaign_contacts WHERE campaignId = ? AND contactId = ?"),
  insertMembership: db.prepare("INSERT INTO campaign_contacts (id, campaignId, contactId, createdAt, firstSentAt, lastOutboundAt) VALUES (@id, @campaignId, @contactId, @createdAt, @firstSentAt, @lastOutboundAt)"),
  updateMembership: db.prepare("UPDATE campaign_contacts SET firstSentAt=@firstSentAt, lastOutboundAt=@lastOutboundAt WHERE id=@id"),
  deleteMembership: db.prepare("DELETE FROM campaign_contacts WHERE id = ?"),
  countMembershipsByCampaign: db.prepare("SELECT COUNT(*) as count FROM campaign_contacts WHERE campaignId = ?"),
  getUnsentMembershipsByCampaign: db.prepare("SELECT * FROM campaign_contacts WHERE campaignId = ? AND firstSentAt IS NULL"),

  // Photos
  getPhotosByCampaign: db.prepare("SELECT * FROM photos WHERE campaignId = ?"),
  getPhotosByContact: db.prepare("SELECT * FROM photos WHERE contactId = ?"),
  getAllPhotos: db.prepare("SELECT * FROM photos ORDER BY createdAt DESC"),
  getPhotosByHash: db.prepare("SELECT * FROM photos WHERE contentHash = ?"),
  insertPhoto: db.prepare("INSERT INTO photos (id, phoneNumber, filename, createdAt, campaignId, contactId, assignedFromLastOutboundAt, contentHash, similarInOtherCampaigns, driveFileId, driveWebViewLink) VALUES (@id, @phoneNumber, @filename, @createdAt, @campaignId, @contactId, @assignedFromLastOutboundAt, @contentHash, @similarInOtherCampaigns, @driveFileId, @driveWebViewLink)"),
  updatePhotoSimilar: db.prepare("UPDATE photos SET similarInOtherCampaigns = ? WHERE id = ?"),
  updatePhotoDriveInfo: db.prepare("UPDATE photos SET driveFileId = ?, driveWebViewLink = ? WHERE id = ?"),
  getPhotosWithoutDrive: db.prepare("SELECT * FROM photos WHERE driveFileId IS NULL ORDER BY createdAt DESC"),
  getPhotoById: db.prepare("SELECT * FROM photos WHERE id = ?"),
  countPhotosByCampaign: db.prepare("SELECT COUNT(*) as count FROM photos WHERE campaignId = ?"),

  // Send log
  getSendLogByCampaign: db.prepare("SELECT * FROM send_log WHERE campaignId = ? ORDER BY sentAt DESC"),
  getAllSendLog: db.prepare("SELECT * FROM send_log ORDER BY sentAt DESC"),
  insertSendLog: db.prepare("INSERT INTO send_log (id, campaignId, type, sentAt, targetCount, acceptedCount, failedCount, message, results) VALUES (@id, @campaignId, @type, @sentAt, @targetCount, @acceptedCount, @failedCount, @message, @results)"),

  // Opt-outs
  getAllOptOuts: db.prepare("SELECT phoneNumber FROM opt_outs"),
  isOptedOut: db.prepare("SELECT 1 FROM opt_outs WHERE phoneNumber = ?"),
  insertOptOut: db.prepare("INSERT OR IGNORE INTO opt_outs (phoneNumber) VALUES (?)"),
  deleteOptOut: db.prepare("DELETE FROM opt_outs WHERE phoneNumber = ?"),
};

// ---------- JSON import (one-time migration) ----------
// If JSON files exist and the database is empty, import them automatically.

function migrateFromJson() {
  const contactCount = db.prepare("SELECT COUNT(*) as c FROM global_contacts").get().c;
  const campaignCount = db.prepare("SELECT COUNT(*) as c FROM campaigns").get().c;

  // Only migrate if database is empty (fresh install)
  if (contactCount > 0 || campaignCount > 0) return;

  console.log("SQLite database is empty — checking for JSON files to import...");

  const tryRead = (filePath, fallback) => {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch { return fallback; }
  };

  const jsonDir = DATA_DIR;

  // Global contacts
  const gcData = tryRead(path.join(jsonDir, "global-contacts.json"), { contacts: [] });
  const contacts = Array.isArray(gcData) ? gcData : (gcData.contacts || []);
  const insertContactTxn = db.transaction((rows) => {
    for (const c of rows) stmts.insertContact.run(c);
  });
  if (contacts.length) {
    insertContactTxn(contacts);
    console.log(`  Imported ${contacts.length} global contacts`);
  }

  // Campaigns
  const campData = tryRead(path.join(jsonDir, "campaigns.json"), { campaigns: [] });
  const campaigns = Array.isArray(campData) ? campData : (campData.campaigns || []);
  const insertCampTxn = db.transaction((rows) => {
    for (const c of rows) {
      stmts.insertCampaign.run({
        ...c,
        isLocked: c.isLocked ? 1 : 0,
        lockedAt: c.lockedAt || null,
        message: c.message || "",
        driveFolderId: c.driveFolderId || null
      });
    }
  });
  if (campaigns.length) {
    insertCampTxn(campaigns);
    console.log(`  Imported ${campaigns.length} campaigns`);
  }

  // Campaign contacts
  const ccData = tryRead(path.join(jsonDir, "campaign-contacts.json"), { memberships: [] });
  const memberships = Array.isArray(ccData) ? ccData : (ccData.memberships || []);
  const insertMemTxn = db.transaction((rows) => {
    for (const m of rows) {
      stmts.insertMembership.run({
        ...m,
        firstSentAt: m.firstSentAt || null,
        lastOutboundAt: m.lastOutboundAt || null
      });
    }
  });
  if (memberships.length) {
    insertMemTxn(memberships);
    console.log(`  Imported ${memberships.length} campaign contacts`);
  }

  // Photos
  const photoData = tryRead(path.join(jsonDir, "photos.json"), { photos: [] });
  const photos = Array.isArray(photoData) ? photoData : (photoData.photos || []);
  const insertPhotoTxn = db.transaction((rows) => {
    for (const p of rows) {
      stmts.insertPhoto.run({
        ...p,
        campaignId: p.campaignId || null,
        contactId: p.contactId || null,
        assignedFromLastOutboundAt: p.assignedFromLastOutboundAt || null,
        contentHash: p.contentHash || null,
        similarInOtherCampaigns: JSON.stringify(p.similarInOtherCampaigns || []),
        driveFileId: p.driveFileId || null,
        driveWebViewLink: p.driveWebViewLink || null
      });
    }
  });
  if (photos.length) {
    insertPhotoTxn(photos);
    console.log(`  Imported ${photos.length} photos`);
  }

  // Send log
  const slData = tryRead(path.join(jsonDir, "send-log.json"), { events: [] });
  const events = Array.isArray(slData) ? slData : (slData.events || []);
  const insertSlTxn = db.transaction((rows) => {
    for (const e of rows) {
      stmts.insertSendLog.run({
        ...e,
        results: JSON.stringify(e.results || [])
      });
    }
  });
  if (events.length) {
    insertSlTxn(events);
    console.log(`  Imported ${events.length} send log events`);
  }

  // Opt-outs
  const ooData = tryRead(path.join(jsonDir, "opt-outs.json"), { phoneNumbers: [] });
  const phoneNumbers = Array.isArray(ooData) ? ooData : (ooData.phoneNumbers || []);
  const insertOoTxn = db.transaction((rows) => {
    for (const p of rows) stmts.insertOptOut.run(p);
  });
  if (phoneNumbers.length) {
    insertOoTxn(phoneNumbers);
    console.log(`  Imported ${phoneNumbers.length} opt-outs`);
  }

  console.log("JSON migration complete.");
}

migrateFromJson();

// ---------- Export ----------
module.exports = { db, stmts };

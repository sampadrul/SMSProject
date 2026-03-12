/**
 * googleDrive.js — Google Drive integration
 *
 * How OAuth works (simplified):
 *   1. Your app has a "client ID" and "client secret" — these identify YOUR APP to Google
 *   2. A user (you) authorizes the app, and Google gives back a "refresh token"
 *   3. The refresh token is long-lived — your app uses it to get short-lived "access tokens"
 *   4. Access tokens expire every ~hour, but the refresh token lets you get new ones automatically
 *
 * Previously, credentials were stored in local JSON files. Now they come from env vars:
 *   GOOGLE_OAUTH_CLIENT_ID     — your app's client ID
 *   GOOGLE_OAUTH_CLIENT_SECRET — your app's client secret
 *   GOOGLE_OAUTH_REFRESH_TOKEN — the long-lived token from the one-time auth flow
 *
 * For local dev, it still falls back to reading the JSON files if env vars aren't set.
 */

const fs = require("fs");
const { Readable } = require("stream");
const path = require("path");
const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

// ---------- Credential loading ----------
// Try env vars first (for cloud), fall back to local files (for dev)

function getCredentials() {
  // Cloud mode: read from env vars
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://localhost"
    };
  }

  // Dev mode: read from local JSON file
  const credPath = process.env.GOOGLE_OAUTH_CREDENTIALS ||
    path.join(__dirname, "credentials", "google-oauth.json");

  if (!fs.existsSync(credPath)) {
    throw new Error(`No Google OAuth credentials found. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET env vars, or place credentials at: ${credPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(credPath, "utf8"));
  const creds = raw.installed || raw.web;
  return {
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    redirectUri: (creds.redirect_uris && creds.redirect_uris[0]) || "http://localhost"
  };
}

function getRefreshToken() {
  // Cloud mode: read from env var
  if (process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    return process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  }

  // Dev mode: read from local token file
  const tokenPath = process.env.GOOGLE_OAUTH_TOKEN ||
    path.join(__dirname, "credentials", "google-token.json");

  if (!fs.existsSync(tokenPath)) return null;

  const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  return token.refresh_token || null;
}

// ---------- OAuth client ----------

function getOAuthClient() {
  const { clientId, clientSecret, redirectUri } = getCredentials();
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const refreshToken = getRefreshToken();
  if (refreshToken) {
    // Setting the refresh token lets Google auto-refresh access tokens
    oAuth2Client.setCredentials({ refresh_token: refreshToken });
  }

  return oAuth2Client;
}

function getAuthUrl() {
  const oAuth2Client = getOAuthClient();
  return oAuth2Client.generateAuthUrl({
    access_type: "offline",  // "offline" means Google gives us a refresh token
    prompt: "consent",       // "consent" forces Google to show the approval screen
    scope: SCOPES
  });
}

async function exchangeCodeForToken(code) {
  const oAuth2Client = getOAuthClient();
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);

  // Save token locally for dev (in cloud, you'd copy the refresh token to env vars)
  const tokenPath = process.env.GOOGLE_OAUTH_TOKEN ||
    path.join(__dirname, "credentials", "google-token.json");
  try {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), "utf8");
  } catch (e) {
    // In cloud environments, we may not be able to write files — that's OK
    console.warn("Could not save token file (expected in cloud):", e.message);
  }

  return tokens;
}

function getDriveClient() {
  const auth = getOAuthClient();
  return google.drive({ version: "v3", auth });
}

async function uploadBufferToDrive({ buffer, filename, mimeType, folderId }) {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    throw new Error("Google Drive not authorized yet. Visit /google/auth first.");
  }

  const drive = getDriveClient();

  const fileMetadata = { name: filename };
  if (folderId) fileMetadata.parents = [folderId];

  const media = {
    mimeType: mimeType || "application/octet-stream",
    body: Readable.from(buffer)
  };

  const createRes = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id, name, webViewLink, webContentLink"
  });

  return createRes.data;
}

async function createDriveFolder({ folderName, parentFolderId }) {
  const drive = getDriveClient();

  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId]
    },
    fields: "id, name, webViewLink"
  });

  return res.data;
}

module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  uploadBufferToDrive,
  createDriveFolder,
  getDriveClient,
  getRefreshToken,
  getCredentials
};

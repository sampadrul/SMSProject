const fs = require("fs");
const { Readable } = require("stream");

const path = require("path");
const { google } = require("googleapis");

const CREDENTIALS_PATH = process.env.GOOGLE_OAUTH_CREDENTIALS ||
  path.join(__dirname, "credentials", "google-oauth.json");

const TOKEN_PATH = process.env.GOOGLE_OAUTH_TOKEN ||
  path.join(__dirname, "credentials", "google-token.json");

const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Missing OAuth credentials file at: ${CREDENTIALS_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
}

function saveToken(token) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), "utf8");
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
}

function getOAuthClient() {
  const credentials = loadCredentials();
  const { client_secret, client_id, redirect_uris } =
    credentials.installed || credentials.web;
  const redirectUri =
    redirect_uris && redirect_uris.length ? redirect_uris[0] : "http://localhost";

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirectUri
  );

  const token = loadToken();
  if (token) {
    oAuth2Client.setCredentials(token);
  }
  return oAuth2Client;
}

function getAuthUrl() {
  const oAuth2Client = getOAuthClient();
  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });
}

async function exchangeCodeForToken(code) {
  const oAuth2Client = getOAuthClient();
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  saveToken(tokens);
  return tokens;
}

function getDriveClient() {
  const auth = getOAuthClient();
  return google.drive({ version: "v3", auth });
}

async function uploadBufferToDrive({ buffer, filename, mimeType, folderId }) {
  const token = loadToken();
  if (!token) {
    throw new Error("Google Drive not authorized yet. Visit /google/auth first.");
  }

  const drive = getDriveClient();

  const fileMetadata = { name: filename };
  if (folderId) fileMetadata.parents = [folderId];

  const media = {
    mimeType: mimeType || "application/octet-stream",
    body: Readable.from(buffer)  // wrap Buffer in a Readable stream
  };


  const createRes = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id, name, webViewLink, webContentLink"
  });

  return createRes.data;
}

module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  uploadBufferToDrive
};

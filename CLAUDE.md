# Project: SMS Photo Campaign Tool

## About the Developer
I'm learning to code through vibe coding — building real projects with AI assistance. I'm not an experienced developer, so please:
- Explain what the code does and why as you go
- Define new concepts or terms when you introduce them
- Mention what alternatives exist and why you chose this approach
- When making significant changes, walk me through them step by step

## Stack
- **Backend**: Node.js + Express
- **Database**: SQLite via better-sqlite3 (migrated from JSON files)
- **Auth**: express-session + bcryptjs (password login)
- **SMS/MMS**: Twilio API
- **Photo storage**: Google Drive (primary), local downloads/ (dev fallback)
- **Frontend**: Vanilla HTML/CSS/JS with blue theme (Inter font)

## Key Architecture Decisions
- Single-user app — one admin password, no user management
- SQLite in `data/app.db` — all data in one file, easy to back up
- Photos served via `/api/photos/serve/:id` proxy (streams from Google Drive)
- Twilio webhook at `/twilio/inbound` is public (no auth) — all other routes require login
- Progressive step disclosure on campaign page (steps unlock as you complete them)

## Conventions
- IDs use format: `prefix_timestamp_randomhex` (e.g., `camp_1772830345134_d66fed5c2e`)
- Phone numbers normalized to `+1XXXXXXXXXX` format
- All timestamps stored as ISO 8601 strings
- Database queries use prepared statements from `db.js`

## Deployment Plan
Targeting Railway with:
- Persistent volume for SQLite at `/data`
- Google Drive OAuth via environment variables (not local credential files)
- Cloudflare R2 for photo CDN (future addition)

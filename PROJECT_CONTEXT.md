This project is an SMS photo campaign tool.
Stack:
- Node.js
- Express
- Twilio SMS/MMS webhook
- Google Drive storage
- Local JSON storage
Main files:
server.js → backend
dashboard.html → campaign manager
campaign.html → campaign UI
contacts.html → contact management
photos.html → photo gallery
Flow:
1. Create campaign
2. Send SMS via Twilio
3. User replies with MMS
4. Server downloads media from Twilio
5. Photo stored locally + Google Drive
6. Image associated with campaign/contact

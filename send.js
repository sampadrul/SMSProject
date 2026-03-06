// Load environment variables from .env
require("dotenv").config();

// Import Twilio SDK
const twilio = require("twilio");

// Create Twilio REST client using your credentials
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Your personal cell number (must be verified if you're on a Twilio trial)
const TO_PHONE_NUMBER = "+17733497671";

async function main() {
  try {
    const message = await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER, // your Twilio number
      to: TO_PHONE_NUMBER,                   // your cell
      body: "Hey! Please reply with a photo 📸"
    });

    console.log("Message sent! SID:", message.sid);
  } catch (err) {
    console.error("Failed to send message.");
    console.error(err?.message || err);
  }
}

main();
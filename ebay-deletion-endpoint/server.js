const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// ======================================
// CONFIGURE THESE VALUES
// ======================================
const VERIFICATION_TOKEN = "your_secret_token_here_change_this"; // Create your own secret token
const ENDPOINT_URL = "https://ebay.fetz.dev/ebay/deletion"; // Your public endpoint URL
const PORT = 3001;
// ======================================

// Helper to create challenge response
function createChallengeResponse(challengeCode) {
  const hash = crypto.createHash("sha256");
  hash.update(challengeCode);
  hash.update(VERIFICATION_TOKEN);
  hash.update(ENDPOINT_URL);
  return hash.digest("hex");
}

// GET - eBay verification challenge
app.get("/ebay/deletion", (req, res) => {
  const challengeCode = req.query.challenge_code;

  if (!challengeCode) {
    console.log("Health check or invalid request (no challenge_code)");
    return res.status(200).json({ status: "Endpoint active" });
  }

  console.log(`Received verification challenge: ${challengeCode}`);

  const challengeResponse = createChallengeResponse(challengeCode);
  console.log(`Responding with: ${challengeResponse}`);

  res.status(200).json({ challengeResponse });
});

// POST - eBay account deletion notification
app.post("/ebay/deletion", (req, res) => {
  console.log("=== ACCOUNT DELETION NOTIFICATION ===");
  console.log("Time:", new Date().toISOString());
  console.log("Body:", JSON.stringify(req.body, null, 2));

  // eBay sends user info that needs to be deleted
  // For this bot, we don't store eBay user data, so just acknowledge
  const notification = req.body;

  if (notification?.metadata?.topic === "MARKETPLACE_ACCOUNT_DELETION") {
    console.log("User requested deletion:", notification.notification?.data?.username);
    // If you stored user data, you would delete it here
  }

  // Acknowledge receipt
  res.status(200).json({ status: "received" });
});

app.listen(PORT, () => {
  console.log(`eBay deletion endpoint running on port ${PORT}`);
  console.log(`Endpoint URL: ${ENDPOINT_URL}`);
  console.log(`Verification Token: ${VERIFICATION_TOKEN.slice(0, 4)}****`);
  console.log("");
  console.log("Make sure to:");
  console.log("1. Update VERIFICATION_TOKEN with your own secret");
  console.log("2. Update ENDPOINT_URL to match your public URL");
  console.log("3. Set up reverse proxy (nginx) to route to this port");
});

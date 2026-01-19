const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const config = require("./config.json");
const {
  token,
  guildId,
  intakeChannelId,
  listingCategoryId,
  staffRoleId,
  dataFile,
  ebayIntakeChannelId,
  ebayAuctionsCategoryId,
  ebayBuyItNowCategoryId,
  ebayArchivedCategoryId,
} = config;

// Config-based eBay credentials (optional - can be empty)
const configEbayAppId = config.ebayAppId || "";
const configEbayDevId = config.ebayDevId || "";
const configEbayCertId = config.ebayCertId || "";

// -------------------------
// Slash Command Definitions
// -------------------------
const commands = [
  new SlashCommandBuilder()
    .setName("ebay-setup")
    .setDescription("Configure eBay API credentials")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("ebay-status")
    .setDescription("Check eBay API configuration status")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("ebay-clear")
    .setDescription("Remove eBay API credentials")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("ebay-organize")
    .setDescription("Check all eBay listings and move them to correct categories")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(config.clientId || "", guildId), {
      body: commands.map((c) => c.toJSON()),
    });
    console.log("Slash commands registered.");
  } catch (err) {
    // If clientId not configured, try to get it from the bot's application
    if (!config.clientId) {
      console.log("clientId not in config, fetching from Discord...");
      try {
        const app = await rest.get(Routes.oauth2CurrentApplication());
        await rest.put(Routes.applicationGuildCommands(app.id, guildId), {
          body: commands.map((c) => c.toJSON()),
        });
        console.log("Slash commands registered.");
      } catch (innerErr) {
        console.error("Failed to register slash commands:", innerErr);
      }
    } else {
      console.error("Failed to register slash commands:", err);
    }
  }
}

// ---- Intents ----
// Guilds: interactions + channels
// GuildMessages: to receive messageCreate for attachments in listing channels
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

// ---- Crash report logging ----
const crashReportsDir = path.join(__dirname, "crash_reports");

function writeCrashReport(type, error) {
  try {
    // Ensure crash_reports folder exists
    if (!fs.existsSync(crashReportsDir)) {
      fs.mkdirSync(crashReportsDir, { recursive: true });
    }

    // Find next index
    const existingFiles = fs.readdirSync(crashReportsDir)
      .filter(f => f.startsWith("crash_report_") && f.endsWith(".txt"));
    const indices = existingFiles.map(f => {
      const match = f.match(/crash_report_(\d+)\.txt/);
      return match ? parseInt(match[1], 10) : 0;
    });
    const nextIndex = indices.length > 0 ? Math.max(...indices) + 1 : 1;

    // Build report content
    const timestamp = new Date().toISOString();
    const stack = error?.stack || String(error);
    const report = [
      `=== CRASH REPORT #${nextIndex} ===`,
      `Type: ${type}`,
      `Time: ${timestamp}`,
      ``,
      `Error: ${error?.message || String(error)}`,
      ``,
      `Stack Trace:`,
      stack,
      ``,
      `=== END REPORT ===`,
    ].join("\n");

    // Write file
    const filePath = path.join(crashReportsDir, `crash_report_${nextIndex}.txt`);
    fs.writeFileSync(filePath, report, "utf8");
    console.error(`Crash report written to: ${filePath}`);
  } catch (writeErr) {
    console.error("Failed to write crash report:", writeErr);
  }
}

// ---- Global error handlers to prevent crashes ----
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
  writeCrashReport("Unhandled Promise Rejection", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  writeCrashReport("Uncaught Exception", err);
});

// ---- Discord client error handling ----
client.on("error", (err) => {
  console.error("Discord client error:", err);
  writeCrashReport("Discord Client Error", err);
});

client.on("shardError", (err) => {
  console.error("Discord websocket error:", err);
  writeCrashReport("Discord WebSocket Error", err);
});

client.on("shardDisconnect", (event, shardId) => {
  console.warn(`Shard ${shardId} disconnected (code ${event.code}). Reconnecting...`);
});

client.on("shardReconnecting", (shardId) => {
  console.log(`Shard ${shardId} reconnecting...`);
});

// -------------------------
// Simple JSON "DB"
// -------------------------
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadDb() {
  try {
    if (!fs.existsSync(dataFile)) return { panelMessageId: null, listings: {} };
    return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch {
    return { panelMessageId: null, listings: {} };
  }
}

function saveDb(db) {
  ensureDir(dataFile);
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), "utf8");
}

function slugify(str, maxLen = 30) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
}

function shortId() {
  return Math.random().toString(36).slice(2, 7);
}

// Creates a simplified channel name, checking for duplicates in the category
async function createUniqueChannelName(guild, categoryId, emoji, baseName) {
  // Simplify the name - take first 2-3 significant words
  const words = baseName.split(/[\s-]+/).filter(w => w.length > 1);
  const simplified = words.slice(0, 3).join("-");
  const slug = slugify(simplified, 25);

  // Get existing channels in the category
  const category = await guild.channels.fetch(categoryId).catch(() => null);
  const existingNames = new Set();

  if (category) {
    const channels = guild.channels.cache.filter(c => c.parentId === categoryId);
    channels.forEach(c => existingNames.add(c.name.toLowerCase()));
  }

  // Check if base name exists, add number if needed
  let finalName = `${emoji}${slug}`;
  if (!existingNames.has(finalName.toLowerCase())) {
    return finalName;
  }

  // Find next available number
  let counter = 2;
  while (existingNames.has(`${emoji}${slug}-${counter}`.toLowerCase())) {
    counter++;
  }

  return `${emoji}${slug}-${counter}`;
}

function isImageAttachment(att) {
  if (att.contentType && att.contentType.startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|gif)$/i.test(att.url);
}

function memberIsStaff(interaction) {
  // Prefer role check; fallback to permission check
  const hasRole =
    interaction.member?.roles?.cache?.has(staffRoleId) ||
    interaction.member?.roles?.includes?.(staffRoleId);
  const hasPerm = interaction.memberPermissions?.has(
    PermissionFlagsBits.ManageChannels
  );
  return Boolean(hasRole || hasPerm);
}

// -------------------------
// eBay API (optional - falls back to scraping if not configured)
// -------------------------
let ebayAccessToken = null;
let ebayTokenExpiry = 0;

// Get eBay credentials from database first, then fall back to config
function getEbayCredentials() {
  const db = loadDb();
  if (db.ebayCredentials?.appId && db.ebayCredentials?.certId) {
    return {
      appId: db.ebayCredentials.appId,
      devId: db.ebayCredentials.devId || "",
      certId: db.ebayCredentials.certId,
      source: "database",
    };
  }
  if (configEbayAppId && configEbayCertId) {
    return {
      appId: configEbayAppId,
      devId: configEbayDevId,
      certId: configEbayCertId,
      source: "config",
    };
  }
  return null;
}

// Check if eBay API is enabled (credentials are configured)
function isEbayApiEnabled() {
  return getEbayCredentials() !== null;
}

async function getEbayAccessToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (ebayAccessToken && Date.now() < ebayTokenExpiry - 300000) {
    return ebayAccessToken;
  }

  const creds = getEbayCredentials();
  if (!creds) {
    throw new Error("eBay API credentials not configured");
  }

  const credentials = Buffer.from(`${creds.appId}:${creds.certId}`).toString("base64");

  const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
    },
    body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`eBay OAuth failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  ebayAccessToken = data.access_token;
  ebayTokenExpiry = Date.now() + (data.expires_in * 1000);

  console.log("eBay API token obtained, expires in", data.expires_in, "seconds");
  return ebayAccessToken;
}

async function fetchEbayListingViaAPI(url) {
  // Extract item ID from URL
  const itemIdMatch = url.match(/\/itm\/(?:.*\/)?(\d+)/);
  if (!itemIdMatch) {
    throw new Error("Could not extract item ID from URL");
  }
  const itemId = itemIdMatch[1];

  const token = await getEbayAccessToken();

  const response = await fetch(`https://api.ebay.com/buy/browse/v1/item/v1|${itemId}|0`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "X-EBAY-C-ENDUSERCTX": "affiliateCampaignId=<ePNCampaignId>,affiliateReferenceId=<referenceId>",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`eBay API error: ${response.status} - ${error}`);
  }

  const item = await response.json();

  // Parse the API response into our standard format
  const endTime = item.itemEndDate ? new Date(item.itemEndDate).getTime() : null;

  // Determine listing type from buyingOptions
  const buyingOptions = item.buyingOptions || [];
  const isAuction = buyingOptions.includes("AUCTION");
  const isFixedPrice = buyingOptions.includes("FIXED_PRICE");

  let listingType;
  let buyItNowPrice = null;

  if (isAuction && isFixedPrice) {
    listingType = "auction_with_bin";
    // For auction+BIN, the main price is current bid, BIN price is in currentBidPrice or buyItNowPrice
    buyItNowPrice = item.buyItNowPrice ? `${item.buyItNowPrice.currency} $${item.buyItNowPrice.value}` : null;
  } else if (isAuction) {
    listingType = "auction";
  } else {
    listingType = "buy_it_now";
  }

  return {
    title: item.title || "Unknown Item",
    currentPrice: item.price ? `${item.price.currency} $${item.price.value}` : "N/A",
    bidCount: item.bidCount || 0,
    endTime,
    imageUrl: item.image?.imageUrl || null,
    description: item.shortDescription || item.description?.substring(0, 500) || "",
    views: item.viewCount || 0,
    watchers: item.watchCount || 0,
    status: item.itemEndDate && new Date(item.itemEndDate) < new Date() ? "ended" : "active",
    source: "api",
    listingType,
    buyItNowPrice,
  };
}

// -------------------------
// eBay Scraper (fallback)
// -------------------------
async function scrapeEbayListing(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch eBay listing: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // Extract title
  const title = $("h1.x-item-title__mainTitle span").text().trim() ||
                $("h1[itemprop='name']").text().trim() ||
                $(".x-item-title__mainTitle").text().trim() ||
                "Unknown Item";

  // Extract current price
  let currentPrice = $(".x-price-primary span").first().text().trim() ||
                     $("[itemprop='price']").attr("content") ||
                     $(".x-bin-price__content span").first().text().trim() ||
                     "N/A";

  // Extract bid count
  let bidCount = 0;
  const bidText = $(".x-bid-count span").text().trim() ||
                  $("[data-testid='x-bid-count'] span").text().trim();
  const bidMatch = bidText.match(/(\d+)\s*bid/i);
  if (bidMatch) {
    bidCount = parseInt(bidMatch[1], 10);
  }

  // Extract end time - try multiple methods
  let endTime = null;

  // Method 1: Look for timer data in scripts (most reliable)
  $("script").each((i, el) => {
    if (endTime) return;
    const scriptContent = $(el).html() || "";

    // Look for various timestamp patterns in eBay's scripts
    const patterns = [
      /"endTime":\s*(\d{13})/,
      /"timeMs":\s*(\d{13})/,
      /"startTime":\s*\d+,\s*"endTime":\s*(\d{13})/,
      /endTimeMs['"]\s*:\s*(\d{13})/,
      /"Timer"[^}]*"endTime":\s*(\d{13})/,
    ];

    for (const pattern of patterns) {
      const match = scriptContent.match(pattern);
      if (match) {
        endTime = parseInt(match[1], 10);
        break;
      }
    }
  });

  // Method 2: Look for countdown timer element data attributes
  if (!endTime) {
    const timerEl = $("[data-timer], .x-timer, .vi-tm-left");
    const timerData = timerEl.attr("data-timer") || timerEl.attr("data-end-time");
    if (timerData) {
      const parsed = parseInt(timerData, 10);
      if (!isNaN(parsed)) endTime = parsed;
    }
  }

  // Method 3: Parse displayed end time text
  if (!endTime) {
    const endTimeText = $(".x-end-time span").text().trim() ||
                        $("[data-testid='x-end-time']").text().trim() ||
                        $(".vi-tm-left").text().trim() ||
                        $(".ux-timer__text").text().trim();

    if (endTimeText) {
      // Try direct parse first
      let parsed = Date.parse(endTimeText);

      // Handle relative time like "1d 5h" or "2h 30m"
      if (isNaN(parsed)) {
        const daysMatch = endTimeText.match(/(\d+)\s*d/i);
        const hoursMatch = endTimeText.match(/(\d+)\s*h/i);
        const minsMatch = endTimeText.match(/(\d+)\s*m/i);

        if (daysMatch || hoursMatch || minsMatch) {
          const days = daysMatch ? parseInt(daysMatch[1], 10) : 0;
          const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
          const mins = minsMatch ? parseInt(minsMatch[1], 10) : 0;
          endTime = Date.now() + (days * 86400000) + (hours * 3600000) + (mins * 60000);
        }
      } else {
        endTime = parsed;
      }
    }
  }

  // Extract views count
  let views = 0;
  const viewsText = $(".d-view-count").text().trim() ||
                    $("[data-testid='x-view-count']").text().trim() ||
                    $(".vi-notify-new-bg span").text().trim();
  const viewsMatch = viewsText.match(/([\d,]+)\s*view/i);
  if (viewsMatch) {
    views = parseInt(viewsMatch[1].replace(/,/g, ""), 10);
  }

  // Extract watchers count
  let watchers = 0;
  const watchersText = $(".d-watch-count").text().trim() ||
                       $("[data-testid='x-watch-count']").text().trim() ||
                       $(".vi-notify-new-bg").text().trim();
  const watchersMatch = watchersText.match(/([\d,]+)\s*watch/i);
  if (watchersMatch) {
    watchers = parseInt(watchersMatch[1].replace(/,/g, ""), 10);
  }

  // Extract image URL
  const imageUrl = $(".ux-image-carousel-item img").first().attr("src") ||
                   $("[itemprop='image']").attr("content") ||
                   $(".x-photos-min-view img").first().attr("src") ||
                   $("img[data-testid='ux-image-carousel-item']").first().attr("src") ||
                   null;

  // Extract description (truncated)
  let description = $(".x-item-description-text").text().trim() ||
                    $("[data-testid='item-description'] iframe").attr("srcdoc") ||
                    "";

  // If description is in iframe srcdoc, try to parse it
  if (description.includes("<")) {
    const descDoc = cheerio.load(description);
    description = descDoc.text().trim();
  }

  description = description.slice(0, 500);
  if (description.length === 500) description += "...";

  // Determine if auction is ended
  const isEnded = $(".ended-msg").length > 0 ||
                  $(".x-end-panel").text().toLowerCase().includes("ended") ||
                  html.toLowerCase().includes("bidding has ended");

  // Determine listing type
  // Check for auction indicators (bid count element, "Place bid" button, bid history)
  const hasAuctionIndicators = $(".x-bid-count").length > 0 ||
                               $("[data-testid='x-bid-count']").length > 0 ||
                               html.includes("Place bid") ||
                               html.includes("bid history");

  // Check for Buy It Now indicators
  const hasBinIndicators = $(".x-bin-price").length > 0 ||
                           $("[data-testid='x-bin-action']").length > 0 ||
                           html.includes("Buy It Now");

  let listingType;
  let buyItNowPrice = null;

  if (hasAuctionIndicators && hasBinIndicators) {
    listingType = "auction_with_bin";
    // Extract BIN price
    const binPriceText = $(".x-bin-price__content span").first().text().trim() ||
                         $(".x-bin-price span.ux-textspans").first().text().trim();
    if (binPriceText) {
      buyItNowPrice = binPriceText;
    }
  } else if (hasAuctionIndicators) {
    listingType = "auction";
  } else {
    listingType = "buy_it_now";
  }

  return {
    title,
    currentPrice,
    bidCount,
    endTime,
    imageUrl,
    description,
    views,
    watchers,
    status: isEnded ? "ended" : "active",
    source: "scrape",
    listingType,
    buyItNowPrice,
  };
}

// -------------------------
// eBay Listing Fetcher (API with scrape fallback)
// -------------------------
async function getEbayListing(url) {
  // Try API first if configured
  if (isEbayApiEnabled()) {
    try {
      const listing = await fetchEbayListingViaAPI(url);
      console.log(`Fetched listing via eBay API: ${listing.title}`);
      return listing;
    } catch (err) {
      console.warn(`eBay API failed, falling back to scraping: ${err.message}`);
    }
  }

  // Fallback to scraping
  const listing = await scrapeEbayListing(url);
  console.log(`Fetched listing via scraping: ${listing.title}`);
  return listing;
}

// -------------------------
// Panel message (Create Listing button)
// -------------------------
function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setTitle("Create a Listing Ticket")
    .setDescription(
      "Press the button below to create a new listing channel.\n\nYou'll be asked for an item name and optional description, then a private channel will be created for uploading photos."
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("listing_create")
      .setLabel("Create Listing")
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

async function ensurePanelMessage() {
  const db = loadDb();

  const guild = await client.guilds.fetch(guildId);
  const intakeChannel = await guild.channels.fetch(intakeChannelId);

  if (!intakeChannel || intakeChannel.type !== ChannelType.GuildText) {
    throw new Error("intakeChannelId is not a text channel (GuildText).");
  }

  // Try to re-use existing panel message (avoid re-posting on restarts)
  if (db.panelMessageId) {
    try {
      const existing = await intakeChannel.messages.fetch(db.panelMessageId);
      if (existing) return;
    } catch {
      // If it can't be fetched (deleted), we will recreate it.
    }
  }

  const msg = await intakeChannel.send(buildPanelMessage());
  db.panelMessageId = msg.id;
  saveDb(db);
}

// -------------------------
// eBay Panel message
// -------------------------
function buildEbayPanelMessage() {
  const embed = new EmbedBuilder()
    .setTitle("Track an eBay Listing")
    .setDescription(
      "Press the button below to start tracking an eBay auction.\n\nYou'll be asked for an eBay listing URL, then a channel will be created to track the listing's price and bid updates."
    )
    .setColor(0x0064d2); // eBay blue

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ebay_add")
      .setLabel("Add eBay Listing")
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

async function ensureEbayPanelMessage() {
  if (!ebayIntakeChannelId) return; // Skip if not configured

  const db = loadDb();
  if (!db.ebayPanelMessageId) db.ebayPanelMessageId = null;
  if (!db.ebayListings) db.ebayListings = {};

  const guild = await client.guilds.fetch(guildId);
  const ebayIntakeChannel = await guild.channels.fetch(ebayIntakeChannelId);

  if (!ebayIntakeChannel || ebayIntakeChannel.type !== ChannelType.GuildText) {
    throw new Error("ebayIntakeChannelId is not a text channel (GuildText).");
  }

  // Try to re-use existing panel message
  if (db.ebayPanelMessageId) {
    try {
      const existing = await ebayIntakeChannel.messages.fetch(db.ebayPanelMessageId);
      if (existing) return;
    } catch {
      // If it can't be fetched (deleted), we will recreate it.
    }
  }

  const msg = await ebayIntakeChannel.send(buildEbayPanelMessage());
  db.ebayPanelMessageId = msg.id;
  saveDb(db);
}

// -------------------------
// eBay Listing Embed
// -------------------------
function formatTimeLeft(endTime) {
  if (!endTime) return "Unknown";

  const now = Date.now();
  const diff = endTime - now;

  if (diff <= 0) return "Ended";

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

  return parts.join(" ");
}

function buildEbayListingEmbed(listing) {
  // Determine color based on status and listing type
  let color = 0x0064d2; // eBay blue for active
  if (listing.status === "ended" || listing.status === "sold" || listing.status === "shipped") {
    color = 0x808080; // Gray for ended/sold/shipped
  }

  const embed = new EmbedBuilder()
    .setTitle(listing.title)
    .setColor(color);

  // Build description with BIN price for auction+BIN listings
  let description = listing.description || "";
  if (listing.listingType === "auction_with_bin" && listing.buyItNowPrice) {
    description = `**Buy It Now: ${listing.buyItNowPrice}**\n\n${description}`;
  }
  if (description) {
    embed.setDescription(description);
  }

  // Adjust fields based on listing type
  if (listing.listingType === "buy_it_now") {
    embed.addFields(
      { name: "Price", value: listing.currentPrice || "N/A", inline: true },
      { name: "Views", value: String(listing.views || 0), inline: true },
      { name: "Watchers", value: String(listing.watchers || 0), inline: true }
    );
  } else {
    // Auction or auction_with_bin
    embed.addFields(
      { name: "Current Bid", value: listing.currentPrice || "N/A", inline: true },
      { name: "Bids", value: String(listing.bidCount), inline: true },
      { name: "Time Left", value: formatTimeLeft(listing.endTime), inline: true },
      { name: "Views", value: String(listing.views || 0), inline: true },
      { name: "Watchers", value: String(listing.watchers || 0), inline: true }
    );
  }

  embed.setFooter({ text: `Last updated: ${new Date(listing.lastChecked).toLocaleString()} | via ${listing.source === "api" ? "eBay API" : "web scrape"}` });

  if (listing.imageUrl) {
    embed.setImage(listing.imageUrl);
  }

  // Update title based on status
  if (listing.status === "ended") {
    embed.setTitle(`[ENDED] ${listing.title}`);
  } else if (listing.status === "sold") {
    embed.setTitle(`[SOLD] ${listing.title}`);
  } else if (listing.status === "shipped") {
    embed.setTitle(`[SHIPPED] ${listing.title}`);
  }

  return embed;
}

function buildEbayListingButtons(listing) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId("ebay_refresh")
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setLabel("Open on eBay")
      .setStyle(ButtonStyle.Link)
      .setURL(listing.url),
  ];

  const isAuction = listing.listingType === "auction" || listing.listingType === "auction_with_bin";
  const isBuyItNow = listing.listingType === "buy_it_now";

  if (listing.status === "active") {
    // Active listings
    if (isBuyItNow) {
      // BIN (active): Refresh, Open on eBay, Mark Sold, Close Tracking
      buttons.push(
        new ButtonBuilder()
          .setCustomId("ebay_sold")
          .setLabel("Mark Sold")
          .setStyle(ButtonStyle.Success)
      );
    }
    // Both types get Close Tracking when active
    buttons.push(
      new ButtonBuilder()
        .setCustomId("ebay_close")
        .setLabel("Close Tracking")
        .setStyle(ButtonStyle.Danger)
    );
  } else if (listing.status === "ended" || listing.status === "sold") {
    // Ended auctions or sold BIN: Refresh, Open on eBay, Mark Shipped
    buttons.push(
      new ButtonBuilder()
        .setCustomId("ebay_shipped")
        .setLabel("Mark Shipped")
        .setStyle(ButtonStyle.Success)
    );
  }
  // shipped status: only Refresh and Open on eBay buttons

  return new ActionRowBuilder().addComponents(buttons);
}

// -------------------------
// Ticket channel message (upload instructions + buttons)
// -------------------------
function buildListingIntroMessage(itemName, itemDesc, ownerId) {
  const embed = new EmbedBuilder()
    .setTitle("Listing Ticket Created")
    .addFields(
      { name: "Owner", value: `<@${ownerId}>`, inline: true },
      { name: "Item", value: itemName || "-", inline: true },
      { name: "Description", value: itemDesc?.trim() ? itemDesc : "-" }
    )
    .setDescription(
      [
        "✅ Upload product photos in this channel.",
        "• Add multiple angles, labels, serial numbers, flaws, etc.",
        "• When you're finished, press **Done Uploading**.",
      ].join("\n")
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("listing_done")
      .setLabel("Done Uploading")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("listing_close")
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

// -------------------------
// Ready
// -------------------------
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);

  // Register slash commands
  await registerSlashCommands();

  try {
    await ensurePanelMessage();
    console.log("Listing panel ensured.");
  } catch (err) {
    console.error("Failed to ensure panel message:", err);
  }

  try {
    await ensureEbayPanelMessage();
    if (ebayIntakeChannelId) {
      console.log("eBay panel ensured.");
      console.log(`eBay API: ${isEbayApiEnabled() ? "enabled" : "disabled (using web scraping)"}`);
      startEbayUpdateLoop();
    }
  } catch (err) {
    console.error("Failed to ensure eBay panel message:", err);
  }
});

// -------------------------
// Interactions: button + modal submit
// -------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  const db = loadDb();

  // ---- Slash Commands ----
  if (interaction.isChatInputCommand()) {
    // /ebay-setup - Show modal to configure credentials
    if (interaction.commandName === "ebay-setup") {
      const modal = new ModalBuilder()
        .setCustomId("ebay_setup_modal")
        .setTitle("Configure eBay API Credentials");

      const appIdInput = new TextInputBuilder()
        .setCustomId("ebay_app_id")
        .setLabel("App ID (Client ID)")
        .setPlaceholder("YourApp-Sellboy-PRD-xxxxxxxx-xxxxxxxx")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

      const devIdInput = new TextInputBuilder()
        .setCustomId("ebay_dev_id")
        .setLabel("Dev ID (optional)")
        .setPlaceholder("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(100);

      const certIdInput = new TextInputBuilder()
        .setCustomId("ebay_cert_id")
        .setLabel("Cert ID (Client Secret)")
        .setPlaceholder("PRD-xxxxxxxx-xxxx-xxxx-xxxx-xxxx")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

      modal.addComponents(
        new ActionRowBuilder().addComponents(appIdInput),
        new ActionRowBuilder().addComponents(devIdInput),
        new ActionRowBuilder().addComponents(certIdInput)
      );

      await interaction.showModal(modal);
      return;
    }

    // /ebay-status - Check API configuration status
    if (interaction.commandName === "ebay-status") {
      await interaction.deferReply({ ephemeral: true });

      const creds = getEbayCredentials();
      if (!creds) {
        await interaction.editReply({
          content: "**eBay API Status**\n\n❌ Not configured\n\nUse `/ebay-setup` to configure credentials.",
        });
        return;
      }

      // Test the API connection
      let testResult = "⏳ Testing...";
      try {
        // Clear cached token to force a fresh test
        ebayAccessToken = null;
        ebayTokenExpiry = 0;
        await getEbayAccessToken();
        testResult = "✅ Connection successful";
      } catch (err) {
        testResult = `❌ Connection failed: ${err.message}`;
      }

      const maskedAppId = creds.appId.slice(0, 8) + "..." + creds.appId.slice(-4);
      const maskedCertId = creds.certId.slice(0, 8) + "..." + creds.certId.slice(-4);

      await interaction.editReply({
        content: [
          "**eBay API Status**",
          "",
          `✅ Configured (source: ${creds.source})`,
          `App ID: \`${maskedAppId}\``,
          `Cert ID: \`${maskedCertId}\``,
          "",
          `**API Test:** ${testResult}`,
        ].join("\n"),
      });
      return;
    }

    // /ebay-clear - Remove stored credentials
    if (interaction.commandName === "ebay-clear") {
      await interaction.deferReply({ ephemeral: true });

      const creds = getEbayCredentials();
      if (!creds) {
        await interaction.editReply({
          content: "No eBay credentials are configured.",
        });
        return;
      }

      if (creds.source === "config") {
        await interaction.editReply({
          content: "⚠️ Credentials are stored in `config.json`, not the database.\n\nTo remove them, edit the config file directly and remove the `ebayAppId`, `ebayDevId`, and `ebayCertId` fields.",
        });
        return;
      }

      // Remove from database
      delete db.ebayCredentials;
      saveDb(db);

      // Clear cached token
      ebayAccessToken = null;
      ebayTokenExpiry = 0;

      await interaction.editReply({
        content: "✅ eBay credentials have been removed from the database.",
      });
      return;
    }

    // /ebay-organize - Organize all eBay listings into correct categories
    if (interaction.commandName === "ebay-organize") {
      await interaction.deferReply({ ephemeral: true });

      const guild = await client.guilds.fetch(guildId);
      const results = {
        total: 0,
        moved: 0,
        emojiUpdated: 0,
        typeDetected: 0,
        errors: 0,
        skipped: 0,
      };

      if (!db.ebayListings || Object.keys(db.ebayListings).length === 0) {
        await interaction.editReply({
          content: "No eBay listings found in the database.",
        });
        return;
      }

      for (const [channelId, listing] of Object.entries(db.ebayListings)) {
        results.total++;

        try {
          // Fetch the channel
          const channel = await guild.channels.fetch(channelId).catch(() => null);
          if (!channel) {
            results.skipped++;
            console.log(`Channel ${channelId} not found, skipping`);
            continue;
          }

          // If listing doesn't have a listingType, fetch it from eBay
          if (!listing.listingType) {
            try {
              const freshData = await getEbayListing(listing.url);
              listing.listingType = freshData.listingType;
              listing.buyItNowPrice = freshData.buyItNowPrice;
              results.typeDetected++;
            } catch (err) {
              console.error(`Failed to fetch listing type for ${channelId}:`, err.message);
              results.errors++;
              continue;
            }
          }

          // Determine correct category and emoji based on listing type and status
          let correctCategoryId, correctEmoji;

          if (listing.status === "shipped") {
            correctCategoryId = ebayArchivedCategoryId;
            correctEmoji = "✅";
          } else if (listing.status === "ended" || listing.status === "sold") {
            // Ended/sold items stay in their original category with ✅ emoji
            if (listing.listingType === "buy_it_now") {
              correctCategoryId = ebayBuyItNowCategoryId;
            } else {
              correctCategoryId = ebayAuctionsCategoryId;
            }
            correctEmoji = "✅";
          } else if (listing.listingType === "buy_it_now") {
            correctCategoryId = ebayBuyItNowCategoryId;
            correctEmoji = "💰";
          } else {
            // auction or auction_with_bin
            correctCategoryId = ebayAuctionsCategoryId;
            correctEmoji = "🔨";
          }

          // Check if channel needs to be moved
          let needsMove = false;
          let needsEmojiUpdate = false;

          if (channel.parentId !== correctCategoryId) {
            needsMove = true;
          }

          // Check if emoji is correct
          const currentEmoji = channel.name.charAt(0);
          if (currentEmoji !== correctEmoji) {
            needsEmojiUpdate = true;
          }

          // Move channel if needed
          if (needsMove) {
            await channel.setParent(correctCategoryId, { lockPermissions: false });
            results.moved++;
          }

          // Update emoji if needed
          if (needsEmojiUpdate) {
            // Replace the first emoji with the correct one
            const newName = correctEmoji + channel.name.slice(1);
            await channel.setName(newName);
            results.emojiUpdated++;
          }

          // Save updated listing data
          db.ebayListings[channelId] = listing;
        } catch (err) {
          console.error(`Error organizing channel ${channelId}:`, err.message);
          results.errors++;
        }
      }

      saveDb(db);

      // Build summary report
      const report = [
        "**eBay Listings Organization Complete**",
        "",
        `📊 **Summary:**`,
        `• Total listings checked: ${results.total}`,
        `• Channels moved: ${results.moved}`,
        `• Emojis updated: ${results.emojiUpdated}`,
        `• Listing types detected: ${results.typeDetected}`,
        `• Errors: ${results.errors}`,
        `• Skipped (channel not found): ${results.skipped}`,
      ].join("\n");

      await interaction.editReply({ content: report });
      return;
    }
  }

  // ---- eBay Setup Modal submit ----
  if (interaction.isModalSubmit() && interaction.customId === "ebay_setup_modal") {
    await interaction.deferReply({ ephemeral: true });

    const appId = interaction.fields.getTextInputValue("ebay_app_id")?.trim();
    const devId = interaction.fields.getTextInputValue("ebay_dev_id")?.trim() || "";
    const certId = interaction.fields.getTextInputValue("ebay_cert_id")?.trim();

    if (!appId || !certId) {
      await interaction.editReply({
        content: "❌ App ID and Cert ID are required.",
      });
      return;
    }

    // Save to database
    db.ebayCredentials = {
      appId,
      devId,
      certId,
      configuredBy: interaction.user.id,
      configuredAt: Date.now(),
    };
    saveDb(db);

    // Clear cached token to use new credentials
    ebayAccessToken = null;
    ebayTokenExpiry = 0;

    // Test the new credentials
    let testResult = "";
    try {
      await getEbayAccessToken();
      testResult = "✅ Credentials verified - API connection successful!";
    } catch (err) {
      testResult = `⚠️ Credentials saved but API test failed: ${err.message}\n\nPlease verify your credentials are correct.`;
    }

    await interaction.editReply({
      content: `✅ eBay API credentials saved!\n\n${testResult}`,
    });
    return;
  }

  // ---- Create Listing button ----
  if (interaction.isButton() && interaction.customId === "listing_create") {
    const modal = new ModalBuilder()
      .setCustomId("listing_modal")
      .setTitle("New Listing Ticket");

    const itemName = new TextInputBuilder()
      .setCustomId("item_name")
      .setLabel("Item name")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const itemDesc = new TextInputBuilder()
      .setCustomId("item_desc")
      .setLabel("Description (optional)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(1000);

    modal.addComponents(
      new ActionRowBuilder().addComponents(itemName),
      new ActionRowBuilder().addComponents(itemDesc)
    );

    await interaction.showModal(modal);
    return;
  }

  // ---- Modal submit ----
  if (interaction.isModalSubmit() && interaction.customId === "listing_modal") {
    await interaction.deferReply({ ephemeral: true });

    const itemName = interaction.fields.getTextInputValue("item_name")?.trim();
    const itemDesc = interaction.fields.getTextInputValue("item_desc")?.trim();

    const guild = await client.guilds.fetch(guildId);

    // Create a new private channel with simplified name
    const chanName = await createUniqueChannelName(guild, listingCategoryId, "❓", itemName);

    const channel = await guild.channels.create({
      name: chanName,
      type: ChannelType.GuildText,
      parent: listingCategoryId,
      topic: `Listing ticket | owner=${interaction.user.id} | item=${itemName}`,
      permissionOverwrites: [
        // @everyone denied
        {
          id: guild.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        // owner allowed
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        // staff role allowed
        {
          id: staffRoleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
          ],
        },
        // bot allowed
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ],
    });

    // Persist ticket
    db.listings[channel.id] = {
      ownerId: interaction.user.id,
      itemName,
      itemDesc: itemDesc || "",
      images: [],
      status: "open",
      createdAt: Date.now(),
    };
    saveDb(db);

    // Seed the channel with instructions + buttons
    await channel.send(buildListingIntroMessage(itemName, itemDesc, interaction.user.id));

    // Reply with link
    await interaction.editReply(`Created listing channel: <#${channel.id}>`);
    return;
  }

  // ---- In-channel buttons ----
  if (interaction.isButton() && (interaction.customId === "listing_done" || interaction.customId === "listing_close")) {
    const ticket = db.listings[interaction.channelId];
    if (!ticket) {
      await interaction.reply({ ephemeral: true, content: "This channel is not a listing ticket (or the bot has no record of it)." });
      return;
    }

    const isOwner = interaction.user.id === ticket.ownerId;
    const isStaff = memberIsStaff(interaction);

    if (!isOwner && !isStaff) {
      await interaction.reply({ ephemeral: true, content: "Only the ticket owner or staff can do that." });
      return;
    }

    // Done Uploading
    if (interaction.customId === "listing_done") {
      ticket.status = "images_done";
      saveDb(db);

      // Change channel emoji from ❓ to ✅
      try {
        const newName = interaction.channel.name.replace(/^❓/, "✅");
        await interaction.channel.setName(newName);
      } catch {}

      const count = ticket.images.length;
      const preview = ticket.images.slice(0, 10).map((u) => `• ${u}`).join("\n") || "-";

      await interaction.reply({
        content:
          `✅ **Upload complete** for **${ticket.itemName}**\n` +
          `Images captured: **${count}**\n\n` +
          `First up to 10 image URLs:\n${preview}\n\n` +
          `Paging staff: <@&${staffRoleId}>`,
      });
      return;
    }

    // Close Ticket
    if (interaction.customId === "listing_close") {
      // If you want ONLY staff to close, uncomment:
      // if (!isStaff) { ... }

      ticket.status = "closed";
      saveDb(db);

      // Lock owner from sending (but keep read access)
      try {
        await interaction.channel.permissionOverwrites.edit(ticket.ownerId, {
          SendMessages: false,
          AttachFiles: false,
        });
      } catch {}

      // Rename channel
      try {
        await interaction.channel.setName(
          (`closed-${interaction.channel.name}`.slice(0, 90))
        );
      } catch {}

      await interaction.reply({ content: "🔒 Ticket closed." });
      return;
    }
  }

  // ---- eBay Add Listing button ----
  if (interaction.isButton() && interaction.customId === "ebay_add") {
    const modal = new ModalBuilder()
      .setCustomId("ebay_modal")
      .setTitle("Add eBay Listing");

    const ebayUrl = new TextInputBuilder()
      .setCustomId("ebay_url")
      .setLabel("eBay Listing URL")
      .setPlaceholder("https://www.ebay.com/itm/...")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(500);

    modal.addComponents(
      new ActionRowBuilder().addComponents(ebayUrl)
    );

    await interaction.showModal(modal);
    return;
  }

  // ---- eBay Modal submit ----
  if (interaction.isModalSubmit() && interaction.customId === "ebay_modal") {
    await interaction.deferReply({ ephemeral: true });

    let url = interaction.fields.getTextInputValue("ebay_url")?.trim();

    // Validate URL - support both desktop and mobile share links
    // Mobile share links: ebay.com/itm/123, ebay.us/xyz, or with tracking params
    const ebayPattern = /^https?:\/\/(www\.)?(ebay\.(com|co\.uk|de|fr|ca|com\.au)\/itm\/|ebay\.us\/)/i;
    if (!url.match(ebayPattern)) {
      await interaction.editReply("Invalid eBay URL. Please provide a valid eBay item listing URL (e.g., https://www.ebay.com/itm/... or a mobile share link)");
      return;
    }

    // Normalize URL: remove tracking params for cleaner storage
    try {
      const urlObj = new URL(url);
      // Keep only the essential path, remove tracking params
      url = `${urlObj.origin}${urlObj.pathname}`;
    } catch {}

    try {
      const listing = await getEbayListing(url);
      const guild = await client.guilds.fetch(guildId);

      // Determine category and emoji based on listing type
      let categoryId, emoji;
      if (listing.listingType === "buy_it_now") {
        categoryId = ebayBuyItNowCategoryId;
        emoji = "💰";
      } else {
        // auction or auction_with_bin
        categoryId = ebayAuctionsCategoryId;
        emoji = "🔨";
      }

      // Create channel with simplified name
      const chanName = await createUniqueChannelName(guild, categoryId, emoji, listing.title);

      const channel = await guild.channels.create({
        name: chanName,
        type: ChannelType.GuildText,
        parent: categoryId,
        topic: `eBay Tracker | owner=${interaction.user.id} | ${url}`,
        permissionOverwrites: [
          // @everyone can view (or deny if you want private)
          {
            id: guild.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages],
          },
          // owner allowed to send
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
          // staff role allowed
          {
            id: staffRoleId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
          // bot allowed
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.ManageMessages,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ],
      });

      // Initialize ebayListings if needed
      if (!db.ebayListings) db.ebayListings = {};

      // Store listing data
      const now = Date.now();
      db.ebayListings[channel.id] = {
        url,
        ownerId: interaction.user.id,
        title: listing.title,
        currentPrice: listing.currentPrice,
        bidCount: listing.bidCount,
        endTime: listing.endTime,
        imageUrl: listing.imageUrl,
        description: listing.description,
        views: listing.views,
        watchers: listing.watchers,
        status: listing.status,
        source: listing.source,
        listingType: listing.listingType,
        buyItNowPrice: listing.buyItNowPrice,
        lastChecked: now,
        createdAt: now,
      };
      saveDb(db);

      // Post the listing embed
      const embed = buildEbayListingEmbed(db.ebayListings[channel.id]);
      const buttons = buildEbayListingButtons(db.ebayListings[channel.id]);
      await channel.send({ embeds: [embed], components: [buttons] });

      await interaction.editReply(`Created eBay tracking channel: <#${channel.id}>`);
    } catch (err) {
      console.error("Failed to scrape eBay listing:", err);
      await interaction.editReply(`Failed to fetch eBay listing: ${err.message}`);
    }
    return;
  }

  // ---- eBay Refresh button ----
  if (interaction.isButton() && interaction.customId === "ebay_refresh") {
    const ebayListing = db.ebayListings?.[interaction.channelId];
    if (!ebayListing) {
      await interaction.reply({ ephemeral: true, content: "This channel is not an eBay tracking channel." });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const newData = await getEbayListing(ebayListing.url);
      const oldPrice = ebayListing.currentPrice;
      const oldBidCount = ebayListing.bidCount;

      // Update stored data
      ebayListing.title = newData.title;
      ebayListing.currentPrice = newData.currentPrice;
      ebayListing.bidCount = newData.bidCount;
      ebayListing.endTime = newData.endTime;
      ebayListing.imageUrl = newData.imageUrl;
      ebayListing.description = newData.description;
      ebayListing.views = newData.views;
      ebayListing.watchers = newData.watchers;
      ebayListing.status = newData.status;
      ebayListing.source = newData.source;
      ebayListing.lastChecked = Date.now();
      saveDb(db);

      // Update the original message
      const embed = buildEbayListingEmbed(ebayListing);
      const buttons = buildEbayListingButtons(ebayListing);
      await interaction.message.edit({ embeds: [embed], components: [buttons] });

      // Notify if price or bids changed
      if (oldPrice !== newData.currentPrice || oldBidCount !== newData.bidCount) {
        await interaction.channel.send(
          `📢 **Listing Updated!**\nPrice: ${oldPrice} → ${newData.currentPrice}\nBids: ${oldBidCount} → ${newData.bidCount}`
        );
      }

      await interaction.editReply("Listing refreshed!");
    } catch (err) {
      console.error("Failed to refresh eBay listing:", err);
      await interaction.editReply(`Failed to refresh: ${err.message}`);
    }
    return;
  }

  // ---- eBay Mark Sold button (BIN only) ----
  if (interaction.isButton() && interaction.customId === "ebay_sold") {
    const ebayListing = db.ebayListings?.[interaction.channelId];
    if (!ebayListing) {
      await interaction.reply({ ephemeral: true, content: "This channel is not an eBay tracking channel." });
      return;
    }

    const isOwner = interaction.user.id === ebayListing.ownerId;
    const isStaff = memberIsStaff(interaction);

    if (!isOwner && !isStaff) {
      await interaction.reply({ ephemeral: true, content: "Only the channel owner or staff can mark items as sold." });
      return;
    }

    // Mark as sold
    ebayListing.status = "sold";
    saveDb(db);

    // Change channel emoji from 💰 to ✅
    try {
      const newName = interaction.channel.name.replace(/^💰/, "✅");
      await interaction.channel.setName(newName);
    } catch {}

    // Update the embed and buttons
    const embed = buildEbayListingEmbed(ebayListing);
    const buttons = buildEbayListingButtons(ebayListing);
    await interaction.message.edit({ embeds: [embed], components: [buttons] });

    await interaction.reply({ content: "✅ **Item sold!** Ready to ship." });
    return;
  }

  // ---- eBay Mark Shipped button ----
  if (interaction.isButton() && interaction.customId === "ebay_shipped") {
    const ebayListing = db.ebayListings?.[interaction.channelId];
    if (!ebayListing) {
      await interaction.reply({ ephemeral: true, content: "This channel is not an eBay tracking channel." });
      return;
    }

    const isOwner = interaction.user.id === ebayListing.ownerId;
    const isStaff = memberIsStaff(interaction);

    if (!isOwner && !isStaff) {
      await interaction.reply({ ephemeral: true, content: "Only the channel owner or staff can mark items as shipped." });
      return;
    }

    // Mark as shipped
    ebayListing.status = "shipped";
    saveDb(db);

    // Move channel to archived category
    try {
      if (ebayArchivedCategoryId) {
        await interaction.channel.setParent(ebayArchivedCategoryId, { lockPermissions: false });
      }
    } catch (err) {
      console.error("Failed to move channel to archived category:", err.message);
    }

    // Update the embed and buttons
    const embed = buildEbayListingEmbed(ebayListing);
    const buttons = buildEbayListingButtons(ebayListing);
    await interaction.message.edit({ embeds: [embed], components: [buttons] });

    await interaction.reply({ content: "📦 **Item shipped and archived!**" });
    return;
  }

  // ---- eBay Close Tracking button ----
  if (interaction.isButton() && interaction.customId === "ebay_close") {
    const ebayListing = db.ebayListings?.[interaction.channelId];
    if (!ebayListing) {
      await interaction.reply({ ephemeral: true, content: "This channel is not an eBay tracking channel." });
      return;
    }

    const isOwner = interaction.user.id === ebayListing.ownerId;
    const isStaff = memberIsStaff(interaction);

    if (!isOwner && !isStaff) {
      await interaction.reply({ ephemeral: true, content: "Only the channel owner or staff can close tracking." });
      return;
    }

    // Mark as closed
    ebayListing.status = "closed";
    saveDb(db);

    // Rename channel
    try {
      await interaction.channel.setName(`closed-${interaction.channel.name}`.slice(0, 90));
    } catch {}

    await interaction.reply({ content: "🔒 eBay tracking closed for this listing." });
    return;
  }
});

// -------------------------
// Collect image uploads (attachments)
// -------------------------
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const db = loadDb();
  const ticket = db.listings[message.channelId];
  if (!ticket) return;

  // Only track images while open-ish
  if (!["open", "images_done"].includes(ticket.status)) return;

  const newImages = [];
  for (const att of message.attachments.values()) {
    if (isImageAttachment(att)) newImages.push(att.url);
  }

  if (!newImages.length) return;

  // Avoid duplicates
  const existing = new Set(ticket.images);
  for (const url of newImages) existing.add(url);
  ticket.images = Array.from(existing);

  saveDb(db);

  // Quiet acknowledgement (react) to avoid spamming channel
  try {
    await message.react("📷");
  } catch {}
});

// -------------------------
// eBay Automatic Update Loop
// -------------------------
function getUpdateIntervalMs(endTime) {
  if (!endTime) return 30 * 60 * 1000; // 30 minutes if unknown

  const now = Date.now();
  const timeLeft = endTime - now;

  if (timeLeft <= 0) return null; // Ended
  if (timeLeft < 60 * 60 * 1000) return 2 * 60 * 1000; // < 1 hour: every 2 min
  if (timeLeft < 8 * 60 * 60 * 1000) return 5 * 60 * 1000; // < 8 hours: every 5 min
  if (timeLeft < 3 * 24 * 60 * 60 * 1000) return 15 * 60 * 1000; // < 3 days: every 15 min
  return 30 * 60 * 1000; // > 3 days: every 30 min
}

async function updateEbayListing(channelId, listing) {
  try {
    const newData = await getEbayListing(listing.url);
    const oldPrice = listing.currentPrice;
    const oldBidCount = listing.bidCount;
    const oldStatus = listing.status;

    // Update listing data
    listing.title = newData.title;
    listing.currentPrice = newData.currentPrice;
    listing.bidCount = newData.bidCount;
    listing.endTime = newData.endTime;
    listing.imageUrl = newData.imageUrl;
    listing.description = newData.description;
    listing.views = newData.views;
    listing.watchers = newData.watchers;
    listing.status = newData.status;
    listing.source = newData.source;
    listing.lastChecked = Date.now();

    const db = loadDb();
    db.ebayListings[channelId] = listing;
    saveDb(db);

    // Check if anything changed worth notifying
    const priceChanged = oldPrice !== newData.currentPrice;
    const bidCountChanged = oldBidCount !== newData.bidCount;
    const justEnded = oldStatus === "active" && newData.status === "ended";

    if (priceChanged || bidCountChanged || justEnded) {
      const guild = await client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(channelId).catch(() => null);

      if (channel) {
        // Find and update the original embed message
        const messages = await channel.messages.fetch({ limit: 10 });
        const embedMsg = messages.find(
          (m) => m.author.id === client.user.id && m.embeds.length > 0
        );

        if (embedMsg) {
          const embed = buildEbayListingEmbed(listing);
          const buttons = buildEbayListingButtons(listing);
          await embedMsg.edit({ embeds: [embed], components: [buttons] });
        }

        // Post update notification
        let notification = "";
        if (justEnded) {
          // Change channel emoji from 🔨 to ✅ for ended auctions
          try {
            const newName = channel.name.replace(/^🔨/, "✅");
            if (newName !== channel.name) {
              await channel.setName(newName);
            }
          } catch {}

          notification = `🔔 **Auction Ended!** Ready to ship.\nFinal Price: ${newData.currentPrice}\nTotal Bids: ${newData.bidCount}`;
        } else if (priceChanged || bidCountChanged) {
          notification = `📢 **Bid Update!**\nPrice: ${oldPrice} → ${newData.currentPrice}\nBids: ${oldBidCount} → ${newData.bidCount}`;
        }

        if (notification) {
          await channel.send(notification);
        }
      }
    }

    return true;
  } catch (err) {
    console.error(`Failed to update eBay listing ${channelId}:`, err.message);
    return false;
  }
}

function startEbayUpdateLoop() {
  // Run every minute, but respect individual listing intervals
  setInterval(async () => {
    try {
      const db = loadDb();
      if (!db.ebayListings) return;

      const now = Date.now();

      for (const [channelId, listing] of Object.entries(db.ebayListings)) {
        try {
          // Skip closed, ended, sold, or shipped listings
          if (["closed", "ended", "sold", "shipped"].includes(listing.status)) continue;

          const interval = getUpdateIntervalMs(listing.endTime);
          if (interval === null) {
            // Auction ended - do one final update
            listing.status = "ended";
            await updateEbayListing(channelId, listing);
            continue;
          }

          // Check if it's time to update this listing
          const timeSinceLastCheck = now - (listing.lastChecked || 0);
          if (timeSinceLastCheck >= interval) {
            await updateEbayListing(channelId, listing);
          }
        } catch (err) {
          console.error(`Error processing listing ${channelId}:`, err.message);
          writeCrashReport(`eBay Listing Update Error (${channelId})`, err);
        }
      }
    } catch (err) {
      console.error("Error in eBay update loop:", err.message);
      writeCrashReport("eBay Update Loop Error", err);
    }
  }, 60 * 1000); // Check every minute

  console.log("eBay update loop started.");
}

client.login(token);

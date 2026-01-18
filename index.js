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
} = require("discord.js");

const {
  token,
  guildId,
  intakeChannelId,
  listingCategoryId,
  staffRoleId,
  dataFile,
  ebayIntakeChannelId,
  ebayListingsCategoryId,
} = require("./config.json");

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
// eBay Scraper
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
  };
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
  const embed = new EmbedBuilder()
    .setTitle(listing.title)
    .setColor(listing.status === "ended" ? 0x808080 : 0x0064d2)
    .addFields(
      { name: "Current Price", value: listing.currentPrice || "N/A", inline: true },
      { name: "Bids", value: String(listing.bidCount), inline: true },
      { name: "Time Left", value: formatTimeLeft(listing.endTime), inline: true },
      { name: "Views", value: String(listing.views || 0), inline: true },
      { name: "Watchers", value: String(listing.watchers || 0), inline: true }
    )
    .setFooter({ text: `Last updated: ${new Date(listing.lastChecked).toLocaleString()}` });

  if (listing.imageUrl) {
    embed.setImage(listing.imageUrl);
  }

  if (listing.description) {
    embed.setDescription(listing.description);
  }

  if (listing.status === "ended") {
    embed.setTitle(`[ENDED] ${listing.title}`);
  }

  return embed;
}

function buildEbayListingButtons(url) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ebay_refresh")
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setLabel("Open on eBay")
      .setStyle(ButtonStyle.Link)
      .setURL(url),
    new ButtonBuilder()
      .setCustomId("ebay_close")
      .setLabel("Close Tracking")
      .setStyle(ButtonStyle.Danger)
  );
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
      const listing = await scrapeEbayListing(url);
      const guild = await client.guilds.fetch(guildId);

      // Create channel with simplified name
      const chanName = await createUniqueChannelName(guild, ebayListingsCategoryId, "💰", listing.title);

      const channel = await guild.channels.create({
        name: chanName,
        type: ChannelType.GuildText,
        parent: ebayListingsCategoryId,
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
        lastChecked: now,
        createdAt: now,
      };
      saveDb(db);

      // Post the listing embed
      const embed = buildEbayListingEmbed(db.ebayListings[channel.id]);
      const buttons = buildEbayListingButtons(url);
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
      const newData = await scrapeEbayListing(ebayListing.url);
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
      ebayListing.lastChecked = Date.now();
      saveDb(db);

      // Update the original message
      const embed = buildEbayListingEmbed(ebayListing);
      const buttons = buildEbayListingButtons(ebayListing.url);
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
    const newData = await scrapeEbayListing(listing.url);
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
          const buttons = buildEbayListingButtons(listing.url);
          await embedMsg.edit({ embeds: [embed], components: [buttons] });
        }

        // Post update notification
        let notification = "";
        if (justEnded) {
          notification = `🔔 **Auction Ended!**\nFinal Price: ${newData.currentPrice}\nTotal Bids: ${newData.bidCount}`;
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
          // Skip closed or ended listings
          if (listing.status === "closed" || listing.status === "ended") continue;

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

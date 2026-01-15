const fs = require("fs");
const path = require("path");

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
} = require("./config.json");

// ---- Intents ----
// Guilds: interactions + channels
// GuildMessages: to receive messageCreate for attachments in listing channels
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
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

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

function shortId() {
  return Math.random().toString(36).slice(2, 7);
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

    // Enforce: one open listing per user (optional; remove if you don't want this)
    const existingOpen = Object.entries(db.listings).find(
      ([, t]) => t.ownerId === interaction.user.id && t.status === "open"
    );
    if (existingOpen) {
      const [channelId] = existingOpen;
      await interaction.editReply(
        `You already have an open listing: <#${channelId}>`
      );
      return;
    }

    const guild = await client.guilds.fetch(guildId);

    // Create a new private channel under your category
    const chanName = `listing-${slugify(itemName)}-${shortId()}`.slice(0, 90);

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

client.login(token);

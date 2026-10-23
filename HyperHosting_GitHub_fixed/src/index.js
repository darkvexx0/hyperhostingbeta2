require("dotenv").config();

const http = require("node:http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("HyperHosting is online!");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Web server running on port ${PORT}`);
});


const {
  Client, GatewayIntentBits, Partials, Events, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
  EmbedBuilder, MessageFlags, PermissionFlagsBits
} = require("discord.js");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const bcrypt = require("bcrypt");

const ROOT = path.resolve(__dirname, "..");
const DB_FILE = path.join(ROOT, "database.json");
const BOTS_ROOT = path.join(ROOT, "bots");
const MIN_INVITES = Math.max(1, Number(process.env.MIN_INVITES_PER_SLOT || 3));
const activeProcesses = new Map();
const inviteSnapshots = new Map();
let dbQueue = Promise.resolve();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites
  ],
  partials: [Partials.GuildMember]
});

function emptyDB() {
  return { users: {}, bots: {}, inviteUses: {}, guildLinks: {} };
}

async function initStorage() {
  await fs.mkdir(BOTS_ROOT, { recursive: true });
  try { await fs.access(DB_FILE); }
  catch { await fs.writeFile(DB_FILE, JSON.stringify(emptyDB(), null, 2)); }
}

async function readDB() {
  await initStorage();
  try {
    const parsed = JSON.parse(await fs.readFile(DB_FILE, "utf8"));
    return { ...emptyDB(), ...parsed };
  } catch (err) {
    throw new Error("database.json okunamadı veya JSON biçimi bozuk: " + err.message);
  }
}

// Serialize writes to avoid concurrent interactions overwriting one another.
function updateDB(mutator) {
  const task = dbQueue.then(async () => {
    const db = await readDB();
    await mutator(db);
    const temp = DB_FILE + ".tmp";
    await fs.writeFile(temp, JSON.stringify(db, null, 2), "utf8");
    await fs.rename(temp, DB_FILE);
  });
  dbQueue = task.catch(() => {});
  return task;
}

function safeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 32) || "bot";
}

function botDir(bot) {
  // Use the stored internal folder name; never accept an arbitrary path from a user.
  return path.join(BOTS_ROOT, bot.ownerId, bot.folder);
}

async function ownedBot(userId, botId) {
  const db = await readDB();
  const bot = db.bots[botId];
  if (!bot || bot.ownerId !== userId) throw new Error("Bu bot sana ait değil veya bulunamadı.");
  return bot;
}

async function replyPrivate(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content, allowedMentions: { parse: [] } });
  }
  return interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
}

async function acknowledge(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }
}

function panelEmbed() {
  return new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle("HyperHosting")
    .setDescription("Discord botlarını yönetebileceğin yerel JSON tabanlı hosting paneli.")
    .addFields(
      { name: "Hesap", value: "Panel şifresi oluştur veya kaydını kontrol et.", inline: true },
      { name: "Bot yönetimi", value: "Bot oluştur, dosyalarını düzenle ve süreçlerini yönet.", inline: true },
      { name: "Slot koşulu", value: `Her bot slotu için en az **${MIN_INVITES} geçerli davet** gerekir.`, inline: false }
    );
}

function panelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("hh_register").setLabel("Kayıt Ol / Şifre Belirle").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("hh_create").setLabel("Bot Oluştur").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("hh_invites").setLabel("Davet Durumum").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("hh_my_bots").setLabel("Botlarım ve Panel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Ana Botu Sunucuna Ekle")
        .setURL(process.env.INVITE_URL || "https://discord.com/developers/applications")
    )
  ];
}

function registerModal() {
  const modal = new ModalBuilder().setCustomId("hh_register_modal").setTitle("HyperHosting kayıt");
  const pass = new TextInputBuilder().setCustomId("password").setLabel("Panel şifresi")
    .setStyle(TextInputStyle.Short).setMinLength(8).setMaxLength(72).setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(pass));
  return modal;
}

function createBotModal() {
  const modal = new ModalBuilder().setCustomId("hh_create_modal").setTitle("Yeni bot oluştur");
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("bot_name").setLabel("Bot adı")
        .setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(32).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("client_id").setLabel("Müşteri botunun Client ID bilgisi")
        .setStyle(TextInputStyle.Short).setMinLength(17).setMaxLength(20).setRequired(true)
    )
  );
  return modal;
}

async function getInviteCount(userId, guildId) {
  const db = await readDB();
  const records = db.inviteUses[guildId] || {};
  return Object.values(records).filter(x => x.inviterId === userId && x.valid === true && x.present === true).length;
}

async function refreshInviteSnapshot(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteSnapshots.set(guild.id, new Map(invites.map(inv => [inv.code, inv.uses || 0])));
  } catch (err) {
    console.warn(`[Davet] ${guild.id} davetleri okunamadı: ${err.message}`);
  }
}

async function getValidSlots(userId) {
  const count = await getInviteCount(userId, process.env.GUILD_ID);
  return Math.floor(count / MIN_INVITES);
}

async function stopBot(botId, reason = "Kullanıcı tarafından durduruldu") {
  const proc = activeProcesses.get(botId);
  if (proc) {
    proc.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000);
    timer.unref();
    activeProcesses.delete(botId);
  }
  await updateDB(db => {
    if (db.bots[botId]) {
      db.bots[botId].status = "stopped";
      db.bots[botId].lastStopReason = reason;
    }
  });
}

async function startBot(botId, userId) {
  const bot = await ownedBot(userId, botId);
  const slots = await getValidSlots(userId);
  const db = await readDB();
  const ownedCount = Object.values(db.bots).filter(b => b.ownerId === userId).length;
  if (slots < ownedCount) throw new Error(`Yeterli davetin yok. Her slot için ${MIN_INVITES} geçerli davet gerekiyor.`);
  if (activeProcesses.has(botId)) throw new Error("Bu bot zaten çalışıyor.");

  const dir = botDir(bot);
  const entry = path.join(dir, "index.js");
  try { await fs.access(entry); }
  catch { throw new Error("Bot klasöründe index.js bulunamadı. Önce dosya ekle."); }

  // Child process isolation is NOT a security sandbox. Only run trusted customer code.
  const proc = spawn(process.execPath, [entry], {
    cwd: dir,
    env: { PATH: process.env.PATH || "", NODE_ENV: "production", HOME: dir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  activeProcesses.set(botId, proc);
  await updateDB(data => { data.bots[botId].status = "running"; data.bots[botId].pid = proc.pid; });
  proc.stdout.on("data", chunk => console.log(`[${bot.name}] ${String(chunk).trimEnd()}`));
  proc.stderr.on("data", chunk => console.error(`[${bot.name} ERROR] ${String(chunk).trimEnd()}`));
  proc.on("error", async err => {
    activeProcesses.delete(botId);
    await updateDB(data => {
      if (data.bots[botId]) { data.bots[botId].status = "stopped"; data.bots[botId].lastError = err.message; }
    }).catch(console.error);
  });
  proc.on("exit", async (code, signal) => {
    activeProcesses.delete(botId);
    await updateDB(data => {
      if (data.bots[botId]) {
        data.bots[botId].status = "stopped";
        data.bots[botId].exitCode = code;
        data.bots[botId].exitSignal = signal;
      }
    }).catch(console.error);
  });
}

function botPanelComponents(botId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`hh_start:${botId}`).setLabel("Başlat").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`hh_stop:${botId}`).setLabel("Durdur").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`hh_addfile:${botId}`).setLabel("Dosya Ekle").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`hh_files:${botId}`).setLabel("Dosyaları Yönet").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Botu Sunucuna Ekle").setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(botId)}&scope=bot%20applications.commands&permissions=0`)
    )
  ];
}

function addFileModal(botId) {
  const modal = new ModalBuilder().setCustomId(`hh_addfile_modal:${botId}`).setTitle("Bot dosyası ekle");
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("filename").setLabel("Dosya adı (ör. index.js)")
        .setStyle(TextInputStyle.Short).setMaxLength(64).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("code").setLabel("JavaScript kodu")
        .setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true)
    )
  );
  return modal;
}

function editFileModal(botId, fileName, code) {
  const modal = new ModalBuilder().setCustomId(`hh_editfile_modal:${botId}:${Buffer.from(fileName).toString("base64url")}`)
    .setTitle("Dosya kodunu düzenle");
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("code").setLabel(fileName.slice(0, 45))
        .setStyle(TextInputStyle.Paragraph).setValue(code.slice(0, 4000)).setMaxLength(4000).setRequired(true)
    )
  );
  return modal;
}

function validFileName(name) {
  return /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}\.(js|json|txt|md|env\.example)$/i.test(name)
    && !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

async function listBotFiles(bot) {
  const dir = botDir(bot);
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter(e => e.isFile() && validFileName(e.name)).map(e => e.name).slice(0, 25);
}

async function showFiles(interaction, bot) {
  const files = await listBotFiles(bot);
  if (!files.length) return replyPrivate(interaction, "Henüz dosya yok. **Dosya Ekle** ile `index.js` oluştur.");
  const menu = new StringSelectMenuBuilder().setCustomId(`hh_filepick:${bot.id}`)
    .setPlaceholder("İşlem yapmak istediğin dosyayı seç").addOptions(files.map(name => ({ label: name, value: name })));
  await interaction.editReply({ content: `**${bot.name} — Dosyaları**`, components: [new ActionRowBuilder().addComponents(menu)] });
}

async function handleButton(interaction) {
  const id = interaction.customId;
  if (id === "hh_register") return interaction.showModal(registerModal());
  if (id === "hh_create") {
    const db = await readDB();
    if (!db.users[interaction.user.id]) return replyPrivate(interaction, "Önce **Kayıt Ol / Şifre Belirle** bölümünden kayıt ol.");
    return interaction.showModal(createBotModal());
  }
  if (id === "hh_invites") {
    await acknowledge(interaction);
    const db = await readDB();
    const count = await getInviteCount(interaction.user.id, process.env.GUILD_ID);
    const slots = Math.floor(count / MIN_INVITES);
    const total = Object.values(db.bots).filter(b => b.ownerId === interaction.user.id).length;
    const records = Object.values(db.inviteUses[process.env.GUILD_ID] || {}).filter(x => x.inviterId === interaction.user.id);
    const departed = records.filter(x => x.present === false).length;
    const invalid = records.filter(x => x.valid === false).length;
    return interaction.editReply(`**Davet durumun**\nGeçerli davet: **${count}**\nKazanılan slot: **${slots}**\nBot sayın: **${total}**\nAyrılan: **${departed}** · Geçersiz/yeni hesap: **${invalid}**`);
  }
  if (id === "hh_my_bots") {
    await acknowledge(interaction);
    const db = await readDB();
    const bots = Object.values(db.bots).filter(b => b.ownerId === interaction.user.id).slice(0, 25);
    if (!bots.length) return interaction.editReply({ content: "Henüz botun yok. **Bot Oluştur** ile başlayabilirsin.", components: [] });
    const menu = new StringSelectMenuBuilder().setCustomId("hh_botpick").setPlaceholder("Yönetmek istediğin botu seç")
      .addOptions(bots.map(b => ({ label: b.name.slice(0, 100), description: `${b.status || "stopped"} · ${b.id}`.slice(0, 100), value: b.id })));
    return interaction.editReply({ content: "Botunu seç:", components: [new ActionRowBuilder().addComponents(menu)] });
  }
  const [action, botId] = id.split(":");
  if (!["hh_start", "hh_stop", "hh_addfile", "hh_files"].includes(action)) return;
  const bot = await ownedBot(interaction.user.id, botId);
  if (action === "hh_addfile") return interaction.showModal(addFileModal(botId));
  await acknowledge(interaction);
  if (action === "hh_start") {
    await startBot(botId, interaction.user.id);
    return interaction.editReply(`✅ **${bot.name}** başlatıldı.`);
  }
  if (action === "hh_stop") {
    await stopBot(botId);
    return interaction.editReply(`🛑 **${bot.name}** durduruldu.`);
  }
  return showFiles(interaction, bot);
}

async function handleModal(interaction) {
  const id = interaction.customId;
  if (id === "hh_register_modal") {
    const password = interaction.fields.getTextInputValue("password");
    if (password.length < 8) return replyPrivate(interaction, "Şifre en az 8 karakter olmalı.");
    const hash = await bcrypt.hash(password, 12);
    await updateDB(db => {
      db.users[interaction.user.id] = {
        ...(db.users[interaction.user.id] || {}),
        passwordHash: hash,
        createdAt: db.users[interaction.user.id]?.createdAt || new Date().toISOString()
      };
    });
    return replyPrivate(interaction, "✅ Panel kaydın oluşturuldu/güncellendi.");
  }
  if (id === "hh_create_modal") {
    await acknowledge(interaction);
    const name = interaction.fields.getTextInputValue("bot_name").trim();
    const botClientId = interaction.fields.getTextInputValue("client_id").trim();
    if (!/^\d{17,20}$/.test(botClientId)) return interaction.editReply("Client ID geçerli görünmüyor.");
    const db = await readDB();
    if (!db.users[interaction.user.id]) return interaction.editReply("Önce kayıt olmalısın.");
    const validInvites = await getInviteCount(interaction.user.id, process.env.GUILD_ID);
    const availableSlots = Math.floor(validInvites / MIN_INVITES);
    const currentBots = Object.values(db.bots).filter(b => b.ownerId === interaction.user.id).length;
    if (currentBots >= availableSlots) return interaction.editReply(`Bot oluşturmak için boş slotun yok. Her slot için ${MIN_INVITES} geçerli davet gerekiyor.`);
    if (Object.values(db.bots).some(b => b.ownerId === interaction.user.id && b.clientId === botClientId))
      return interaction.editReply("Bu Client ID zaten hesabında kayıtlı.");
    const id = `${interaction.user.id}_${Date.now().toString(36)}`;
    const folder = `${safeName(name)}-${id.slice(-6)}`;
    const bot = { id, ownerId: interaction.user.id, name: name.slice(0, 32), clientId: botClientId, folder, status: "stopped", createdAt: new Date().toISOString() };
    await fs.mkdir(botDir(bot), { recursive: true });
    await updateDB(data => { data.bots[id] = bot; });
    return interaction.editReply(`✅ **${bot.name}** için klasör oluşturuldu.\nBot slotunu aktif etmek için ${MIN_INVITES} geçerli davet gerekir.`);
  }
  if (id.startsWith("hh_addfile_modal:")) {
    await acknowledge(interaction);
    const botId = id.split(":")[1];
    const bot = await ownedBot(interaction.user.id, botId);
    const filename = interaction.fields.getTextInputValue("filename").trim();
    const code = interaction.fields.getTextInputValue("code");
    if (!validFileName(filename)) return interaction.editReply("Dosya adı geçersiz. Yalnızca güvenli `.js`, `.json`, `.txt` veya `.md` dosyaları ekleyebilirsin.");
    const dir = botDir(bot);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, filename);
    await fs.writeFile(target, code, { encoding: "utf8", flag: "w" });
    return interaction.editReply(`✅ \`${filename}\` kaydedildi.`);
  }
  if (id.startsWith("hh_editfile_modal:")) {
    await acknowledge(interaction);
    const [, botId, encoded] = id.split(":");
    const filename = Buffer.from(encoded, "base64url").toString("utf8");
    if (!validFileName(filename)) return interaction.editReply("Dosya adı geçersiz.");
    const bot = await ownedBot(interaction.user.id, botId);
    await fs.writeFile(path.join(botDir(bot), filename), interaction.fields.getTextInputValue("code"), "utf8");
    return interaction.editReply(`✅ \`${filename}\` güncellendi. Değişikliklerin uygulanması için botu yeniden başlat.`);
  }
}

async function handleSelect(interaction) {
  if (interaction.customId === "hh_botpick") {
    await acknowledge(interaction);
    const bot = await ownedBot(interaction.user.id, interaction.values[0]);
    const db = await readDB();
    const count = await getInviteCount(interaction.user.id, process.env.GUILD_ID);
    const slots = Math.floor(count / MIN_INVITES);
    const ownedCount = Object.values(db.bots).filter(b => b.ownerId === interaction.user.id).length;
    const embed = new EmbedBuilder().setColor(bot.status === "running" ? 0x22c55e : 0xef4444)
      .setTitle(`${bot.name} — Yönetim Paneli`)
      .setDescription(`Durum: **${bot.status || "stopped"}**\nClient ID: \`${bot.clientId}\`\nDavet slotu: **${slots}** · Bot sayısı: **${ownedCount}**`)
      .setFooter({ text: "Yalnızca kendi botlarını yönetebilirsin." });
    return interaction.editReply({ embeds: [embed], components: botPanelComponents(bot.id) });
  }
  if (interaction.customId.startsWith("hh_filepick:")) {
    await acknowledge(interaction);
    const botId = interaction.customId.split(":")[1];
    const bot = await ownedBot(interaction.user.id, botId);
    const filename = interaction.values[0];
    if (!validFileName(filename)) return interaction.editReply("Dosya adı geçersiz.");
    const content = await fs.readFile(path.join(botDir(bot), filename), "utf8");
    const preview = content.length > 1600 ? content.slice(0, 1600) + "\n… (önizleme kısaltıldı)" : content;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`hh_edit:${botId}:${Buffer.from(filename).toString("base64url")}`).setLabel("Kodu Düzenle").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`hh_delete:${botId}:${Buffer.from(filename).toString("base64url")}`).setLabel("Dosyayı Sil").setStyle(ButtonStyle.Danger)
    );
    return interaction.editReply({ content: `**${filename}**\n\`\`\`${filename.endsWith(".js") ? "js" : ""}\n${preview.replace(/```/g, "`​``")}\n\`\`\``, components: [row] });
  }
}

async function handleOtherButtons(interaction) {
  const [action, botId, encoded] = interaction.customId.split(":");
  if (action === "hh_edit") {
    const bot = await ownedBot(interaction.user.id, botId);
    const filename = Buffer.from(encoded, "base64url").toString("utf8");
    const code = await fs.readFile(path.join(botDir(bot), filename), "utf8");
    return interaction.showModal(editFileModal(botId, filename, code));
  }
  if (action === "hh_delete") {
    await acknowledge(interaction);
    const bot = await ownedBot(interaction.user.id, botId);
    const filename = Buffer.from(encoded, "base64url").toString("utf8");
    if (!validFileName(filename)) return interaction.editReply("Dosya adı geçersiz.");
    if (filename === "index.js" && activeProcesses.has(botId)) return interaction.editReply("Çalışan botun index.js dosyasını silmeden önce botu durdur.");
    await fs.unlink(path.join(botDir(bot), filename));
    return interaction.editReply(`🗑️ \`${filename}\` silindi.`);
  }
}

async function onMemberJoin(member) {
  const guildId = member.guild.id;
  try {
    const invites = await member.guild.invites.fetch();
    const previous = inviteSnapshots.get(guildId) || new Map();
    const used = invites.find(inv => (inv.uses || 0) > (previous.get(inv.code) || 0));
    inviteSnapshots.set(guildId, new Map(invites.map(inv => [inv.code, inv.uses || 0])));
    if (!used || !used.inviter) return;
    const accountAge = Date.now() - member.user.createdTimestamp;
    const valid = accountAge >= 21 * 24 * 60 * 60 * 1000;
    await updateDB(db => {
      db.inviteUses[guildId] ||= {};
      db.inviteUses[guildId][member.id] = {
        memberId: member.id, inviterId: used.inviter.id, inviteCode: used.code,
        valid, present: true, joinedAt: new Date().toISOString(),
        accountCreatedAt: member.user.createdAt.toISOString()
      };
    });
  } catch (err) {
    console.error("[Davet join]", err);
  }
}

async function onMemberRemove(member) {
  try {
    await updateDB(db => {
      const record = db.inviteUses[member.guild.id]?.[member.id];
      if (record) record.present = false;
    });
    const db = await readDB();
    const record = db.inviteUses[member.guild.id]?.[member.id];
    if (!record?.inviterId) return;
    const count = await getInviteCount(record.inviterId, member.guild.id);
    const slots = Math.floor(count / MIN_INVITES);
    const ownedBots = Object.values(db.bots).filter(b => b.ownerId === record.inviterId);
    if (slots < ownedBots.length) {
      // Stop enough active processes to bring active hosting within the remaining slot quota.
      const activeOwned = ownedBots.filter(b => activeProcesses.has(b.id));
      for (const bot of activeOwned.slice(Math.max(0, slots))) {
        await stopBot(bot.id, "Geçerli davet sayısı bot slotu kotasının altına düştü");
      }
    }
  } catch (err) {
    console.error("[Davet leave]", err);
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`HyperHosting hazır: ${readyClient.user.tag}`);
  const guild = readyClient.guilds.cache.get(process.env.GUILD_ID);
  if (guild) await refreshInviteSnapshot(guild);
});

client.on(Events.GuildMemberAdd, member => { onMemberJoin(member).catch(console.error); });
client.on(Events.GuildMemberRemove, member => { onMemberRemove(member).catch(console.error); });

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "panel") {
      return interaction.reply({ embeds: [panelEmbed()], components: panelRows(), ephemeral: true });
    }
    if (interaction.isButton()) {
      if (["hh_register", "hh_create", "hh_invites", "hh_my_bots"].includes(interaction.customId) ||
          /^(hh_start|hh_stop|hh_addfile|hh_files):/.test(interaction.customId)) {
        return await handleButton(interaction);
      }
      if (/^(hh_edit|hh_delete):/.test(interaction.customId)) return await handleOtherButtons(interaction);
    }
    if (interaction.isModalSubmit()) return await handleModal(interaction);
    if (interaction.isStringSelectMenu()) return await handleSelect(interaction);
  } catch (err) {
    console.error("[Interaction]", err);
    const message = err?.message || "Beklenmeyen bir hata oluştu.";
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: `❌ ${message}`, components: [], embeds: [] });
      else await interaction.reply({ content: `❌ ${message}`, ephemeral: true });
    } catch (replyErr) {
      console.error("[Interaction reply]", replyErr.message);
    }
  }
});

process.on("unhandledRejection", reason => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", err => {
  console.error("[uncaughtException]", err);
  // Log it; an external process supervisor should restart the main service safely.
});

async function main() {
 const missing = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID"]
  .filter(key => !process.env[key]?.trim());

if (missing.length) {
  throw new Error("Render Environment bölümünde eksik değişkenler: " + missing.join(", "));
}
  await initStorage();
  const commands = [new SlashCommandBuilder().setName("panel").setDescription("HyperHosting yönetim panelini aç").toJSON()];
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  await client.login(process.env.DISCORD_TOKEN);
}

main().catch(err => {
  console.error("HyperHosting başlatılamadı:", err);
  process.exitCode = 1;
});

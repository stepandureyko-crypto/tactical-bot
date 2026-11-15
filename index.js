import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder
} from 'discord.js';
import admin from 'firebase-admin';

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

function fail(message) {
  console.error(`[AccessBot] ${message}`);
  process.exit(1);
}

let fileConfig = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    fail(`Не удалось прочитать config.json: ${error.message}`);
  }
}

const config = {
  token: process.env.DISCORD_TOKEN || fileConfig.token,
  guildId: process.env.GUILD_ID || fileConfig.guildId,
  roles: {
    L1: process.env.ROLE_L1 || fileConfig.roles?.L1,
    L2: process.env.ROLE_L2 || fileConfig.roles?.L2,
    L3: process.env.ROLE_L3 || fileConfig.roles?.L3
  },
  firebaseDatabaseUrl: process.env.FIREBASE_DATABASE_URL || fileConfig.firebaseDatabaseUrl,
  serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    || fileConfig.serviceAccountPath
    || './serviceAccountKey.json',
  serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT || '',
  tacticalApiUrl: (process.env.TACTICAL_API_URL || fileConfig.tacticalApiUrl
    || 'https://tactical-map-mel7.onrender.com').replace(/\/+$/, ''),
  botSecret: process.env.TACTICAL_BOT_SECRET || fileConfig.botSecret || '',
  adminRoleId: process.env.ROLE_ADMIN || fileConfig.adminRoleId || ''
};

if (!config.token || config.token.includes('ВСТАВЬ')) {
  fail('Не заполнен DISCORD_TOKEN / token в config.json.');
}
if (!/^\d{10,}$/.test(String(config.guildId || ''))) {
  fail('Не заполнен корректный GUILD_ID / guildId.');
}
if (!config.firebaseDatabaseUrl) {
  fail('Не заполнен FIREBASE_DATABASE_URL / firebaseDatabaseUrl.');
}

const requiredLevels = ['L1', 'L2', 'L3'];
const roleEntries = Object.entries(config.roles)
  .filter(([level, roleId]) => requiredLevels.includes(level) && /^\d{10,}$/.test(String(roleId || '')))
  .map(([level, roleId]) => [String(roleId), level]);

const missingLevels = requiredLevels.filter((level) => !roleEntries.some(([, name]) => name === level));
if (missingLevels.length > 0) {
  fail(`Не заполнены ID ролей: ${missingLevels.join(', ')}. Синхронизация отменена, чтобы случайно не удалить доступ.`);
}

const ROLE_LEVELS = new Map(roleEntries);
const RANK = { L1: 1, L2: 2, L3: 3 };
const COMMANDER_ROLE = process.env.ROLE_COMMANDER || fileConfig.commanderRoleId || '1566405134135730216';
const CAPTAIN_ROLE = process.env.ROLE_CAPTAIN || fileConfig.captainRoleId || '1566405295520096316';

let serviceAccount;
if (config.serviceAccountJson.trim()) {
  try {
    serviceAccount = JSON.parse(config.serviceAccountJson);
  } catch (error) {
    fail(`Не удалось разобрать FIREBASE_SERVICE_ACCOUNT: ${error.message}`);
  }
} else {
  const serviceAccountPath = path.resolve(process.cwd(), config.serviceAccountPath);
  if (!fs.existsSync(serviceAccountPath)) {
    fail(`Не найден service account: ${serviceAccountPath}`);
  }
  try {
    serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  } catch (error) {
    fail(`Не удалось прочитать service account: ${error.message}`);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: config.firebaseDatabaseUrl
});

const db = admin.database();

// Render Web Service требует открытый HTTP-порт. Локально PORT обычно не задан.
const port = Number(process.env.PORT || 0);
let healthServer = null;
if (port > 0) {
  healthServer = http.createServer((request, response) => {
    if (request.url === '/health' || request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('ok');
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });

  healthServer.listen(port, '0.0.0.0', () => {
    console.log(`[AccessBot] health-check: http://0.0.0.0:${port}/health`);
  });
  healthServer.on('error', (error) => {
    console.error(`[AccessBot] health server error: ${error.message}`);
  });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.GuildMember]
});

function resolveLevel(member) {
  let best = null;

  for (const [roleId, level] of ROLE_LEVELS) {
    if (!member.roles.cache.has(roleId)) continue;
    if (!best || RANK[level] > RANK[best]) {
      best = level;
    }
  }

  return best;
}

function resolveTacticalRole(member) {
  if (member.roles.cache.has(COMMANDER_ROLE)) return 'CHIEF';
  if (member.roles.cache.has(CAPTAIN_ROLE)) return 'LEADER';
  return 'FIGHTER';
}

function isAdmin(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const member = interaction.member;
  return Boolean(config.adminRoleId) && Boolean(member?.roles?.cache?.has(config.adminRoleId));
}

async function registerCommands(guild) {
  const commands = [
    new SlashCommandBuilder()
      .setName('code')
      .setDescription('Подтвердить вход в BratVa UI по коду запроса')
      .addStringOption((option) => option
        .setName('request')
        .setDescription('Код запроса из мода (8 символов)')
        .setRequired(false))
      .addUserOption((option) => option
        .setName('member')
        .setDescription('Кому выдать код (только для администраторов)')
        .setRequired(false))
      .toJSON()
  ];

  await guild.commands.set(commands);
  console.log(`[AccessBot] Зарегистрировано ${commands.length} slash-команд`);
}

async function requestLoginCode(member, requestCode) {
  if (!config.botSecret) {
    throw new Error('TACTICAL_BOT_SECRET не задан');
  }

  const response = await fetch(`${config.tacticalApiUrl}/api/auth/discord/code/issue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Secret': config.botSecret
    },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      discordId: member.id,
      username: member.user.username,
      globalName: member.user.globalName || null,
      avatar: member.user.avatar || null,
      requestCode: String(requestCode)
    })
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`backend HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const parsed = JSON.parse(body);
  if (!parsed.ok) {
    throw new Error('backend не подтвердил выдачу кода');
  }
  return parsed;
}

async function syncMember(member) {
  if (!member?.guild || member.guild.id !== String(config.guildId)) {
    return;
  }

  const level = resolveLevel(member);
  const tacticalRole = resolveTacticalRole(member);
  const ref = db.ref(`access/${member.id}`);
  const roleRef = db.ref(`tactical_roles/${member.id}`);

  try {
    if (level) {
      await ref.set(level);
      await roleRef.set(tacticalRole);
      console.log(`[AccessBot] ${member.user.username} (${member.id}) -> ${level}, role=${tacticalRole}`);
    } else {
      await ref.remove();
      await roleRef.remove();
      console.log(`[AccessBot] ${member.user.username} (${member.id}) -> роль не найдена, узлы удалены`);
    }
  } catch (error) {
    console.error(`[AccessBot] Ошибка записи Firebase для ${member.id}: ${error.message}`);
  }
}

async function syncAllMembers(guild) {
  const members = await guild.members.fetch();
  console.log(`[AccessBot] Синхронизация ${members.size} участников...`);

  for (const member of members.values()) {
    await syncMember(member);
  }

  console.log('[AccessBot] Первичная синхронизация завершена.');
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[AccessBot] Вошёл как ${readyClient.user.tag}`);

  try {
    const guild = await readyClient.guilds.fetch(String(config.guildId));
    await registerCommands(guild);
    await syncAllMembers(guild);
  } catch (error) {
    console.error(`[AccessBot] Ошибка синхронизации при старте: ${error.message}`);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'code') {
    return;
  }

  const selectedUser = interaction.options.getUser('member');
  const requestCode = String(interaction.options.getString('request') || '')
    .trim().toUpperCase().replace(/\s+/g, '');
  let target = null;
  try {
    const guild = interaction.guild
      || await client.guilds.fetch(String(config.guildId));
    target = await guild.members.fetch(selectedUser?.id || interaction.user.id);
  } catch {
    target = null;
  }

  if (selectedUser && !isAdmin(interaction)) {
    await interaction.reply({
      content: 'Нужны права администратора или роль из ROLE_ADMIN.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!target || !target.user) {
    await interaction.reply({
      content: 'Не удалось определить участника.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (target.user.bot) {
    await interaction.reply({
      content: 'Ботам код не нужен.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const level = resolveLevel(target);
  if (!level) {
    await interaction.reply({
      content: 'У этого участника нет роли L1-L3.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (requestCode.length !== 8) {
    await interaction.reply({
      content: 'Открой мод → экран входа → **Получить код**, затем повтори: '
        + '`/code <код запроса>`.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await requestLoginCode(target, requestCode);
    try {
      await target.send(
        '**BratVa UI — код выдан**\n'
        + `Запрос \`${requestCode}\` принят.\n`
        + 'Вернись в игру — мод сам завершит вход. Код в Discord не отправляется.'
      );
    } catch (error) {
      console.error(`[AccessBot] DM failed: ${error.message}`);
    }
    await interaction.editReply({ content: 'Код выдан. Вернись в игру — мод завершит вход.' });
  } catch (error) {
    console.error(`[AccessBot] code command: ${error.message}`);
    await interaction.editReply({ content: `Не удалось выдать код: ${error.message}` });
  }
});

client.on(Events.GuildMemberUpdate, async (_oldMember, newMember) => {
  await syncMember(newMember);
});

client.on(Events.GuildMemberRemove, async (member) => {
  if (!member.guild || member.guild.id !== String(config.guildId)) {
    return;
  }

  try {
    await db.ref(`access/${member.id}`).remove();
    await db.ref(`tactical_roles/${member.id}`).remove();
    console.log(`[AccessBot] ${member.user.username} (${member.id}) вышел, узлы удалены`);
  } catch (error) {
    console.error(`[AccessBot] Ошибка удаления Firebase для ${member.id}: ${error.message}`);
  }
});

client.on(Events.Error, (error) => {
  console.error(`[AccessBot] Discord error: ${error.message}`);
});

async function shutdown() {
  console.log('[AccessBot] Остановка...');
  try {
    await client.destroy();
  } catch {}
  if (healthServer) {
    await new Promise((resolve) => healthServer.close(resolve));
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(config.token).catch((error) => {
  console.error(`[AccessBot] Не удалось войти: ${error.message}`);
  process.exit(1);
});

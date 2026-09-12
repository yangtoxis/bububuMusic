import dns from 'node:dns';

// Some VPS/Docker hosts advertise IPv6 that doesn't actually route anywhere.
// Forcing ipv4first avoids voice's UDP handshake hanging on a dead IPv6 path.
dns.setDefaultResultOrder('ipv4first');

import { Client, GatewayIntentBits, Partials, MessageFlags } from 'discord.js';
import { env } from './config/env.js';
import './database/db.js';
import { loadCommands } from './commandLoader.js';
import { handleButton } from './interactions/buttonHandler.js';
import { voteManager } from './voting/VoteManager.js';
import { audioManager } from './audio/AudioManager.js';
import { loadPlatformEmojis } from './utils/platformEmojis.js';
import { logger } from './utils/logger.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

const commands = await loadCommands();
logger.info(`Загружено ${commands.size} команд(ы)`);

client.once('clientReady', async () => {
  logger.info(`Бот запущен как ${client.user.tag}`);
  await loadPlatformEmojis(client);
});

client.on('interactionCreate', async (interaction) => {
  // Autocomplete can only ever be answered with .respond() - never .reply()
  // - so it gets its own try/catch instead of falling into the generic
  // error handler below, which would try (and fail) to send a normal reply.
  if (interaction.isAutocomplete()) {
    try {
      const command = commands.get(interaction.commandName);
      if (command?.autocomplete) await command.autocomplete(interaction);
      else await interaction.respond([]);
    } catch (err) {
      logger.error('autocomplete handling failed', { error: err.message, commandName: interaction.commandName });
      try {
        await interaction.respond([]);
      } catch {
        /* interaction may have expired */
      }
    }
    return;
  }

  try {
    if (interaction.isChatInputCommand() || interaction.isMessageContextMenuCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }
    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }
  } catch (err) {
    logger.error('interaction handling failed', {
      error: err.message,
      customId: interaction.customId,
      commandName: interaction.commandName,
    });
    const payload = { content: '❌ Непредвиденная ошибка. Попробуй ещё раз.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch {
      /* interaction may have expired */
    }
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    await voteManager.handleVoiceStateUpdate(oldState, newState);
  } catch (err) {
    logger.error('vote voiceStateUpdate handling failed', { error: err.message });
  }

  const guildId = newState.guild.id;
  const session = audioManager.get(guildId);
  if (!session) return;
  if (oldState.channelId !== session.voiceChannel.id) return;
  if (newState.channelId === session.voiceChannel.id) return;

  const voiceChannel = newState.guild.channels.cache.get(session.voiceChannel.id);
  const remaining = voiceChannel ? voiceChannel.members.filter((m) => !m.user.bot).size : 0;
  if (remaining === 0) {
    session.destroy('channel_empty');
  }
});

process.on('unhandledRejection', (err) => {
  logger.error('unhandled rejection', { error: err?.message ?? String(err) });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { error: err.message });
});

async function shutdown(signal) {
  logger.info(`Получен ${signal}, завершаю работу...`);
  audioManager.destroyAll('shutdown');
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(env.discordToken);

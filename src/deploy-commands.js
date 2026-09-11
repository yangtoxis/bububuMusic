import { REST, Routes } from 'discord.js';
import { env } from './config/env.js';
import { loadCommands } from './commandLoader.js';
import { logger } from './utils/logger.js';

const commands = await loadCommands();
const body = [...commands.values()].map((c) => c.data.toJSON());

const rest = new REST({ version: '10' }).setToken(env.discordToken);

const route = env.guildId
  ? Routes.applicationGuildCommands(env.clientId, env.guildId)
  : Routes.applicationCommands(env.clientId);

logger.info(`Регистрирую ${body.length} команд(ы)`, { scope: env.guildId ? 'guild' : 'global' });
await rest.put(route, { body });
logger.info('Команды зарегистрированы');

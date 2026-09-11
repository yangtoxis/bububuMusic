import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { requireActiveSession } from '../utils/voiceGuards.js';
import { resolveTrackRequest, UnresolvableError } from '../library/TrackResolver.js';
import { trackLabel } from '../utils/format.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'add-queue' });

export const data = new SlashCommandBuilder()
  .setName('add-queue')
  .setDescription('Поставить трек следующим в очередь, не добавляя его в библиотеку (только DJ)')
  .addStringOption((opt) =>
    opt
      .setName('track')
      .setDescription('Название трека или ссылка на YouTube/Spotify/Яндекс Музыку')
      .setRequired(true)
  );

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  const active = requireActiveSession(interaction);
  if (!active.ok) return interaction.reply({ content: active.message, flags: MessageFlags.Ephemeral });

  const trackQuery = interaction.options.getString('track', true);
  await interaction.deferReply();

  let result;
  try {
    result = await resolveTrackRequest(trackQuery, { addedBy: interaction.user.id, inLibrary: false });
  } catch (err) {
    if (err instanceof UnresolvableError) {
      return interaction.editReply({ content: `❌ ${err.message}` });
    }
    logger.error('add-queue resolve failed', { error: err.message, query: trackQuery });
    return interaction.editReply({ content: `❌ Не удалось найти трек: ${err.message}` });
  }

  active.session.addToQueueFront(result.track);
  const cachedNote = result.wasNew ? '' : ' (уже был скачан ранее, повторно не качал)';
  return interaction.editReply({
    content: `✅ **${trackLabel(result.track)}** будет следующим треком.${cachedNote}`,
  });
}

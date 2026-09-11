import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { resolveTrackRequest, UnresolvableError } from '../library/TrackResolver.js';
import { trackAddedEmbed } from '../utils/embeds.js';
import { undoAddRow } from '../utils/controls.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'add' });

export const data = new SlashCommandBuilder()
  .setName('add')
  .setDescription('Добавить трек в библиотеку «Хайповый музон» (только DJ)')
  .addStringOption((opt) =>
    opt
      .setName('track')
      .setDescription('Название трека или ссылка на YouTube/Spotify/Яндекс Музыку')
      .setRequired(true)
  );

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  const trackQuery = interaction.options.getString('track', true);
  await interaction.deferReply();

  let result;
  try {
    result = await resolveTrackRequest(trackQuery, { addedBy: interaction.user.id, inLibrary: true });
  } catch (err) {
    if (err instanceof UnresolvableError) {
      return interaction.editReply({ content: `❌ ${err.message}` });
    }
    logger.error('single track add failed', { error: err.message, query: trackQuery });
    return interaction.editReply({ content: `❌ Не удалось добавить трек: ${err.message}` });
  }

  const embed = trackAddedEmbed(result.track, { alreadyExisted: !result.wasNew });
  const components = result.wasNew ? undoAddRow(result.track.id) : [];
  return interaction.editReply({ embeds: [embed], components });
}

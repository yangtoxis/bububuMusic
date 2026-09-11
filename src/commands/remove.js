import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { requireActiveSession } from '../utils/voiceGuards.js';
import { TrackRepo } from '../database/TrackRepo.js';
import { trackRemovedEmbed } from '../utils/embeds.js';
import { undoRemoveRow } from '../utils/controls.js';

export const data = new SlashCommandBuilder()
  .setName('remove')
  .setDescription('Удалить играющий сейчас трек из библиотеки и пропустить его (только DJ)');

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  const active = requireActiveSession(interaction);
  if (!active.ok) return interaction.reply({ content: active.message, flags: MessageFlags.Ephemeral });

  const track = active.session.currentTrack;
  if (!track) return interaction.reply({ content: '❌ Сейчас ничего не играет.', flags: MessageFlags.Ephemeral });

  TrackRepo.softRemove(track.id);
  active.session.skip();

  return interaction.reply({
    embeds: [trackRemovedEmbed(track)],
    components: undoRemoveRow(track.id),
  });
}

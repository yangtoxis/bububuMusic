import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireDJ } from '../utils/djGuard.js';
import { requireActiveSession } from '../utils/voiceGuards.js';
import { GuildSettingsRepo } from '../database/GuildSettingsRepo.js';

export const data = new SlashCommandBuilder()
  .setName('volume')
  .setDescription('Изменить громкость воспроизведения (только DJ)')
  .addIntegerOption((opt) =>
    opt.setName('value').setDescription('Громкость 0-100').setRequired(true).setMinValue(0).setMaxValue(100)
  );

export async function execute(interaction) {
  const dj = requireDJ(interaction);
  if (!dj.ok) return interaction.reply({ content: dj.message, flags: MessageFlags.Ephemeral });

  const value = interaction.options.getInteger('value', true);
  const active = requireActiveSession(interaction);

  if (active.ok) {
    const applied = active.session.setVolume(value);
    return interaction.reply({ content: `🔊 Громкость установлена на ${applied}%.`, flags: MessageFlags.Ephemeral });
  }

  // No active session yet: persist the value so the next /hype uses it.
  const clamped = Math.max(0, Math.min(100, value));
  GuildSettingsRepo.setVolume(interaction.guild.id, clamped);
  return interaction.reply({
    content: `🔊 Громкость для этого сервера сохранена (${clamped}%) и будет применена при следующем запуске.`,
    flags: MessageFlags.Ephemeral,
  });
}

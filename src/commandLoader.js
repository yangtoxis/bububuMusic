import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsDir = path.join(__dirname, 'commands');

export async function loadCommands() {
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));
  const commands = new Map();

  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
    if (!mod.data || !mod.execute) {
      throw new Error(`Команда в файле ${file} не экспортирует { data, execute }`);
    }
    commands.set(mod.data.name, mod);
  }

  return commands;
}

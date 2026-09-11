---
name: discord-audio-bot-architecture
description: Full reference architecture + concrete deploy runbook for a Discord voice/audio bot (per-guild sessions, ffmpeg pipeline, slash commands + buttons, Docker on a VPS), distilled from building and running "БУБУБУ РАДИО" in production. Load before scaffolding or deploying a new Discord bot that plays audio into a voice channel.
---

# Discord audio bot — reference architecture & deploy runbook

Distilled from `bububuRadio` (a fixed-station internet-radio bot, live in
production). Every code shape below is the actual pattern used there, not a
hypothetical — copy it as a starting skeleton for a new bot, then diverge
where the final section says to. The deploy runbook is the actual sequence
used to stand it up and to ship every later fix to it.

## Stack (exact versions that are known to work together)

```json
{
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "dependencies": {
    "discord.js": "^14.16.3",
    "@discordjs/voice": "^0.19.2",
    "@discordjs/opus": "^0.9.0",
    "better-sqlite3": "^11.3.0",
    "js-yaml": "^4.1.0",
    "dotenv": "^16.4.5",
    "libsodium-wrappers": "^0.7.15",
    "winston": "^3.14.2"
  }
}
```

**Do not add `ffmpeg-static`.** ffmpeg is installed via apt in the Docker
image instead — see "The ffmpeg-static trap" below, it's the single most
expensive bug this project hit.

`package.json` scripts:
```json
"scripts": {
  "start": "node src/index.js",
  "dev": "node --watch src/index.js",
  "deploy-commands": "node src/deploy-commands.js"
}
```

## File tree

```
src/
  index.js                    entrypoint: client, intents, interaction router, shutdown
  commandLoader.js            reads src/commands/*.js, keyed by exported data.name
  deploy-commands.js          registers slash commands with Discord (run manually)
  config/
    env.js                    process.env → typed config object, dotenv/config
    stations.yaml             owner-controlled station list (id/name/url/icon)
  commands/                   one file per slash command, { data, execute } exports
    play.js  stop.js  volume.js  radio.js  leave.js  sleep.js  247.js  dj-role.js
    leaderboard.js
  interactions/
    buttonHandler.js          routes ctrl:* button customIds
    radioSelectHandler.js     routes the radio:select string-select menu
  audio/
    AudioManager.js           Map<guildId, AudioSession>, the only place sessions are built
    AudioSession.js           one voice connection + player + retry state machine per guild
  sources/
    RadioSource.js            spawns ffmpeg for one station URL, exposes stdout
    IcyMetadataReader.js       separate HTTP connection just to read ICY StreamTitle
  radio/
    RadioStationManager.js    loads + serves stations.yaml
  database/
    db.js                     better-sqlite3 init + schema + repo objects
  utils/
    logger.js                 winston, console-only, secret redaction
    voiceGuards.js             Connect/Speak precondition checks
    djGuard.js                 per-guild DJ-role gate
    embeds.js                  EmbedBuilder factories
    controls.js                ButtonBuilder/ActionRowBuilder factories
    nowPlayingMessage.js       ephemeral panel payload + public track announcement
    attachSessionUI.js        wires session events → channel-side effects, once per session
Dockerfile
docker-compose.yml
.env.example
data/                          bind-mounted volume, holds bot.sqlite
```

## Entry point (`src/index.js`)

```js
import dns from 'node:dns';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

// Many VPS/Docker hosts advertise IPv6 that doesn't actually route anywhere.
// Since Node 18, dns.lookup() tries results in the order they arrive, which
// often means IPv6 first — if that IPv6 path is dead, voice's UDP handshake
// just hangs until timeout instead of falling back to IPv4 quickly. Forcing
// ipv4first avoids that class of "Ready never happens" failures entirely.
dns.setDefaultResultOrder('ipv4first');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

// interactionCreate: one big try/catch routing to
//   isChatInputCommand()      → commands.get(name).execute(interaction)
//   isStringSelectMenu()      → customId-prefixed handler (e.g. 'radio:select')
//   isButton()                → customId-prefixed handler (e.g. 'ctrl:*')
// A single failed interaction must never take down the process — catch,
// log with the customId/commandName, then reply or followUp an ephemeral
// "❌ непредвиденная ошибка" depending on interaction.deferred/replied.

// voiceStateUpdate: if every non-bot member leaves the channel the bot is
// in, and the guild hasn't opted into 24/7 mode, destroy the session
// instead of leaking a dangling connection.

// process.on('unhandledRejection'/'uncaughtException') → log, don't crash.
// process.on('SIGINT'/'SIGTERM') → destroy all sessions, client.destroy(),
// exit(0) — this is what makes `docker compose down`/redeploys graceful
// instead of cutting voice mid-word.

client.login(env.discordToken);
```

## Command loading — zero-boilerplate registration

`commandLoader.js` just reads every `.js` file in `src/commands/`, dynamic-
imports it, and keys it by `mod.data.name`. Adding a new command is just
adding a new file with a `{ data, execute }` export — nothing else to wire
up. `deploy-commands.js` does the actual Discord-side registration and is
run by hand (`npm run deploy-commands`), not on every boot:

```js
const route = env.guildId
  ? Routes.applicationGuildCommands(env.clientId, env.guildId) // instant, dev
  : Routes.applicationCommands(env.clientId);                   // global, ~1h propagation
await rest.put(route, { body: commands.map(c => c.data.toJSON()) });
```
Set `GUILD_ID` in `.env` during development for instant command updates;
leave it empty in production (global commands, accept the propagation lag).

## Audio architecture

**One `AudioSession` per guild, owned by an `AudioManager` map keyed by
`guildId`.** Each session is fully independent — own `VoiceConnection`,
`AudioPlayer`, current-station state, volume, pause state, sleep timer.
Nothing reaches across guilds; two servers can play two different stations
simultaneously with zero shared state.

```
AudioManager (Map<guildId, AudioSession>)
  └─ AudioSession (per guild)
       ├─ VoiceConnection   (joinVoiceChannel, selfDeaf: true, debug: true)
       ├─ AudioPlayer       (NoSubscriberBehavior.Pause)
       ├─ station           (current source — swapping it replaces playback)
       ├─ volume, isPaused, currentTrackTitle
       ├─ _radioRestartAttempts, sleep timer, listening-stats interval
       └─ RadioSource       spawns ffmpeg, exposes stdout as a Node Readable
```

`AudioManager.getOrCreate({ guild, voiceChannel, textChannel })` is the
**only** place a session is constructed — that's what makes it safe to
attach per-session UI listeners (`attachSessionUI`) exactly once:

```js
getOrCreate({ guild, voiceChannel, textChannel }) {
  let session = this.sessions.get(guild.id);
  if (session) return session;
  session = new AudioSession({ guild, voiceChannel, textChannel });
  session.once('destroyed', () => this.sessions.delete(guild.id));
  attachSessionUI(session);       // wires 'trackChange'/'error' → channel posts
  this.sessions.set(guild.id, session);
  return session;
}
```

`AudioSession` public surface: `playStation(source)` (resets retry budget —
only called from a fresh `/play` or station switch), `pause()`, `resume()`,
`isPaused` getter, `setVolume(percent 0-100)`, `stop()` (kills the source,
clears station, resets retry budget), `setSleepTimer(minutes)` /
`clearSleepTimer()`, `destroy(reason)`. A per-minute `setInterval` credits
every non-bot member currently in the channel with a tick of listening time
for a leaderboard (`ListeningStatsRepo.addSeconds`) — accumulate real-world
minutes elapsed, not "seconds of audio decoded", so a stalled/reconnecting
stream doesn't inflate anyone's numbers.

### The reconnect state machine — this is the part that bites you

`AudioPlayerStatus.Idle` firing while a source is still set means the
ffmpeg process died and needs restarting from scratch (ffmpeg's own
`-reconnect` flags already absorb short blips; hitting Idle means it gave
up). Constants used:

```js
const RECONNECT_GRACE_MS = 5_000;
const RADIO_RESTART_DELAY_MS = 3_000;
const RADIO_RESTART_MAX_DELAY_MS = 60_000;
const MAX_RADIO_RESTART_ATTEMPTS = 8;
```

- **A finite retry ceiling is necessary, but the reset condition is the
  entire ballgame.** Track a per-session attempt counter. Reset it to 0
  *only* when the `AudioPlayer` actually reaches `AudioPlayerStatus.Playing`
  (real audio frames flowing) — **never** merely on calling `.play()` or on
  spawning ffmpeg. Spawning happens unconditionally regardless of whether
  the network connection will succeed (`child_process.spawn` returns
  immediately; failure surfaces later, asynchronously, via the process's
  `close`/`error` events), so it is not a trustworthy "recovered" signal:
  ```js
  this.player.on(AudioPlayerStatus.Playing, () => {
    this._radioRestartAttempts = 0;
  });
  ```
  **Bug shipped and had to fix in production:** resetting the counter only
  on a fresh `/play` (not on every successful *automatic* reconnect) meant
  every small transient network hiccup over a session's entire multi-hour
  lifetime permanently spent one of the finite attempts. They silently
  accrued for hours of otherwise-healthy playback — sound never even
  dropped noticeably — until an unrelated *later* hiccup tripped the
  give-up ceiling with zero warning. User-visible symptom: "plays fine for
  hours then just dies," which reads like a mystery until you notice the
  counter was accumulating the whole time.
- Exponential backoff between attempts, not a flat delay — gives a real
  multi-minute upstream outage room to clear instead of hammering the
  remote host in a tight loop (which can itself look like abuse to
  small/community streaming providers and get the VPS's IP soft-blocked):
  ```js
  const delay = Math.min(
    RADIO_RESTART_DELAY_MS * 2 ** (this._radioRestartAttempts - 1),
    RADIO_RESTART_MAX_DELAY_MS
  ); // 3s, 6s, 12s, 24s, 48s, 60s, 60s, 60s (8 attempts)
  ```
- Pin the retry closure to the *source object*, not just "the current
  station": `if (this._destroyed || this.station !== source) return;` at
  the top of the restart function, checked both before AND after the
  backoff `await`. Otherwise a retry scheduled during the delay can fire
  after the user has already switched stations, race the new station's own
  playback call, and spawn two concurrent ffmpeg processes for the guild.
- On `VoiceConnectionStatus.Disconnected`, race
  `entersState(conn, Signalling, 5000)` vs `entersState(conn, Connecting, 5000)`
  before tearing the session down — Discord moving the bot between voice
  servers produces a momentary Disconnected that resolves itself; only
  destroy if neither state is reached within the grace window.
- Wait for `VoiceConnectionStatus.Ready` (via `entersState`, ~20s timeout)
  before calling `player.play()`. Playing before Ready is a classic
  `@discordjs/voice` silent-failure mode — no error thrown, the bot just
  sits in the channel producing no sound.
- Log the connection's `stateChange` and internal `debug` events (pass
  `debug: true` to `joinVoiceChannel`) at debug level — they're the only
  way to see *which* step a stalled voice handshake never got past (UDP IP
  discovery, protocol selection, DAVE/MLS session setup, etc.) instead of a
  silent 20s timeout with no clue why.

### `RadioSource` — the ffmpeg pipeline

```js
import { spawn } from 'node:child_process';
const ffmpegPath = 'ffmpeg'; // NOT the ffmpeg-static package — see below

async createStream() {
  const ffmpeg = spawn(ffmpegPath, [
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000',        // 15s in microseconds; https/tls protocol option
    '-i', this.url,
    '-analyzeduration', '0',
    '-loglevel', 'error',
    '-f', 's16le', '-ar', '48000', '-ac', '2',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpeg.stderr.on('data', (chunk) => logger.warn('ffmpeg stderr', { message: chunk.toString().slice(0, 300) }));
  ffmpeg.on('error', (err) => logger.error('ffmpeg process error', { error: err.message }));
  ffmpeg.on('close', (code, signal) => {
    if (code !== 0 && code !== null) logger.warn('ffmpeg exited', { code, signal });
  });
  return ffmpeg.stdout;
}
```
Feed `ffmpeg.stdout` straight into `createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true })`.
`destroy()` sends `SIGKILL` to the process if it's still alive.

## Permission guards

```js
// voiceGuards.js
export function checkVoicePreconditions(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) return { ok: false, message: '❌ Ты должен находиться в голосовом канале...' };
  const perms = voiceChannel.permissionsFor(interaction.client.user);
  if (!perms?.has(PermissionsBitField.Flags.Connect)) return { ok: false, message: '❌ Нет прав на подключение...' };
  if (!perms?.has(PermissionsBitField.Flags.Speak)) return { ok: false, message: '❌ Нет прав говорить...' };
  const existing = AudioManager.get(interaction.guild.id);
  if (existing && existing.voiceChannel.id !== voiceChannel.id) {
    return { ok: false, message: `❌ Уже подключён к другому каналу (${existing.voiceChannel}).` };
  }
  return { ok: true, voiceChannel };
}
export function requireActiveSession(interaction) {
  const session = AudioManager.get(interaction.guild.id);
  return session ? { ok: true, session } : { ok: false, message: '❌ Сейчас ничего не воспроизводится.' };
}
```
`Speak`-denied is a very common **real-world** case — a per-channel
permission overwrite, unrelated to anything code-side. Treat it as expected
user-facing input, not an exceptional/crash path.

```js
// djGuard.js — restrict control to a per-guild role once the owner sets one
export function isDJ(interaction) {
  const djRoleId = GuildSettingsRepo.get(interaction.guild.id)?.dj_role_id;
  if (!djRoleId) return true;                                     // unset = open to everyone
  if (interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true; // never lock out owners
  return interaction.member.roles.cache.has(djRoleId);
}
```
Every command/button/select handler runs `checkVoicePreconditions` (if it
needs to join) then `requireDJ`, in that order, and returns the same
`{ ok, message }` shape so callers can just `if (!x.ok) return interaction.reply({ content: x.message, ephemeral: true })`.

## UI layer — two audiences, two message shapes

- **Ephemeral control panel** (`buildPlayerPayload(session)` →
  `{ embeds: [nowPlayingEmbed], components: buildControlRows }`) — shown
  only to whoever ran the command/button, since only DJ-role members can
  press its buttons anyway. Never posted publicly. Buttons use
  `customId: 'ctrl:<action>[:<arg>]'` (e.g. `ctrl:volume:up`,
  `ctrl:playpause`, `ctrl:stop`, `ctrl:radio`, `ctrl:leave`), routed in
  `buttonHandler.js` by splitting on `:`.
- **Public track-change announcement** (`postTrackAnnouncement`) — posted
  to the text channel on every `trackChange` event, **deleting the previous
  one first** so the channel only ever shows the current track instead of
  growing a history. Post with `flags: MessageFlags.SuppressNotifications`
  — track changes fire every few minutes all day; a push/sound ping per
  change is noise, not signal. (`discord.js` ^14.16+ exports
  `MessageFlags.SuppressNotifications`.) It also carries plain `ButtonStyle.Link`
  buttons ("search this track on Spotify/YouTube/Yandex Music") — link
  buttons never route through an interaction handler, so no permission
  check applies to them, and they can use **custom application emoji**
  (uploaded once at the bot-application level via Discord's emoji API/
  portal, available in every guild the bot is in — not the same as a
  guild's own custom emoji, and doesn't need `Use External Emojis`).
- `attachSessionUI(session)` is where a session's events get wired to
  these channel-side effects (`trackChange` → `postTrackAnnouncement`,
  `error` → post an error embed) — called exactly once per session, from
  inside `AudioManager.getOrCreate`, specifically to avoid accumulating
  duplicate listeners across repeated `/play` calls.

## Persistence (`database/db.js`)

`better-sqlite3`, synchronous API, no ORM — plenty for this scale.
```js
export const db = new Database(env.db.path);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY, default_volume INTEGER DEFAULT 70,
  dj_role_id TEXT, always_on INTEGER DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
); /* + user_settings, listening_stats, same PK-per-entity shape */`);
```
Repos are just plain objects wrapping prepared statements
(`GuildSettingsRepo`, `UserSettingsRepo`, `ListeningStatsRepo`), each method
a single `db.prepare(...).get/run/all(...)` call, upserts via
`ON CONFLICT(...) DO UPDATE SET ... = excluded....`. Adding a column to an
existing deployed table: `CREATE TABLE IF NOT EXISTS` is a no-op once the
table exists, so guard new columns explicitly —
```js
const cols = db.prepare('PRAGMA table_info(guild_settings)').all();
if (!cols.some(c => c.name === 'always_on')) db.exec('ALTER TABLE guild_settings ADD COLUMN always_on INTEGER DEFAULT 0');
```
**Only durable, cross-restart data lives in the DB.** Active
`VoiceConnection`/`AudioPlayer`/session state is never persisted — on
restart, sessions are simply gone and users re-issue `/play`.

## Logging (`utils/logger.js`)

`winston`, **console transport only** — no file transport. Let Docker's own
`json-file` log driver own rotation (see Deployment) instead of managing
two separate log-rotation stories.
```js
const baseLogger = winston.createLogger({
  level: env.logLevel, // driven by LOG_LEVEL, default 'info'
  format: winston.format.combine(winston.format.timestamp(), winston.format.printf(
    ({ timestamp, level, message, ...meta }) => `[${timestamp}] [${level.toUpperCase()}] ${message}${Object.keys(meta).length ? ' ' + JSON.stringify(redact(meta)) : ''}`
  )),
  transports: [new winston.transports.Console()],
});
```
`redact()` walks a metadata object and replaces any value whose key
contains `token`/`secret`/`password` (case-insensitive) with `[REDACTED]`,
recursively — best-effort insurance in case a secret ever ends up inside a
logged metadata object by accident. `createSessionLogger({ guildId,
guildName, voiceChannelId })` returns `{ info, warn, error, debug }`
pre-tagged with that context, so every log line self-answers who/where.

---

## Deployment — concrete runbook

This is the exact sequence used, generalized. Assumes a fresh Ubuntu/Debian
VPS with root SSH access and a GitHub repo already holding the code.

### 1. Discord Developer Portal (one-time, before any server work)

1. https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Reset Token** → copy it immediately (shown once) → this
   is `DISCORD_TOKEN`.
3. Same tab, **Privileged Gateway Intents**: enable only what the code
   actually requests via `GatewayIntentBits` — this bot needs none of the
   privileged ones (no `GuildMembers`/`MessageContent`), just `Guilds`,
   `GuildVoiceStates`, `GuildMessages`, which aren't privileged.
4. **OAuth2 → General**: copy the **Application ID** — this is `CLIENT_ID`.
5. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`.
   Permissions: `View Channel`, `Send Messages`, `Embed Links`,
   `Use External Emojis`, `Connect`, `Speak`. Open the generated URL, pick
   the server, authorize.
6. Note the values into a local `.env` (never commit it — see
   `.gitignore` below) matching `.env.example`:
   ```
   DISCORD_TOKEN=
   CLIENT_ID=
   GUILD_ID=           # optional, dev-only: instant per-guild command updates
   DB_PATH=./data/bot.sqlite
   DEFAULT_VOLUME=70
   LOG_LEVEL=info       # NOT debug — see "known gotchas" below
   ```

### 2. VPS one-time setup

```bash
ssh root@<vps-ip>
# Docker + compose plugin (Debian/Ubuntu):
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
systemctl is-enabled docker   # must print "enabled" — survives a host reboot
```

### 3. First deploy

```bash
mkdir -p /opt/<bot-name> && cd /opt/<bot-name>
git clone <repo-url> .
cp .env.example .env
vim .env                       # fill in DISCORD_TOKEN / CLIENT_ID, leave GUILD_ID empty in prod
docker compose up -d --build
docker compose ps              # confirm "Up"
docker logs -f <container_name>   # confirm "Bot is online" with no errors, then Ctrl-C
```
Register slash commands once (globally, since `GUILD_ID` is empty in prod —
allow up to ~1h for Discord to propagate them; re-run any time commands
change):
```bash
docker compose exec <container_name> node src/deploy-commands.js
```

### 4. Every later fix — the redeploy loop

```bash
# locally: commit + push
git add -A && git commit -m "..." && git push origin main

# on the VPS:
ssh root@<vps-ip>
cd /opt/<bot-name>
git pull origin main
docker compose down
docker compose up -d --build
docker compose ps
docker logs --tail=50 <container_name>
```
`restart: unless-stopped` means the container also survives a bare host
reboot on its own — this manual cycle is only needed when you're actually
shipping new code, not for routine uptime.

### 5. `Dockerfile` (verbatim)

```dockerfile
FROM node:20-bookworm-slim

# Build toolchain required because @discordjs/opus is a native addon and
# prebuilt binaries aren't published for every Node/glibc combination —
# without these, npm install falls back to node-gyp and fails outright.
#
# ffmpeg comes from apt, not the ffmpeg-static npm package: that package's
# bundled binary is statically linked against glibc, and statically linked
# glibc binaries resolve DNS by dlopen()'ing NSS modules at runtime — which
# segfaults unpredictably in containers. It reads local files and lavfi
# sources fine, then segfaults the instant it has to getaddrinfo() a real
# stream host. apt's ffmpeg is dynamically linked against the container's
# own glibc, so it doesn't hit that mismatch.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates python3 make g++ pkg-config libopus-dev ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

VOLUME ["/app/data"]
CMD ["node", "src/index.js"]
```

### 6. `docker-compose.yml` (verbatim)

```yaml
services:
  bot:
    build: .
    container_name: <bot-name>
    restart: unless-stopped
    network_mode: host
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```
Every field here was earned the hard way — see the gotchas below for why
each one exists. Don't drop any of them "to simplify."

### 7. Verifying a healthy deploy

```bash
docker compose ps                                    # STATUS should be "Up", not restarting
docker logs --tail=30 <container_name>                # only INFO lines, no DEBUG, no repeated WARN/ERROR
docker inspect <container_name> --format '{{.HostConfig.RestartPolicy}}'   # {unless-stopped 0}
docker inspect <container_name> --format '{{.HostConfig.LogConfig}}'      # {json-file map[max-file:3 max-size:10m]}
systemctl is-enabled docker                           # enabled
df -h /                                               # sane headroom
docker system df                                      # build cache; `docker builder prune -f` after a burst of rebuilds
```

---

## Known gotchas (all hit in production, all cost real debugging time)

1. **`ffmpeg-static` segfaults on real network I/O, silently, in Docker.**
   Statically-linked-against-glibc binaries resolve DNS via `dlopen()`-ing
   NSS modules at runtime; this segfaults the instant `getaddrinfo()` is
   called on a real host. Symptom: works fine feeding it `lavfi` synthetic
   sources or local files, crashes on every real stream URL. Diagnose via
   `dmesg | grep segfault` — same crash RIP every time. Fix: apt-installed
   `ffmpeg`, not the npm package's bundled binary.
2. **`network_mode: host` is required for Discord voice, not optional.**
   Voice needs dynamic UDP (IP discovery + RTP). Docker's default
   bridge/NAT network produces `Cannot perform IP discovery - socket
   closed`. Host networking sidesteps this entirely rather than needing to
   punch a UDP port range through bridge NAT.
3. **IPv6 that's configured-but-unroutable silently breaks connections
   that would otherwise work over IPv4.** Node 18+'s `dns.lookup()`
   default ordering can hand back an IPv6 address first for a host that
   also has a working IPv4 address; if the VPS's IPv6 route is dead
   (`ip -6 addr show scope global` empty, `ping -6` says "Network is
   unreachable"), that connection just hangs until timeout instead of
   falling back fast. Fix once, globally, at the top of the entrypoint:
   `dns.setDefaultResultOrder('ipv4first')`. Diagnostic tell: a host you're
   trying to reach resolves via `getent ahosts <host>` to *only* AAAA
   records — that host is unreachable full-stop on an IPv4-only VPS, no
   code fix possible, it's just a dead station/source.
4. **A finite retry-attempt counter that never resets on success is a
   time-bomb, not a safety valve.** See "The reconnect state machine"
   above — reset on the player actually reaching `Playing`, never on
   spawning the subprocess.
5. **`LOG_LEVEL` left on `debug` after initial setup is very easy to
   forget** and produces a firehose of per-voice-packet debug lines
   forever after. Default `.env.example` to `info`; only flip to `debug`
   for a specific live debugging session and flip it back.
6. **Docker's `json-file` log driver has no size cap by default.** A 24/7
   bot with no cap slowly fills the disk, faster than you'd expect if
   `LOG_LEVEL=debug` is ever left on by mistake (see previous point — these
   two compound). Always set `max-size`/`max-file` explicitly in compose.
7. **"У меня нет прав говорить в этом голосовом канале" is almost always a
   real per-channel Discord permission overwrite, not a bug.** A channel
   can deny `Speak` to `@everyone` or to the bot's specific role
   independently of the bot's server-wide role permissions — channel-level
   overwrites win. Fix is in Discord's channel settings, not in code (the
   guard in `voiceGuards.js` is doing its job correctly by catching this
   before attempting to join).
8. **Docker's build cache (`docker system df` → Build Cache) grows with
   every rebuild-during-iteration and is never reclaimed automatically.**
   Run `docker builder prune -f` after a burst of redeploys during active
   debugging; harmless, doesn't touch the running container or its image.

---

## For a custom-music variant (play by URL/name)

This bot is deliberately queueless — "no queue, no track list, no next
track" — switching source just replaces the current stream. A bot that
takes a URL or search term needs real divergence, not just a bigger
`stations.yaml`:

- **Add an actual queue** (per-guild, on the session or a sibling object) —
  track list, current index, skip/next, maybe shuffle/loop. The
  `AudioSession`/`AudioManager` split still holds; the source object per
  track just gets resolved dynamically instead of loaded from YAML.
- **Resolution layer**: given a raw URL or free-text name, resolve to a
  playable stream URL. For YouTube specifically, decide up front between a
  pure-JS extractor (lighter Docker image, but breaks whenever YouTube
  changes something — expect ongoing maintenance) vs. shelling out to
  `yt-dlp` (a Python binary, more robust/actively maintained against
  YouTube's changes, but adds a second runtime to the image alongside
  Node — plan the Dockerfile for it up front rather than bolting it on
  later). Direct-URL-to-audio-file inputs can skip resolution and go
  straight to the same ffmpeg-spawn path this bot already uses.
  Search-by-name needs a provider (YouTube Data API, or the extractor's
  own search) before you even get a URL to resolve.
  It's fine to spend real design time on this piece specifically — it's
  the one part of this whole doc that doesn't already exist in
  `bububuRadio` to copy from.
  Same DNS-in-static-binary caution applies to anything else that ends up
  statically linked and does its own network I/O — see gotcha #1 above; it
  generalizes to any similarly-bundled binary, not just ffmpeg.
- Track-level metadata (title/thumbnail/duration) is available up front
  from the resolver for a music bot, unlike radio where the only source is
  best-effort ICY `StreamTitle` parsing over a *second, separate*
  connection (ffmpeg's own connection discards ICY metadata entirely, so
  radio needed `IcyMetadataReader` as a standalone hack — a music bot with
  a real resolver doesn't need that at all).

# Ludo

A realtime multiplayer Ludo game for phones, made to be played in portrait in the browser. The server is the authority for everything: it rolls every die with Node's `crypto`, checks every move and runs every timer and bot. Phones only send "roll" or "move die *n* with token *t*".

## Setting up a new host machine

Copy this folder to the machine (or `git clone` it) and run:

```bash
./setup.sh            # asks for the two passwords (Enter accepts a generated one)
./setup.sh --yes      # no questions: random passwords, printed at the end
./setup.sh --service  # also install a systemd user service that starts on boot (Linux)
./setup.sh --test     # also run the test suite
```

The script:
- checks for Node.js 22.13 or newer, which has `node:sqlite` built in. If Node is missing or too old, it installs Node 24 without root:
  - Linux and macOS without Homebrew: through [nvm](https://github.com/nvm-sh/nvm)
  - macOS with Homebrew: through Homebrew
  - Alpine: through `apk`
  - Android Termux: through `pkg`
- installs the npm packages
- creates `config.json`, readable only by you, and replaces the default passwords
- builds the app
- offers to open the ports if ufw or firewalld is active
- prints the addresses to open on phones

Running it again is safe: steps that are already done are skipped.

## Quick start (manual)

```bash
npm install
npm run build
npm start
```

On the first start, `config.json` is created from `config.example.json`. **Change both passwords in it before you share the game** (`setup.sh` does this for you).

The terminal shows the addresses to open and the access code:

```
Ludo is running. Open on your phones:
  https://localhost:3443
  https://192.168.1.20:3443
  (http on :3000 redirects to https)

┌──────────────────────────────┐
│  LUDO ACCESS CODE:  482 913  │
└──────────────────────────────┘
```

Open the `https://<LAN-IP>:3443` address on each phone. The certificate is self-signed, so each phone shows a warning once: tap **Advanced → Proceed**. For HTTPS with no warnings, see [HTTPS](#https).

While the server runs, you can type these commands into it:

| Command  | What it does                                     |
| -------- | ------------------------------------------------ |
| `code`   | Shows the current access code                    |
| `rotate` | Makes a new access code                          |
| `quit`   | Stops the server                                 |

### Development

```bash
npm run dev     # backend (tsx watch) + Vite with HMR on https://<LAN-IP>:5173
npm test        # all unit and integration tests
npm run typecheck
```

## How players get in

1. **Splash:** the player taps *Tap to play*. That one tap turns on fullscreen, locks portrait where the browser allows it, unlocks sound, and keeps the screen awake while the app is open. The home screen also has a fullscreen on/off button.
2. **Access code:** a new phone enters the 6‑digit code from the terminal. **Each phone needs a code only once.** The phone gets a permanent device token, saved in `localStorage` and in an HttpOnly cookie. It stays verified when the code changes, when the server restarts, and when its account is deleted or its session revoked. The code is needed again only if an admin taps **Revoke device**, or if the browser's data is cleared.
3. **Name:** the player picks a username. There is no password, and the phone remembers the session, so reopening the page goes straight into the app.
4. **Lobby:**
   - Creating a lobby needs the `lobbyCreatePassword` from `config.json` and a lobby password of the creator's choosing. Friends join with that lobby password.
   - Players pick colours and tap ready. The host can add bots to empty seats and then start the game.
5. **Admin:** tap *Admin login* and enter `adminPassword`. The admin panel can:
   - list, search, rename and delete users
   - revoke sessions and devices
   - show the access code or make a new one

## Rules

- **Board:** the classic layout with 2–4 players. Turns go clockwise: red → green → yellow → blue.
- **Colours** belong to players. Every phone draws each player in the same colour on the same board orientation.
- **Leaving base** takes a 6.
- **Finishing** takes the exact roll; a die that would overshoot cannot be used.
- **Safe squares** are the 4 start squares and the 4 stars. No token can be captured there.
- **Capture:** landing on an opponent's token on any other square sends every opponent token on it back to base, and earns a **bonus roll**.
- **Queued rolls and the three‑sixes penalty:**
  - A 6 means the player rolls again. Each roll is added to a queue, and **no token moves until the queue is closed** by a roll that is not a 6.
  - A **third 6 in a row cancels the whole turn**. The queue is thrown away and play passes to the next player. Nothing had moved yet, so nothing needs to be undone.
  - Once the queue is closed, the player spends the dice in any order: tap a die, then a glowing token.
  - A die that can't move right now is kept, because it may become usable after another die is played. For example, with `[6, 3]`, the 6 brings a token out and then the 3 moves it.
  - When none of the remaining dice can move, they are all dropped and the turn passes.
- **Ranking:** players are ranked as they finish. The game ends when one player is left.

**Timers and bots:**
- Each action has `turnTimeoutSec`. When it runs out, the server plays **the rest of that turn** for the player (rolls and moves), at bot speed. The player can tap to take over again at any point.
- A missed turn shows as "missed n/5" on the player's chip. After **5 missed turns in a row**, or after `disconnectGraceSec` offline, a bot takes over the seat. The player gets the seat back by reconnecting, by making a move, or by tapping *take back*.
- When the only possible move is obvious, the server plays it after a short pause.
- Bots wait until every phone has finished animating the previous roll or move, then pause a little longer to "think". This makes bot turns easy to follow.

**Screen:** the board stays square and edge to edge. The queued dice are on the left. The dice is on the right and only shows while someone still has to roll; once the rolls are done, their values stay in the queue chips.

## Voice chat

Players in a game can talk to each other; joining is optional and bots never join.

- **Join:** tap the headset button in the game's top bar. The browser asks for the microphone the first time. After joining, the same button **mutes and unmutes you**. You can also join, mute and leave from the ☰ options menu.
- **Who is in:** a small mic badge next to each player's name shows who is in the voice chat. It is green when they're live and red when they're muted. It pulses while your phone is still connecting to theirs. Players who haven't joined have no badge.
- **Quality:** in the ☰ options menu, pick **16, 32, 48 or 64 kbps**. Any player in the game can change it, and the change applies to everyone at once, without reconnecting. The default is 32 kbps. Use 16 kbps on mobile data.
- **How it works:** audio goes directly between phones over WebRTC, with every phone connected to every other phone (at most 3 others). The server never handles audio. It only checks that each person is a player in that game, keeps track of who has joined and who is muted, and passes along the messages phones need to connect. The connection is encrypted (DTLS‑SRTP).
- **When you leave:** leaving the board screen, for example for results or home, leaves the voice chat. A dropped connection rejoins it automatically.
- **Playing across networks:** on one Wi‑Fi network, voice works without any setup. When players are on different networks (mobile data, other houses), phones use the STUN server in `voice.iceServers` to find each other. Some mobile networks also need a TURN relay. Add one like this:

  ```json
  "voice": { "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    { "urls": "turn:turn.example.com:3478", "username": "ludo", "credential": "secret" }
  ] }
  ```

  For a LAN-only setup, `"iceServers": []` avoids contacting Google's STUN server at all.

## Reconnecting

- If the connection drops, the app shows a *Reconnecting…* banner and keeps retrying.
- It reconnects right away when the network or the app comes back to the foreground.
- It then reloads the game from the server's snapshot.
- Every game action is saved to SQLite, so after a server restart unfinished games and lobbies come back and players can carry on.
- Each action carries an `actionId` and the state `version` the phone last saw. A retry after a network drop never counts twice, and an action based on an old state is rejected.

## Server authority and anti‑cheat

- **What phones send:** only the intents `game:roll {gameId, version, actionId}` and `game:move {…, dieIndex, tokenId}`. The server checks them against a strict schema and rejects any unknown field, such as `value`, `to` or `userId`.
- **Checks:** for each intent, the server checks:
  1. that it is this player's seat, taken from the session and never from the payload
  2. that the game is in the right phase
  3. the `version`
  4. that the move is in the server's own list of legal moves

  Only then does it roll the die.
- **Dice:** `crypto.randomInt(1, 7)` is uniform and comes from the operating system's cryptographic random generator. The server never sends random state or upcoming rolls.
- **Rate limits:**
  - Socket events use a token bucket, about 10 per second with bursts allowed, and a flooding socket is disconnected.
  - Sign‑up, admin login and access‑code attempts are rate‑limited per IP. After 5 wrong codes an IP is locked out for 1, then 5, 15 and 60 minutes. More than 50 failures across all IPs in 10 minutes makes a new code automatically.
- **Requests before the code:** a device that hasn't entered the code only gets the page itself and the code check. Every other API call, and every socket connection, needs a valid session.
- **Not covered:** this does not protect against network‑level DDoS. If the server is reachable from the internet, put it behind Cloudflare or a reverse proxy and set `"trustProxy": true`.

## HTTPS

Phones need HTTPS for fullscreen, orientation lock and `crypto.randomUUID`, and to install the app to the home screen. The server picks a certificate in this order:

1. **`https.certPath` and `https.keyPath` are set:** it uses that certificate, for example one from Let's Encrypt or mkcert. Run `npm run cert:mkcert` for step‑by‑step instructions for warning‑free certificates on a LAN.
2. **`https.autoSelfSigned` is on (the default):** it uses a self‑signed certificate kept in `data/certs/`, covering `localhost` and every LAN IP. The certificate is made again when the IP changes.
3. **Behind a proxy that handles TLS:** set `"https": { "enabled": false }` and `"trustProxy": true`.

Plain HTTP on `httpRedirectPort` redirects to HTTPS.

## Configuration (`config.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `lobbyCreatePassword` | — | Needed to create a lobby |
| `adminPassword` | — | Admin login |
| `dbPath` | `./data/ludo.db` | SQLite file |
| `turnTimeoutSec` | 30 | Time per action before the server plays it |
| `disconnectGraceSec` | 60 | Offline time before a bot takes the seat |
| `maxLobbies` | 50 | Most lobbies allowed at once |
| `lobbyIdleCloseSec` | 600 | A lobby closes when all its humans have been offline this long |
| `https.enabled` / `port` / `httpRedirectPort` | `true` / 3443 / 3000 | HTTPS listener, and the plain‑HTTP port that redirects to it |
| `https.certPath` / `keyPath` / `autoSelfSigned` | `""` / `""` / `true` | Certificate source |
| `port` | 3000 | HTTP port when HTTPS is disabled |
| `trustProxy` | `false` | Trust `X-Forwarded-*` headers |
| `gate.maxFailsPerIp` / `globalFailRotateThreshold` | 5 / 50 | Limits on access‑code guessing |
| `voice.iceServers` | Google STUN | STUN/TURN servers for voice chat; see [Voice chat](#voice-chat) |

Environment variables override the file. The available ones are `LUDO_CONFIG`, `LUDO_PORT`, `LUDO_DB_PATH`, `LUDO_LOBBY_CREATE_PASSWORD`, `LUDO_ADMIN_PASSWORD`, `LUDO_HTTPS`, `LUDO_HTTPS_PORT`, `LUDO_CERT_PATH`, `LUDO_KEY_PATH` and `LUDO_TRUST_PROXY`.

## Project layout

```
src/shared/   board geometry, pure rules engine, socket protocol and schemas (used by server and client)
src/server/   express + socket.io, config, sqlite, access gate, sessions, lobbies, game manager, bots, TLS
src/client/   vanilla TS screens, SVG board, WAAPI token animations, 3D CSS dice, WebAudio sounds,
              WebRTC voice chat (voice.ts)
tests/        Vitest: rules, dice, users and sessions, lobbies, game manager (fake timers), bot,
              access gate (HTTP), socket integration, anti‑cheat, TLS, voice chat, board geometry
```

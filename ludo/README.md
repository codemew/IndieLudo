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
npm run test:e2e  # builds, then plays the lobby, second lap and results screens in headless Chrome (CHROME_PATH to pick one; skipped if none is found)
npm run typecheck
```

## How players get in

1. **Splash:** the player taps *Tap to play*. That one tap turns on fullscreen, locks portrait where the browser allows it, unlocks sound, and keeps the screen awake while the app is open. The home screen and the game screen also have a fullscreen on/off button.
   - **The browser's fullscreen bubble:** each time a page goes fullscreen, the browser briefly shows "*site* is now full screen, swipe down to exit". No web page can hide that bubble. To get rid of it, install the app:
     - **Android Chrome:** tap **📲 Install app**, on the splash screen or in the home screen's ⋯ menu.
     - **iPhone:** use Share → **Add to Home Screen**.
   - **After installing:** open the game from its home‑screen icon. It then opens fullscreen with no bubble and no browser bars.
   - **Certificate:** Chrome only offers to install over a trusted certificate (mkcert or a real one; see [HTTPS](#https)), not the self‑signed one.
2. **Access code:** a new phone enters the 6‑digit code from the terminal. **Each phone needs a code only once.** The phone gets a permanent device token, saved in `localStorage` and in an HttpOnly cookie. It stays verified when the code changes, when the server restarts, and when its account is deleted or its session revoked. The code is needed again only if an admin taps **Revoke device**, or if the browser's data is cleared.
3. **Name:** the player picks a username. There is no password, and the phone remembers the session, so reopening the page goes straight into the app.
   - **Changing it later:** tap your name or avatar at the top of the home screen. Your seat in the lobby, and in a game in progress, shows the new name to everyone at once.
4. **Lobby:**
   - Creating a lobby needs the `lobbyCreatePassword` from `config.json` and a lobby password of the creator's choosing. Friends join with that lobby password.
   - Everyone, the host included, starts on a random free colour, picked by the server. Players can then move or swap, and tap ready. The host can add a bot to any open seat with that seat's **＋ Bot** (a bot is always named after its seat, e.g. "Bot Green"), and then start the game.
   - **Swapping colours:** tap an open seat to move there, or **⇄ Swap** on another player's seat to ask them to swap.
     - **Asking:** they get a prompt showing who becomes which colour, with 20 seconds to answer. You can cancel while you wait.
     - **Accepting:** both colours swap at once for everyone, and ready status is kept.
     - **Bots:** swapping with a bot happens immediately.
     - **Both asking:** if two players ask each other, they just swap.
     - **When a request lapses:** if either player leaves, moves to another seat, or the game starts.
   - **Watching:** up to 4 people per lobby can watch without a seat, and they're in its voice chat too.
     - **Joining to watch:** tap a lobby card and choose **👀 Watch**. That's the only way into a lobby whose game is already running (its card says *In game · 👀 Watch*) or whose seats are all taken. Watching still needs the lobby password.
     - **From a seat:** tap **👀 Watch instead** between games; **Sit here** on an open seat takes one again.
     - **In a game:** spectators see every move live, with *👀 Watching* in the hint line, and can't roll or move anything; the server refuses it. **Stop watching** in the game menu leaves the lobby.
     - **The host can watch too**, and still adds bots, kicks and starts the game.
   - **Bot battle:** the host taps **👀 Watch instead**, then **🤖 Fill open seats with bots**, then **🤖 Start bot battle**.
     - **Speed:** with no person seated, the bots play at full speed. They don't pause to "think", and every animation and pause runs at 0.4× its normal length (`BOT_BATTLE_TEMPO` in `src/shared/types.ts`). The server waits out the same shortened animations, so every phone keeps up.
     - **Afterwards:** the bots stay seated, so the next battle is one tap away. After a normal game the bots leave as before.
5. **Admin:** tap *Admin login* and enter `adminPassword`. The admin panel can:
   - list, search, rename and delete users
   - list open lobbies and **close** any of them, even mid‑game. Everyone in it goes back home with a notice, and a game in progress ends without a result.
   - revoke sessions and devices
   - show the access code or make a new one

## Rules

- **Board:** the classic layout with 2–4 players. Turns go clockwise: red → green → yellow → blue.
- **Colours** belong to players. Every phone draws each player in the same colour on the same board orientation.
- **Leaving base** takes a 6.
- **Finishing** takes the exact roll; a die that would overshoot cannot be used.
- **Second lap:** a token about to turn into its home stretch on its first lap may go round the whole board once more instead.
  - **Choosing:** the board shows a branching path, a gold trail into the home stretch and a blue one round again. Tap the gold or blue marker at the end of a trail to go that way, or tap the token for a **Which way?** sheet with two cards: **🏠 Head home** (squares left, safe from capture) and **↻ Go round again** (who it would capture on landing; how far it is left for the player to judge). **Not now** closes it without moving.
  - **On the second lap:** the token moves, captures and can be captured like any other, and wears a dashed white ring. At the end of that lap it turns home; it can't go round a third time.
  - **Bots and the timer:** they head home, unless going round would capture someone.
- **Safe squares** are the 4 start squares and the 4 stars. No token can be captured there.
- **Surrender:** a player can give up at any time, not just on their turn, from the game menu (**🏳️ Surrender**, with a confirm).
  - **Their tokens:** any not yet home go back to base, clean-shaven and greyed out, and a white flag waves over that base on every phone. Nobody can capture them any more.
  - **The game:** the player takes no more turns and can watch the rest. If only one player is left, the match ends there.
  - **Final places:** players who finished, then the last one still playing, then those who surrendered (the last to give up ranks highest). The podium marks them with 🏳️.
- **Your tokens sharing a square:** tap the one you want to move. When they wear different moustaches, the game always waits for your pick, so you can send a clean-shaven token forward and keep the macho one safe. Bots and the timer do the same: they move the smaller moustache.
- **Capture:** landing on an opponent's token on any other square sends every opponent token on it back to base (two stacked tokens are both captured), and earns a **bonus roll** for each token captured. Each captured token also grows the capturer's moustache a level.
- **Reaching home:** a token that reaches home also earns a **bonus roll**. The exception is a player's last token, because that player has finished. Bonuses add up, and each one is used once the dice already queued have been played.
- **A useless six ends the turn:** when every token a player has left is in the home lane, a 6 can never be used, because even the first lane square plus 6 overshoots home. The 6 then ends the turn at once instead of giving another roll.
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

**Effects:**
- **Six streak:** the first six lights a warm amber fire along the floor under the dice queue (left side, fading out before the dice), and the second makes it a taller, deeper orange one, like a classic fire. Each has its own sound. The fire sits behind the controls without blocking taps. The cube keeps glowing in the colour of the player whose roll it is. Three sixes bring a sad face 😩 and a sad trombone.
- **First blood:** the first capture of a game slams a red **FIRST BLOOD** banner across the board on every phone, showing who captured whom, with a drum hit.

## Moustaches and heavy tokens

Every capture grows the capturing token's moustache a level, and makes it heavier to move.

| Kills | Moustache | Each hop |
|---|---|---|
| 0 | none | normal |
| 1 | bold chevron | ×1.35 slower |
| 2 | horseshoe | ×1.8 slower |
| 3 | handlebar | ×2.5 slower |
| 4 or more | giant bushy imperial | ×3.5 slower |

- **Every hop:** tokens crouch, spring up, land with a squash and rebound, and rock side to side.
- **Heavier tokens:**
  - **Hops:** they crouch and squash more, hop lower, flap their moustache on every hop, and jiggle to a stop.
  - **Board shake:** from the first kill, harder with each level.
  - **Dust:** kicked up from 2 kills.
- **Moustache:** it twitches now and then, puffing up and bouncing once as it does (the "pump"). After a capture, it waits until the token is still, with no reaction face and no hop, then pauses 2 more seconds. The old moustache fades as the new one grows in over 1.4 seconds, pumping up to twice its size first, so the growth is always visible.
- **Losing it:** a captured token goes home clean‑shaven, back to 0 kills.
- **Same on every phone:** the server counts kills per token, so every phone shows the same moustache. Bots and turn timers wait for the slower moves.

## End of game: awards and stats

The results screen shows awards, everyone's match stats, and each player's award icons on the podium. The server counts the stats while the game is played, so they can't be faked, and they're saved with the game.

| Stat | Award | What counts |
|---|---|---|
| 👣 Cells | Most cells travelled | Every square moved; leaving base counts as 1 |
| ⚔️ Captures | Most tokens captured | Opponent tokens sent back to base |
| 🎲 Sixes | Most sixes | Every 6 rolled, including ones lost to the three‑sixes penalty |
| 😤 Revenges | Most revenges taken | Capturing a player who captured you and whom you hadn't paid back yet. Each capture can be avenged once. |
| 🥸 Macho | Most macho | Moustached tokens brought home: a token that has captured someone (and hasn't been captured since) reaching home |
| 💈 Staches | 👶 Baby face (the comedy trophy) | The **fewest** clean-shaven tokens that grew a moustache (a token's first capture since it last left base). It's only given when someone else grew more, so it never goes to everyone. |
| 🩸 First blood | First blood | The game's first capture |

- **Ties:** a tied award goes to everyone tied.
- **No score:** a stat nobody scored has no award.

The lobby shows each player's lifetime wins (🏆) beside their name.
- **Reactions:** tokens briefly turn into a face that plays its own little animation, then go back to normal. One of four is picked at random for each moment, never the same one twice in a row:

  | Moment | Reactions |
  |---|---|
  | Landing on a star square (with a chime) | 😌 relieved sway · 😎 cool drop‑in and nod · 🥳 spin and wiggle · 😇 glowing float |
  | Capturing a token (with a slurp) | 😋 chews and licks its lips · 🤤 satisfied wobble · 😈 gleeful shake · 😏 smug head tilt |
  | Being captured and sent home | 😵 spins dizzily · 😭 sobs · 😱 jumps and trembles · 😖 squashed flat, then springs back |
  | An opponent gets right behind it | 🏃 sprints on the spot · 😰 nervous shakes · 🥶 frozen with fear, shivering |

  - **"Right behind":** an opponent 1–5 squares behind on the track, close enough to capture it with an ordinary roll.
  - **Never in danger:** a token on a star or start square, a token in its home column, or one the opponent can't reach because the opponent turns into its own home column first.
  - **Once per threat:** the reaction plays once, when the danger starts, not for as long as it lasts.
  - **Timing:** each reaction lasts about 1.8 seconds.
- On your move, the die your next tap will use is lifted, outlined in your colour and tagged **USE**, and dice that can't move anything are greyed out. The board marks where each glowing token would land.
- The dice is a light cube with a glow in dark mode, and a dark cube with a shadow in light mode.

**Screen:** the board stays square and edge to edge. The queued dice are on the left. The dice is on the right and only shows while someone still has to roll; once the rolls are done, their values stay in the queue chips.

## Voice chat

Everyone in a lobby is automatically in that lobby's voice chat. Bots never are. It starts when you enter the lobby and stays connected through matches and results. You leave it by leaving the lobby or being kicked. It also ends when the lobby closes or the host turns it off.

- **Mute yourself:** the mic button is on the lobby screen, the game screen, and the home screen while you're in a lobby. It's green when you're live and red when you're muted. The browser asks for the microphone the first time. If you block it, you still hear everyone and show as muted, the button turns amber, and tapping it asks again.
- **Who is in:** a small mic badge next to each name, on the lobby seats and the game's player cards. It's green when that person is live and red when muted. It pulses while your phone is still connecting to theirs.
- **Can't hear someone?** Tap **Rejoin voice**, on the lobby screen or in the game's ☰ menu. Your phone gets a fresh microphone and reconnects to everyone. The status line above it shows how many players you're connected to.
- **Host controls:** these are on the lobby screen and in the game's ☰ menu. If the host leaves, the next host gets them.
  - **Restart for everyone:** every phone drops its voice connections and joins again from scratch. Use it when several players can't hear each other.
  - **Turn off / Turn on:** turns voice chat off or on for the whole lobby. While it's off, no phone uses its microphone.
  - **Quality:** **6, 12, 24 or 48 kbps**. The change applies to everyone at once, without reconnecting. The default is 24 kbps. 6 kbps saves the most mobile data and still keeps speech clear. Browsers won't encode voice below 6 kbps. Other players can see the setting but not change it.
- **How it works:** audio goes directly between phones over WebRTC, with every phone connected to every other (at most 3 others). The server never handles audio. It only checks lobby membership, keeps track of who is in and who is muted, and passes along the messages phones need to connect. The connection is encrypted (DTLS‑SRTP).
- **Repairs itself:**
  - **No crossed calls:** of each pair of phones, only the one whose user id is lower dials. The other asks it to call back with a "ring". So two phones that reconnect together never call each other at once.
  - **Watchdog:** every 2 seconds each phone checks its links. It redials a link that broke, or hasn't connected within 12 seconds. If the phone took the microphone away (iOS does this when it's locked or another app is opened), it gets a fresh one. It also starts any incoming audio the browser refused to play.
  - **Reconnects:** after a dropped connection, the phone rejoins on its own.
  - **Earphones:** connecting or removing Bluetooth or wired earphones during a call moves voice to them, or back to the phone, without reconnecting. Phones pick the audio route when the mic is opened, so the app opens a fresh mic on the new device and swaps it into every call.
- **Playing across networks:** on one Wi‑Fi network, voice works without any setup. When players are on different networks (mobile data, other houses), phones use the STUN server in `voice.iceServers` to find each other. For a LAN‑only setup, `"iceServers": []` avoids contacting Google's STUN server at all.
- **Voice through the game server, built in:** two phones sometimes can't connect directly. A typical case is a phone on Jio mobile data, reachable only over IPv6 or through carrier NAT, and a phone on IPv4‑only home Wi‑Fi.
  - **The switch:** if a pair hasn't connected directly within 8 seconds, each of the two phones sends its voice for that link through the game server instead.
  - **The audio:** it's Opus at the lobby's quality setting, in small batches over the same connection the game uses. So it works anywhere the game works, with no router changes.
  - **Back to direct:** the direct link keeps retrying, and takes over again if it ever connects.
  - **Extra delay:** about 0.2 s on those links only.
  - **What you see:** the voice **Details** shows "via the game server", and the status line says how many players go through the server.
  - **Browsers:** it needs a recent Chrome (on Android or desktop). On iPhone it needs a recent iOS.
- **Optional, a TURN relay (lowest delay):** carrier networks usually can't connect directly to a phone on home Wi‑Fi, and the built‑in route above already handles that. A TURN relay does the same job with a little less delay. It needs a public IP and open UDP ports on your router. carrier networks usually can't connect directly to a phone on home Wi‑Fi. A TURN relay carries the audio for those links.
  - **Symptoms:** a player's mic badge keeps pulsing for some players, and the voice **Details** shows "routes exchanged but none got through", or that phone with no "internet" route.
  - **Only failing links use it:** phones that can connect directly still do.
  - **Option A, your own relay (coturn):**
    1. Install it: `sudo apt install coturn`.
    2. In `/etc/turnserver.conf` set:
       ```
       listening-port=3478
       fingerprint
       use-auth-secret
       static-auth-secret=<a long random secret>
       realm=ludo
       min-port=49160
       max-port=49200
       external-ip=<your public IP>   # when the host is behind a router
       ```
    3. Forward **UDP and TCP 3478** and **UDP 49160–49200** from your router to the host.
    4. Add the relay to `config.json`. The server gives each player a login that expires after 12 hours (`ttlSec` changes this), and the secret never reaches the phones:
       ```json
       "voice": {
         "iceServers": [{ "urls": "stun:stun.l.google.com:19302" }],
         "turn": { "urls": ["turn:<your public IP>:3478", "turn:<your public IP>:3478?transport=tcp"], "secret": "<the same secret>" }
       }
       ```
       The env vars `LUDO_TURN_URLS` (comma‑separated) and `LUDO_TURN_SECRET` work too.
  - **Option B, a hosted relay:** Metered, Twilio, Cloudflare Realtime and others offer one. Add the URL and login they give you to `iceServers`:
    ```json
    { "urls": "turn:relay.example.com:3478", "username": "…", "credential": "…" }
    ```
- **Slow networks:** a phone sends the routes it finds within 3 seconds with its call, and any found later (a relay often takes longer on cellular) follow on their own.

## Updating the app on phones

- **The page is always checked:** the server tells browsers to check the main page with the server every time (`Cache-Control: no-cache`). After you rebuild and restart the server, a normal reload loads the new version.
- **Built files:** the game's script and stylesheet have the build's fingerprint in their names, so they can be cached for a year without going stale.
- **A phone that kept the game open:** it shows **"v… is ready · Update now"** at the bottom of its home screen, since the server tells each phone its version when it connects.
- **Up to date:** while a phone already runs the server's version, the button is disabled and reads **✓ Up to date**.
- **Update now:** the button goes through `/refresh`.
  - That page sends `Clear-Site-Data: "cache"`, which drops the browser's saved copies of the site's files. It doesn't touch logins, cookies or local data.
  - The app also deletes any offline caches.
  - Then it reloads the game, and reports "Updated to v…" (or that it's already up to date).

## Signal and ping

- **What you see:** every player in the lobby or a game shows **signal bars** next to their name and their **ping in ms** beside their icon. The server measures these itself, so a phone can't fake its own numbers or anyone else's.
- **How it's measured:**
  - Every 3 seconds the server sends a tiny ping to each phone that's in a lobby, and times the reply.
  - It then sends each lobby an update with everyone's results, but only when something shown changed (at least every 15 s anyway).
  - The ms figure is smoothed, so one slow reply doesn't make it jump. It's shown exactly below 50 ms, to the nearest 5 ms up to 200 ms, and to the nearest 10 ms above that.
- **Bars:**

  | Ping | Bars |
  |---|---|
  | up to 80 ms | 4 |
  | up to 150 ms | 3 |
  | up to 300 ms | 2 |
  | slower | 1 |
  | no reply yet, or 2 lost pings in a row | 0 |

  Each ping lost among the last 5 costs one bar, but a phone that still replies never drops below 1.
- **Colours:** green, lime, amber, red.

## Data use and connection

- **Compressed messages:** game messages over the WebSocket are compressed, and the compressor remembers earlier messages. Each game update repeats most of the one before, so a 1.5 KB update costs about 50 bytes. A phone watching a whole 4‑bot game receives about 50 KB instead of about 1.5 MB.
- **Nothing sent twice:**
  - The lobby list on the home screen goes out only when it changes, not when someone gets ready or a phone drops offline.
  - Ping stats go out only when they change.
- **Voice:**
  - **Silence suppression (DTX):** while someone isn't talking, their phone sends a tiny packet every 400 ms instead of audio every 20 ms, which cuts most voice data in a game.
  - **Error correction (FEC):** in-band error correction rides out lost packets on patchy mobile data.
  - **Server relay:** voice relayed through the game server skips silent packets entirely.
- **App download:** the built JavaScript and CSS are sent brotli-compressed (gzip for older browsers): about 53 KB instead of 201 KB, once per update, because they're cached for a year.
- **Networks that block WebSockets:** the app falls back to plain HTTP requests instead of failing to connect.

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

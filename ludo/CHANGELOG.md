# Changelog

## Unreleased

### Added
- **`./setup.sh --devinstall`** for a developer machine. It installs only what is missing to develop, debug and test every part of the app: Node.js, all npm packages with the dev tools (`npm ci --include=dev`), Google Chrome or Chromium for the browser tests (and a check that it starts headless), `alsa-utils` (the recordings the voice browser tests use as the fake microphone), emoji and Liberation fonts, `git`, `curl` and the NSS tools for mkcert. Works on apt, dnf/yum, pacman, zypper and apk; it makes no config, build, firewall or service, and leaves `package-lock.json` alone. It lists anything it couldn't install and exits with 1.

## 3.3.0

### Added
- **5- and 6-player boards.** The host picks 4, 5 or 6 players in the lobby.
  - **Shape:** a pentagon or hexagon in the middle with an arm per player. Each arm is today's arm (3 × 6, start square, star, 5-square home column), so every rule carries over; the track is 65 or 78 squares.
  - **New colours:** purple for the fifth seat and orange for the sixth. On the 6-player board warm and cool colours alternate (red, green, yellow, blue, orange, purple).
  - **Lobby:** up to 6 seats; the seat cards shrink to three to a row. Shrinking the board is refused while too many are seated, and players on purple or orange move to a free colour. Team-up stays on the 4-player board.
  - **Game screen:** the board keeps its shape at any screen size, and the player cards sit in rows of three near their bases. Results show up to six places.
  - **Voice:** up to 10 people in a lobby's voice chat (6 seats and 4 spectators).

### Changed
- **The dice belongs to the player rolling.** Only they see it in the dock and can tap it. Everyone else (players, spectators) sees the same roll over that player's base on the board; the queue and every effect (sounds, six-streak fire, callouts, 😩) are unchanged.
- **Slim roll messages.** A roll that only adds to the queue goes out whole to the roller and as about 240 bytes to everyone else (about 2–3 KB before). Their phones apply it to the state they have and ask for the whole state if one was missed.

### Tests
- **Unit tests:** 587, up from 535; line coverage stays at about 91%.
  - **Board geometry:** the generator reproduces today's board square for square; the 5- and 6-player tracks are one unbroken loop with no overlaps.
  - **Rules:** a table run on all three boards, and bots playing 5- and 6-player games to the end.
  - **Lobby:** the seat-count switch and recolouring.
  - **Slim roll messages:** checked over sockets against the server's state.
  - **Game screen:** which dice shows where.
- **Browser tests:** 38 in Chrome, up from 34: a 6-player game with two phones (dice placement, bytes per roll, six places on the results) and a 5-player game with bots. The voice tests now expect the voice server's 10 audio sections.


## 3.2.0

### Added
- **Wildcard entry.** Hold your home triangle (or use 🃏 in the game menu) to send tokens from home back to base and play them again.
  - **Any time:** also on other players' turns, and even after finishing (that player gives up their place until all four are home again).
  - **The token:** keeps its moustache and needs a 6 to come out.
  - **Two laps at most:** each token gets one extra lap, used by going round again or by a wildcard entry, so at most four per player.
  - **Home again:** another bonus roll and another macho arrival. The new 🏠 Home stat counts every arrival, so 5 is possible.
  - **On every phone:** a hazard-striped "WILDCARD ENTRY · beware!" banner, the token flying from home to base with a shockwave, its own sound and a vibration.
- **Team-up mode**, chosen by the host in the lobby: 2 vs 2, Red + Yellow against Green + Blue.
  - **Winning:** both partners home wins it; a partner who finishes first sits out; a surrender concedes for the team.
  - **Friendly fire:** allowed, with a confirm. The bonus roll is kept, but the capturer's moustache shrinks a level. Bots do it only when nothing else is possible.
  - **In the lobby and the game:** team tags and "＋ Bot teammate / opponent" in the lobby; partner badges on the chips; "Your team won!" on the results for both winners, who both get a lifetime win.
- **Awards:** Balls of steel (a drawn steel ball) for the most risks taken (laps round again plus wildcard entries), and 🗡️ Backstabber for the most teammates captured.
- **Which token moves?** Tapping your stacked tokens that differ (moustache, last lap) opens a sheet with each one large.
- **Voice goes over the internet first.**
  - **Local routes:** offered only by phones on IPv4 with a ping under 40 ms (`voice.localMaxPingMs`), ranked after the internet ones, or after the internet route hasn't connected for 5 s. This applies to the voice server and the direct links.
  - **Public address:** without `announcedIp`, the voice server learns it from how internet phones connect.
  - **Details:** shows which route rule applies.

### Fixed
- **Results with a long name and several awards:** the awards no longer spill out of the podium row. The name wraps, the awards sit under it, and a long heading wraps too.
- **The gold and blue lap markers can be tapped:** the token layer used to catch the tap. The browser tests now tap at real screen positions.

### Changed
- **The timer pauses:** a surrender or wildcard entry by someone else pauses the current player's timer instead of restarting it.

### Tests
- **Coverage:** 535 unit tests, up from 334, at 90% line coverage (enforced: 80% overall, 95% for shared and server code; `npm run test:coverage`).
  - **Rules:** a rules matrix, the wildcard entry and Team-up.
  - **Voice:** address and route ranking.
  - **Client:** every screen in happy-dom.
- **Browser tests:** 34 in Chrome, including holding the home triangle, Team-up from lobby to results, long names on results at 390 and 360 px, and the internet-first voice route.

## 3.1.1

### Changed
- **Voice quality starts at 6 kbps** (was 24) in every new lobby. That's the least mobile data, and speech stays clear. The host can still pick 12, 24 or 48 kbps for richer sound, and that choice applies to everyone.

## 3.1.0

### Added
- **Voice Details show how voice travels.**
  - **Game connection:** WebSocket over TCP (or HTTP long-polling).
  - **Voice server:** the transport (UDP or TCP), both ends' address and port (local network or internet, Wi-Fi or mobile, IPv4 or IPv6), round-trip time, kbps up and down, packet loss, jitter and codec.
  - **Each player:** whether their voice comes via the voice server (UDP), a direct link (UDP or TCP) or the game-server relay (TCP), with their audio's stats.
  - **Recent:** a log of reconnects and their reasons.
  - **Copy report:** includes all of it.
- **Automatic voice reconnect when a phone switches between Wi-Fi and mobile data.**
  - **Noticing:** the phone notices the switch, checks whether the game connection still answers, and redoes voice over the new network, or reconnects the game connection first if it went stale.
  - **When the server notices first:** it tells the phone when it loses a link.
  - **Silent switches:** a voice link whose route goes quiet is redone after 3 s; it used to take 12 s or more.
  - **Measured in Chrome:** back in about 1 s after a network change, 1.2 s after the game connection drops, and 0.2 s after the voice server loses a link.

### Fixed
- **Others no longer dial someone directly while they reconnect** to the voice server. They wait for them to come back, so there's no burst of direct calls that close again moments later.
- **The voice Details named spectators "player 12"** instead of their names.

### Tests
- **Unit tests:**
  - reading WebRTC stats into routes and stats
  - the reconnect decisions after a network change, with the game connection stale or still answering
  - keeping the voice-server flag across a rejoin
- **In Chrome:**
  - the Details showing UDP, addresses, ports, bitrates and the WebSocket game connection
  - recovery after a network-change event, a link dropped by the voice server, and a dropped game connection, each in under 6 s

## 3.0.0

### Added
- **Built-in voice server (UDP).** Every phone in a lobby's voice chat now has one connection to the game server, sends its voice once, and the server passes it on.
  - **Less upload:** measured with 4 people, about 3.3× less upload per phone (131 KB a minute against 438 KB), and the gap grows with more people.
  - **Works across networks:** every phone reaches the server, so mixed networks such as Jio mobile data and IPv4-only Wi-Fi work.
  - **Faster reconnect:** one connection to redo, instead of one per player.
  - **Fallbacks:** direct links and the relay over the game connection are kept for phones that can't reach the voice server.
  - **To play over the internet:** forward UDP 40000–40099 (`voice.sfu.portMin`/`portMax`) on the router. `setup.sh` opens them in the host's firewall.
- **AI noise removal (RNNoise) and voice focus.**
  - **Noise removal:** fans, traffic, TV and keyboard noise are removed on the phone. It's a 112 KB download the first time voice starts, then cached.
  - **Voice focus:** rumble and hiss are filtered out, speech presence is lifted, and levels are evened out. The phone's "voice isolation" is used where it has one.
- **No packets while you're quiet:** a voice gate, using RNNoise's speech detection, stops all voice packets while you're not talking, even with steady background noise. In tests a voice followed by silence and then fan noise sent nothing for the whole 9 s of silence and noise. A 30 ms look-ahead keeps first syllables whole.
- **Talking rings:** rings radiate from the avatar of whoever is talking (lobby seats, spectators, game player cards), bigger and brighter the louder they talk. The level travels inside each voice packet (RFC 6464), so it costs no extra data.
- **8 people in voice at once** (4 seats + 4 spectators), tested end to end.

### Fixed
- **The voice relay reached only 3 listeners**, so in a lobby of 8 some people never heard relayed audio. It now reaches all 7 others.
- **Connections per IP:** raised from 10 to 24, so a whole family behind one public IP isn't turned away while phones reconnect.

### Changed
- **💈 Staches column removed** from the end-of-game stats. The 👶 Baby face award stays.
- **The page's security policy** allows WebAssembly to compile (`'wasm-unsafe-eval'`, for RNNoise). JavaScript eval is still blocked.

### Not done
- **Larger packets at the 6 and 12 kbps steps (40 ms frames):** left out. Changing it while a call is running would mean renegotiating every connection, and the savings only show at those two settings.

### Tests
- **Voice server:**
  - audio passed to the right slot and never back to the sender
  - nothing passed in silence
  - continuous sequence numbers after a reconnect
  - all 8 people of a full lobby hearing each other
  - outsiders, oversized messages and the switched-off server refused
- **Voice gate:** speech, pauses, steady noise, RNNoise decisions, a silent mic.
- **Mic settings, talking levels, the relay gate, and `voice.sfu` config.**
- **In Chrome**, with a real recorded voice as the microphone:
  - voice through the voice server with no direct links
  - RNNoise loading with no security errors
  - no packets in silence or fan noise
  - rings appearing and stopping
  - 8 phones (4 seated, 4 watching) all on the voice server
  - the direct-link fallback with the voice server off

## 2.5.1

### Added
- **The finish is labelled HOME** in the centre of the board, so it's easy to see where a token is headed, especially on a second lap when it passes its own start again.

### Tests
- **Two tokens on one ordinary square:** a token landing there captures both. The checks cover:
  - both go home clean-shaven
  - the capturer's moustache grows two levels and its hops get heavier
  - two captures but one moustache grown (for Baby face), and first blood once
  - revenge paid per token, and a bonus roll per token
  - pairs of different colours, and a second-lap token in the pair
  - a pair on a star stays safe
  - the double-moustached token counts once for Most macho
- **In the browser:** both tokens slide back to base on both phones, and the moustache grows straight to level 2.

## 2.5.0

### Added
- **🏳️ Surrender:** a player can give up at any time from the game menu, with a confirm.
  - **Their tokens:** any not yet home go back to base, greyed out under an animated white flag that waves over their base on every phone.
  - **The game:** they take no more turns and can watch the rest. When only one player is left, the match ends and that player wins.
  - **Final places:** finishers, then the last one playing, then those who surrendered (the last to give up ranks highest), marked 🏳️ on the podium.

### Changed
- **"Barber's nightmare" is now 👶 Baby face, a comedy trophy for the fewest moustaches grown.** It's only given when someone else grew more, so it never goes to everyone. The **Staches** column highlights the fewest.

### Tests
- **New:** tests for surrendering (rules, places, turns, retries and outsiders, the winner's win, and three phones in the browser) and for the Baby face rules.

## 2.4.0

### Added
- **💈 Barber's nightmare:** a new award for whoever turns the most clean-shaven tokens into moustached ones (a token's first capture since it last left base). It also shows as a **Staches** column in the match stats. Games saved before this count it as 0.

### Changed
- **You choose which of your stacked tokens moves.** When your tokens share a square, for example on a star, but wear different moustaches, the game no longer moves one for you after 0.7 s: it waits for you to tap the one to send forward, so you can sacrifice a clean-shaven token instead of your macho one. Alike tokens are still moved for you when that's the only possible move.
- **Bots and the timer protect moustaches too:** they move the token with the smaller moustache from a shared square.

### Fixed
- **A new name shows up in the lobby.** After renaming yourself on the home screen, creating or joining a lobby still showed your old name, because the connection kept the name it had when it opened. It now uses your current name.

### Tests
- **New:** tests for stacked tokens with different moustaches (rules, server, bot, and in the browser), the new award, and renaming before joining a lobby. The rename test fails without the fix.

## 2.3.1

### Fixed
- **The board no longer shifts up and down during a game.** It only stays still if the areas above and below it keep their height, and they didn't:
  - **The dice queue:** grew by 18 px when dice appeared in it.
  - **The hint line:** grew a second line for longer hints (such as "Time's up…").
  - **The take-back button:** added a row.
  - **Player chips:** grew when a ping label appeared under an avatar.

  These now all have fixed heights, and the take-back button takes the hint's place. Measured on 390×844 and 360×640 screens, the board stays in one place through a whole game. Only the tokens move, including the heavy moustache hops and the board shake.

### Tests
- **Browser checks:** the board must not move between turns, or through 4.4 s of a bot battle.

## 2.3.0

### Added
- **Watching (spectators).**
  - **Who:** up to 4 people per lobby can watch without a seat, and they're in the lobby's voice chat.
  - **Joining to watch:** tap a lobby card and choose **👀 Watch**. That works even when its game is running or its seats are full. It needs the lobby password.
  - **From a seat:** **👀 Watch instead** gives up your seat between games; **Sit here** takes one again.
  - **Watching a game:** spectators see it live with a *👀 Watching* tag and can't roll or move; the server refuses it. **Stop watching** in the game menu leaves the lobby.
  - **The host can watch** and still runs the lobby.
- **Bot battles:** the host watches, taps **🤖 Fill open seats with bots** and **🤖 Start bot battle**.
  - **Full speed:** with no person seated the bots don't pause to "think", and everything on the board runs at 0.4× its normal length. Early on, when most turns are a roll with nothing to move, that's about 0.8 s per turn instead of 3.3 s.
  - **Afterwards:** the bots stay seated for the next round, and the results say "Bot Blue wins the bot battle".

### Changed
- **Much less data:**
  - **Game messages are compressed:** a phone watching a whole 4‑bot game now receives about 51 KB instead of about 1.4 MB, roughly 28× less.
  - **Voice:** uses silence suppression (DTX) and error correction (FEC). Relayed voice skips silent packets.
  - **App files are sent brotli-compressed:** 53 KB instead of 201 KB per update.
- **Fewer repeated messages:**
  - The lobby list goes out only when it changes; before, every phone got it again whenever anyone got ready or went offline.
  - Ping stats go out only when they change (at least every 15 s). Pings are shown to the nearest 5 ms between 50 and 200 ms, and to the nearest 10 ms above that.
- **Connects on more networks:** if a network blocks WebSockets, the app falls back to plain HTTP requests instead of failing.

### Tests
- **New:** tests for spectators (joining, sitting, hosts, cleanup, restarts), the speed of bot battles, watching over real sockets, a whole bot battle, compression being negotiated, the lobby list and ping stats not being re-sent, compressed app files (including path escapes), silent voice packets, and a browser run of watching and a bot battle.

## 2.2.0

### Added
- **🥸 Most macho award:** goes to whoever brings the most moustached tokens home. A token counts if it has captured someone and hasn't been captured since (being captured shaves it). It also shows as a **Macho** column in the match stats. Games saved before this count it as 0.
- **Browser smoke tests** (`npm run test:e2e`): two phones in headless Chrome play through "+ Bot" on a seat, a bot swap, both ways of choosing at the home turn, and the results screen with the macho award.

### Changed
- **The "home or round again" choice is clearer.**
  - **Option cards:** a **Which way?** sheet has two cards coloured like the trails on the board. **🏠 Head home** shows the squares left and that it's safe there. **↻ Go round again** shows who it would capture on landing, or that it can be caught. It doesn't say how far the extra lap is; that risk is the player's to judge.
  - **Not now:** closes the sheet without moving, so you can pick another token or die.
  - **Tap the board:** the gold and blue markers at the end of each trail can be tapped to go that way without the sheet.

### Fixed
- **Oversized or broken requests get a proper error:** a request body over 4 KB now gets `413` and broken JSON `400` (as JSON the app understands). Before, Express answered with its own HTML error page, because the JSON parser sat outside the API's error handler.

### Tests
- **New unit tests:**
  - loading the config: the first-run copy of `config.example.json`, every environment override and invalid or broken files
  - the API's 413, 400 and 404 answers
  - how tokens stack on a square, including a second-lap token with a first-lap one, and tokens in base
  - the signal bars and ping labels
  - when "Update now" is offered
  - the macho stat and award
- **Coverage:** all tests together now cover 68% of statements. Most server and shared rules files are at 85–100%. Most of what's left is screen code, which the browser smoke tests cover instead.

## 2.1.1

### Fixed
- **"+ Bot" adds the bot on the seat you tapped.** It used to land on a random free seat: the message never said which seat, which went unnoticed until seat colours became random in 1.6.0.
- **A bot's name always matches its seat.** After swapping colours with a player it kept its old name ("Bot Red" on the green seat). Lobbies saved with a mismatched name are corrected when the server restarts.
- **The "home stretch or another lap?" confirm closes if the turn moves on** (for example when the timer plays it). Before, it stayed open and tapping it showed an error.

### Tests
- Added tests that check what the screen promises, not just each server function: "+ Bot" on a chosen seat, bot names after swaps and restarts, cancelling a swap request, and taking a seat back from the bot after missed turns.

## 2.1.0

### Added
- **Second lap:** a token about to turn into its home stretch on its first lap can go round the board once more instead.
  - **Choosing:** the board shows a branching path (a gold trail into the home stretch, a blue one round again with a ↻ marker). Tapping the token asks **🏠 Head home** or **↻ Go round again**.
  - **On the second lap:** the token moves, captures and can be captured like any other, wears a dashed white ring, and turns home at the end. It can only go round once.
  - **Bots and the timer's auto-play:** they head home, unless going round would capture someone.
  - **Enforced by the server:** older phones that don't send a choice always head home.

### Changed
- **The moustache grows sooner and with more punch:** it waits 2 seconds (was 3) once the token is still, then grows in over 1.4 seconds (was 2) with a big first pump up to twice its size before it settles.
- **"In danger" now counts second laps:** an opponent about to turn home can still threaten tokens past its turn, because it may go round again.

### Fixed
- **Stricter message checks:** the server's check of incoming messages no longer treats built-in object names (such as `toString`) as allowed fields.

## 2.0.1

### Changed
- **A longer pause before the moustache grows:** after a capture, once the token is still, it now waits 3 seconds (was 1) before the moustache grows.
- **The moustache grows slowly:** the old moustache fades out while the new one grows in over 2 seconds, swells slightly past its size and settles back, with a slow squash of the token. Before, it was a quick 0.7-second pop.
- **The moustache twitches more often:** the occasional idle flick comes 10% more often (every 3.3–5.5 s instead of 3.6–6 s). The flick itself is unchanged.
- **The moustache pumps when it twitches:** with each idle flick it puffs up, bounces once and settles (approved on the Moustache Twitch review page).

## 2.0.0

Version 2 brings together everything since 1.0: lobby voice chat that also works across mobile networks, the moustache and heavy-token effects, first blood, awards and match stats, colour swaps, signal and ping, and in-app updates.

### Changed
- **Update now is only available when there is an update:** while the phone already runs the server's version, the button is disabled and reads "✓ Up to date" ("Checking…" before the server has said which version it runs).
- **The moustache grows a moment later:** after a capture it waits until the token is still (its reaction face has ended and it isn't hopping), then pauses 1 second before growing, so nothing hides the growth. If another reaction starts during the pause, it waits again.

## 1.8.0

### Added
- **Voice through the game server:** when two phones can't connect directly (typically Jio mobile data against IPv4-only Wi-Fi), voice for that pair goes through the game server after 8 seconds, with about 0.2 s of extra delay.
  - **What it needs:** nothing on the router; it works anywhere the game works.
  - **The audio:** Opus at the lobby's quality setting, with its own limit so it can't trip the game's flood protection. Mute stops it.
  - **Lateness:** a backlog after a network stall is skipped, so delay stays short.
  - **Back to direct:** the direct link keeps retrying and takes over again once it connects.
- **Voice Details shows IPv4 and IPv6:** each phone's routes are split by IPv4 and IPv6. It says plainly when one phone can only be reached over IPv6 and the other only over IPv4, so a direct link is impossible.

### Changed
- **The Update app row sits in the bottom bar,** just above **Create lobby**.

## 1.7.0

### Added
- **Moustaches:** every capture grows the capturing token's moustache a level: a bold chevron, then a horseshoe, a handlebar, and a giant bushy imperial at 4 kills.
  - **Motion:** it twitches now and then, flaps with each hop, and pops up to the next size after a capture.
  - **Losing it:** a captured token goes home clean-shaven.
  - **Same on every phone:** the server counts kills per token, so every phone shows the same moustache.
- **Heavy tokens:** each kill makes a token hop more slowly and heavily: ×1.35, ×1.8, ×2.5, then ×3.5 at 4 kills.
  - **Hops:** heavier tokens crouch and squash more, hop lower, and jiggle to a stop.
  - **Board:** it shakes on their landings from the first kill, and dust flies from 2 kills.
  - **Timing:** bots and turn timers wait for the slower moves.

- **Update app:** a button on the home screen, under the lobbies, shows the app's version.
  - **When an update is ready:** after the server is updated, it highlights with "v… is ready" and **Update now**.
  - **What tapping it does:** the browser drops its saved copies of the game's files and deletes any offline caches, then the game reloads from the server and says which version it's on.
  - **What it keeps:** logins, device access and a game in progress.

### Changed
- **The main page is always checked with the server** (`Cache-Control: no-cache`), so a normal reload already picks up a new build. The built files keep their year-long caching, since their names change with every build.
- **Every token now hops with squash and stretch:** it crouches, springs up, lands with a squash and rebounds, rocking side to side. This replaces the old scale-up hop. One square's hop now takes 170 ms instead of 150 ms.

## 1.6.0

### Changed
- **Random colours in the lobby:** the host is no longer always red, and joiners no longer get the next colour in order. Everyone, and every bot, starts on a random free colour picked by the server with `crypto`.

### Added
- **Swap colours in the lobby:** tap **⇄ Swap** on another player's seat to ask them to trade colours, with no need to leave and rejoin.
  - **The prompt:** the other player sees who would become which colour, with a 20-second countdown, and can answer **Swap** or **No thanks**.
  - **The swap:** both colours change at once for everyone, and ready status is kept.
  - **Results:** the asker sees the result (swapped, declined, or no answer) and can cancel while waiting.
  - **Bots:** swapping with a bot happens immediately.
  - **Both asking:** two players asking each other just swap.
  - **Checked on the server:** a request is refused if either colour changed since it was made, and it ends if either player leaves, moves seat, or the game starts.

## 1.5.1

### Added
- **More token reactions:** there are four reactions for each moment, each a different face with its own animation. They're picked at random and never repeat back to back.
  - **Star squares:** 😌 😎 🥳 😇.
  - **Capturing:** 😋 🤤 😈 😏.
  - **Being captured** (new: the captured token now reacts on its way home): 😵 😭 😱 😖.
  - **In danger** (new): when an opponent gets 1–5 squares behind a token, the token reacts once: 🏃 😰 🥶. It isn't in danger on safe squares, in its home column, or when the opponent would turn off into its own home column first.
  - **Slower:** all reactions play 5% slower (1.7 s to 1.785 s).
- **No repeated faces:** every reaction face is used for only one moment. The "Most cells travelled" award is now 👣, so 🏃 only means running away.
- **Voice over cellular, using a TURN relay:** set `voice.turn` (relay URLs plus a shared secret, as used by coturn and most hosted relays) and the server gives each player a short-lived relay login when they join voice. The secret never reaches the phones. See README → Voice chat.
- **Late routes are passed on:** a phone's network routes found after its offer or answer went out (often relay routes on cellular) are now sent to the other phone in small batches, instead of being lost.
- **Voice "Details":** a button in the voice section on the lobby screen and in the game's ☰ menu.
  - **Per player:** the link's state and for how long, who calls whom, and the network routes each phone offered (local, hidden local, internet, relay).
  - **Explanation:** which route worked, and what is most likely wrong, in plain words.
  - **Copy report:** copies all of it for troubleshooting.

### Fixed
- **Voice signalling errors are no longer silent:** if the server refuses a voice offer or answer, the phone now marks that link failed and redials, instead of waiting forever.

## 1.5.0

### Added
- **First blood:** the game's first capture shows a **FIRST BLOOD** banner on every phone, showing who captured whom, with its own sound and vibration.
  - The server marks the capture, so it shows correctly even after a reconnect.
  - Bots and turn timers wait for the banner to finish.
- **End-of-game awards and stats:** the results screen now shows awards for most cells travelled, most tokens captured, most sixes, most revenges taken, and first blood (ties are shared).
  - It also has a stats table for every player, with the best in each column highlighted, and each player's award icons on the podium.
  - The server counts the stats as the game is played and saves them with the game.
  - A *revenge* is capturing a player who had captured you and whom you hadn't paid back yet.
  - The results screen now scrolls when the content is taller than the phone.
- **Wins in the lobby:** each player's lifetime wins (🏆) are shown beside their name and update as soon as a game ends.

## 1.4.1

### Changed
- **Dice-roll sound:** now built from wooden clacks that land closer together and quieter as the die settles, over a faint rolling rumble. The 1.4.0 version used pure tones, which sounded robotic.
  - The clacks are made from noise shaped by the resonances of wood, so they sound like a real die.
  - They stay clear of the harsh treble: about 5% of the energy is above 2 kHz, against 82% in the original sound.
- **Six-streak fire:**
  - It now burns along the floor under the dice queue, on the left, and fades out before the dice, instead of burning around the dice: warm amber on the first six, taller deeper orange on the second, like a classic fire.
  - It sits behind the dice and queue without catching taps, and only runs during a streak.
  - It's drawn as soft rising tongues with no bright dots or rings, and has its own palette for light mode.
- **The cube's glow is back to the colour of the player whose roll it is.** With the fire on the floor, the two can't be confused.

### Fixed
- **Lobby flicker:** since 1.4.0 the lobby rebuilt every seat card on each ping update (every 3 seconds) and each voice change. That replayed the cards' entrance animation and could swallow a tap on Ready, Sit here or Kick. Ping, signal bars and mic badges now update in place, and the cards animate in only once. The voice panel's buttons are rebuilt only when they actually change.
- **Game screen redraws:** the same kind of fix as the lobby, applied to the game screen.
  - **Queued dice:** dice already in the queue no longer pop in again on every update; only a newly rolled die does.
  - **Player cards:** built once. After that only the ping, signal bars, mic badge or status that actually changed is updated, and the turn-timer bar restarts only for a new turn, not every 3 seconds.
  - **Turn banner, hint and landing markers:** redrawn only when they change.

  Measured over a turn, queue pop animations went from 8 to 2, and banner rebuilds from 24 to 2. With two players idle for 10 seconds, the only changes left are the ping value and signal bars when they actually change. The results screen was already steady.

## 1.4.0

### Added
- **Signal bars and ping for every player:** shown on the lobby seats and the game's player cards. The server pings each phone in a lobby every 3 seconds, times the reply itself, smooths the result, and sends each lobby one update.

### Changed
- **Voice quality steps are now 6, 12, 24 and 48 kbps** (default 24). Browsers refuse to encode voice below 6 kbps, so 6 is the lowest possible. Before, the steps were 16, 32, 48 and 64.
- **Softer dice-roll sound:** warm wooden knocks that slow down as the die settles, replacing the bright noise bursts. Measured, the sound's brightness centre dropped from about 3.7 kHz to about 0.5 kHz.
- **Six-streak flames:**
  - They are now violet for the first six and fuchsia for the second, so they can't be mistaken for a player's colour. While a streak burns, the cube's "your roll" glow takes the flame's colour too.
  - The flame is drawn as soft particles that rise, drift inward and fade, so it flickers like a real flame. It's kept subtle.

## 1.3.0

### Added
- **Admins can close lobbies:** the admin panel has a new **Lobbies** tab that lists open lobbies and their players. **Close lobby** works even mid‑game. Everyone in it goes home with "An admin closed the lobby", and a game in progress ends without counting.
- **Change your own name:** tap your name or avatar on the home screen. Lobbies and games in progress show the new name right away.
- **Install app:** a button on the splash screen and in the home screen's ⋯ menu, when the browser offers it. The installed app opens fullscreen without the browser's "swipe to exit full screen" bubble, which a web page can't hide. It needs a trusted certificate.

### Fixed
- **The keyboard no longer covers text fields:** this covers the access code, sign‑up, create lobby, join lobby, rename and admin forms.
  - **Android:** the page shrinks above the keyboard.
  - **iPhone and other browsers:** the app and its dialogs are fitted to the area above the keyboard.

  In both cases the field you're typing in scrolls into view.
- **No false "Turn your phone upright":** typing on an upright phone, for example the lobby password, no longer brings up the overlay. It now checks how the phone is actually held, and never shows while you're typing. Before, the keyboard made the page wider than tall, which looked like a phone held sideways.

## 1.2.0

### Fixed
- **Voice after a lost connection:** after a dropped connection, some players could go silent for others. Two causes:
  - A phone's microphone could stop, which iOS does when the phone is locked or another app is opened. That player still showed as unmuted but sent nothing.
  - A connection that broke on one side was never redialled.

  Each phone now runs a watchdog that redials broken or stuck links and gets a fresh microphone when needed. Only one phone of each pair dials (the lower user id; the other "rings"), so phones reconnecting together can't cross their calls.
- **Blocked playback:** incoming voice that the browser refused to play starts on the next tap.
- **Bluetooth earphones:** connecting or removing Bluetooth or wired earphones during a call now moves voice to them, or back to the phone. Before, the audio stayed on whatever was in use when you joined.

### Added
- **Rejoin voice** button for everyone, on the lobby screen and in the game menu, with a status line such as "Talking with all 3 players".
- **Host voice controls:**
  - **Restart for everyone** rebuilds every phone's voice connections.
  - **Turn off / Turn on** switches voice chat off or on for the whole lobby.

### Changed
- **Voice quality:** only the lobby host can change it. Other players see it locked.

## 1.1.0

### Added
- **Voice chat for each lobby:** everyone in a lobby joins it automatically and stays connected through matches and results.
  - A mute-myself button is on the lobby, game and home screens.
  - Mic badges next to names show who is live, muted or still connecting.
  - Voice quality is 16, 32, 48 or 64 kbps. Any player can change it, and it applies to everyone.
  - Players with a blocked microphone join listen-only.
  - Audio goes directly between phones (WebRTC). STUN and TURN servers are set in `voice.iceServers`.
- **Fullscreen button on the game screen**, alongside the one on the home screen.
- **Effects:**
  - The first six puts a blue flame on the dice and the second a red-yellow flame, each with its own sound.
  - Three sixes show a sad 😩 with a sad trombone.
  - A token landing on a star square chimes and briefly turns into 😌 or 😎.
  - A capturing token briefly turns into 😋 or 🤤 with a slurp.
- **Clearer next move:** the die your next tap will use is lifted, outlined in your colour and tagged **USE**. Dice that can't move anything are greyed out, and the board marks where each glowing token would land.
- **Version number** on the splash screen and in the server's startup message.

### Changed
- **Bonus roll on reaching home:** a token reaching home earns a bonus roll, like a capture. A player's last token doesn't, because that player has finished.
- **A useless six ends the turn:** when all of a player's remaining tokens are in the home lane, a 6 can't be used. It now ends the turn instead of giving another roll.
- **Dice theme:** a light cube with a glow in dark mode, and a dark cube with a shadow in light mode. The cube's edges are now solid, and the "your roll" glow follows the cube's shape instead of a square box.

## 1.0.0

First release:
- realtime multiplayer Ludo for phones in portrait
- HTTPS
- the access-code gate
- accounts without passwords
- admin panel
- password-protected lobbies
- bots
- reconnecting and resuming games
- dice rolled on the server with `crypto`
- the queued-sixes penalty
- `setup.sh`

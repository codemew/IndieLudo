# Changelog

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

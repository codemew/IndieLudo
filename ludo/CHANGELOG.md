# Changelog

## 1.2.0

### Fixed
- **Voice after a lost connection:** after a dropped connection, some players could go silent for others. Two causes:
  - A phone's microphone could stop, which iOS does when the phone is locked or another app is opened. That player still showed as unmuted but sent nothing.
  - A connection that broke on one side was never redialled.

  Each phone now runs a watchdog that redials broken or stuck links and gets a fresh microphone when needed. Only one phone of each pair dials (the lower user id; the other "rings"), so phones reconnecting together can't cross their calls.
- **Blocked playback:** incoming voice that the browser refused to play starts on the next tap.

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

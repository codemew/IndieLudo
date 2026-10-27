# Changelog

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

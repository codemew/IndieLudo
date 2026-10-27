import { resyncGame } from './app.js';
import { installInstallPrompt } from './install.js';
import { installKeyboardAvoidance } from './keyboard.js';
import { installNetworkListeners } from './net.js';
import { register, go } from './router.js';
import { adminScreen } from './screens/admin.js';
import { gameScreen } from './screens/game.js';
import { gateScreen } from './screens/gate.js';
import { homeScreen } from './screens/home.js';
import { lobbyScreen } from './screens/lobby.js';
import { offlineScreen } from './screens/offline.js';
import { resultsScreen } from './screens/results.js';
import { signupScreen } from './screens/signup.js';
import { splashScreen } from './screens/splash.js';
import { installUnlockListeners } from './sound.js';
import { installWakeLock } from './wakelock.js';

register('splash', splashScreen);
register('offline', offlineScreen);
register('gate', gateScreen);
register('signup', signupScreen);
register('home', homeScreen);
register('lobby', lobbyScreen);
register('game', gameScreen);
register('results', resultsScreen);
register('admin', adminScreen);

installUnlockListeners();
installWakeLock();
installKeyboardAvoidance();
installInstallPrompt();
installNetworkListeners(() => void resyncGame());

// Block pinch/double-tap zoom gestures that slip past the viewport meta on iOS.
document.addEventListener('gesturestart', (e) => e.preventDefault());

go('splash');

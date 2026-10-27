import { networkInterfaces } from 'node:os';

const ips = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
console.log(`Warning-free HTTPS with mkcert (https://github.com/FiloSottile/mkcert):

  1. Install mkcert, then create a local CA:
       mkcert -install
  2. Create a certificate for this machine:
       mkdir -p data/certs && mkcert -cert-file data/certs/ludo.pem -key-file data/certs/ludo-key.pem localhost 127.0.0.1 ${ips.join(' ')}
  3. In config.json set:
       "https": { "certPath": "./data/certs/ludo.pem", "keyPath": "./data/certs/ludo-key.pem", ... }
  4. Install the root CA on each phone (once). Find it with:
       mkcert -CAROOT
     Android: Settings → Security → Install certificate → CA certificate (rootCA.pem)
     iOS: AirDrop rootCA.pem, install the profile, then enable it in
          Settings → General → About → Certificate Trust Settings.
`);

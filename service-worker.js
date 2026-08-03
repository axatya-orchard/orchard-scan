/* ORCHARD-SCAN — service worker.

   Deux exigences se croisent ici :

   1. L'application doit démarrer en mode avion, batterie faible, sans réseau.
   2. Une des photos d'écorce sera remplacée sous huit jours, et il doit
      suffire d'écraser le fichier dans assets/ pour que la nouvelle image
      apparaisse — sans toucher au code ni à ce fichier (§1).

   D'où la stratégie retenue : réseau d'abord, cache en secours, avec une
   course contre la montre. Hors ligne, fetch échoue immédiatement et le cache
   répond sans délai perceptible. En ligne, la requête part avec les en-têtes
   HTTP normaux : GitHub Pages renvoie un 304 si le fichier n'a pas bougé, et
   le contenu complet s'il a été écrasé. Aucune purge manuelle n'est requise.

   Une stratégie « cache d'abord » aurait servi l'ancienne image indéfiniment ;
   une stratégie « revalidation en arrière-plan » l'aurait servie encore une
   fois de plus. Ni l'une ni l'autre ne passe le test d'acceptation n° 7. */

const CACHE = 'orchard-scan-v1';
const NET_TIMEOUT_MS = 2500;

const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './strings.json',
  './manifest.json',
  './rangs_registry_v2.csv',
  './assets/ecorce_0_lisse.jpg',
  './assets/ecorce_1_quelques_bosses.jpg',
  './assets/ecorce_2_couverte.jpg',
  './assets/ecorce_3_trou.jpg',
  './assets/discrimination_bosse_vs_plaie.jpg',
  './assets/discrimination_blanc_oidium_vs_puceron.jpg',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE)
      /* Un asset manquant ne doit pas faire échouer toute l'installation :
         mieux vaut une application installée à laquelle il manque une photo
         qu'une application qui refuse de s'installer. */
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fromNetwork(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    fetch(request).then(
      res => { clearTimeout(timer); resolve(res); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

async function networkFirst(request) {
  try {
    const res = await fromNetwork(request, NET_TIMEOUT_MS);
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(request, copy)).catch(() => { /* quota */ });
    }
    return res;
  } catch (e) {
    const hit = await caches.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw e;
  }
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // rien d'externe à servir

  ev.respondWith(networkFirst(req));
});

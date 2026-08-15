/* ORCHARD-SCAN — relevé arboricole hors ligne.
   Vanilla JS, aucune dépendance, aucun build.

   Ordre des sections :
     1. Constantes et correspondances code/libellé
     2. Utilitaires
     3. Préférences (localStorage)
     4. Internationalisation
     5. IndexedDB — couche 1 de persistance
     6. Registre des rangs
     7. Export CSV — couches 2 et 3 de persistance
     8. État de session
     9. Écrans
    10. Contrôle qualité
    11. Démarrage

   Règle tenue partout : une valeur tapée est écrite sur disque avant que
   la fonction ne rende la main. Rien n'est différé en fin d'arbre. */
'use strict';

/* ===================================================================
   1. CONSTANTES
   =================================================================== */

const APP_VERSION = '1.3.0';
const DB_NAME = 'orchard-scan';
const DB_VER = 2;
const REGISTRY_URL = 'rangs_registry_v2.csv';
const EXPORT_ALERT_MIN = 45;   // §2.2
const FAST_ENTRY_S = 4;        // §8 flag_qc RAPIDE
const MONOTONY_N = 15;         // §11
const RECONTROLE_N = 30;       // §11
const RECONTROLE_MIN_RATE = 80;
const VOICE_MAX_S = 30;
const DEMO_TERRAIN = 'TD';     // le jeu de démonstration ne touche jamais T1/T2/T3

/* La passe identifie la CAMPAGNE, pas la révision d'une correction.
   Elle est fixe du 8 au 25 août 2026 et ne bouge jamais : c'est elle qui
   permettra, en 2027, de comparer le même arbre d'une année sur l'autre —
   l'identifiant étant positionnel et immuable (§4.2).
   Le numéro de révision d'une correction, lui, est porté par `version`,
   qui s'incrémente à chaque nouvelle saisie sur la même position.
   Le recontrôle est une passe distincte par définition (§4.3) : sans cela
   ses lignes entreraient en collision avec les originales lors de la fusion,
   qui déduplique sur arbre_id + passe, et l'une des deux serait écartée. */
const CAMPAGNE = 'ETE_2026';
const CAMPAGNE_RECONTROLE = CAMPAGNE + '_RECONTROLE';
const CAMPAGNE_ENTRAINEMENT = CAMPAGNE + '_ENTRAINEMENT';

/* Entraînement d'un nouvel opérateur : il refait les 4 premiers rangs déjà
   relevés par quelqu'un d'expérimenté, à l'aveugle, et on compare. */
const ENTRAINEMENT_RANGS = 4;
const ENTRAINEMENT_SEUIL = 80;   // en dessous, la variable est à retravailler

/* Double colonne : code ordinal pour calculer, libellé pour relire (§8).
   Les libellés d'export sont en français canonique quelle que soit la langue
   de saisie — deux appareils réglés différemment doivent produire le même
   fichier. La langue de l'opérateur est tracée par la colonne langue_saisie. */
const MAP = {
  etat: {
    MORT:   { code: 0, label: 'MORT' },
    VIVANT: { code: 1, label: 'VIVANT' },
    VIDE:   { code: 2, label: 'VIDE' },
    RECEPE: { code: 3, label: 'REPOUSSE DU PIED' },
    AUTRE:  { code: 4, label: 'AUTRE' }
  },
  tronc: {
    F: { code: 0, label: 'FIN' },
    M: { code: 1, label: 'MOYEN' },
    G: { code: 2, label: 'GROS' }
  },
  arch: {
    A: { code: 0, label: 'A' },
    B: { code: 1, label: 'B' },
    C: { code: 2, label: 'C' }
  },
  fruits: {
    '0': { code: 0, label: '0' },
    '1': { code: 1, label: '1-5' },
    '2': { code: 2, label: '6-15' },
    '3': { code: 3, label: '15+' }
  },
  fruits_bin: {
    NON: { code: 0, label: 'AUCUN' },
    OUI: { code: 1, label: 'PRESENTS' }
  },
  couleur: {
    V: { code: 0, label: 'VERTES' },
    J: { code: 1, label: 'JAUNES' },
    R: { code: 2, label: 'ROUGES' }
  },
  pourri: {
    NON: { code: 0, label: 'NON' },
    OUI: { code: 1, label: 'OUI' }
  },
  ecorce: {
    '0': { code: 0, label: 'LISSE' },
    '1': { code: 1, label: 'QUELQUES BOSSES' },
    '2': { code: 2, label: 'COUVERTE DE BOSSES' },
    '3': { code: 3, label: 'TROU, ÉCORCE PARTIE' }
  },
  autre_type: {
    POIRIER:   'POIRIER',
    REPLANT:   'JEUNE ARBRE REPLANTÉ',
    SAUVAGEON: 'REPOUSSE SAUVAGE',
    SOUCHE:    'SOUCHE MORTE',
    AUTRE_ESP: 'AUTRE ESPÈCE'
  },
  espece: {
    POMMIER: 'POMMIER',
    POIRIER: 'POIRIER',
    AUTRE:   'AUTRE ESPÈCE'
  }
};

/* Les états qui font sauter tous les blocs suivants (§5.4). */
const ETAT_TERMINAL = ['MORT', 'VIDE', 'AUTRE'];

/* Ordre des colonnes de l'export. Les 32 premières sont celles du §8,
   dans l'ordre exact. Les trois dernières sont des ajouts traçants. */
const COLS = [
  'arbre_id', 'terrain', 'rang', 'position', 'hors_plan', 'rang_statut',
  'etat_code', 'etat_label', 'autre_type', 'autre_fruit', 'espece',
  'tronc_code', 'tronc_label',
  'arch_code', 'arch_label',
  'fruits_code', 'fruits_label', 'charge_mode',
  'couleur_code', 'couleur_label',
  'pourri_code', 'pourri_label',
  'ecorce_code', 'ecorce_label',
  'arbre_complet', 'duree_saisie_s', 'flag_qc',
  'horodatage_iso', 'operateur_label', 'device_id', 'app_version', 'passe', 'langue_saisie',
  'version', 'source', 'media_ref'
];

/* ===================================================================
   2. UTILITAIRES
   =================================================================== */

const $ = (id) => document.getElementById(id);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function pad(n, w) { return String(n).padStart(w, '0'); }

function uid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function nowIso() { return new Date().toISOString(); }

/* Horodatage local compact pour les noms de fichier : 20260808_1432. */
function stampLocal(d) {
  d = d || new Date();
  return String(d.getFullYear()) + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2)
    + '_' + pad(d.getHours(), 2) + pad(d.getMinutes(), 2);
}

/* Translittération cyrillique → latin. Le prénom entre dans le nom des
   fichiers déposés (T1_R07_ZURAB_….csv) : le laisser en cyrillique donnerait
   des noms illisibles ou tronqués au passage sur un poste Windows, alors que
   le nommage doit rester strict. Sans cette table, un prénom entièrement en
   cyrillique était réduit à une chaîne vide et le bouton ENREGISTRER restait
   gris — l'opérateur ne pouvait pas démarrer. */
const TRANSLIT_CYR = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'E', Ж: 'ZH', З: 'Z',
  И: 'I', Й: 'Y', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P', Р: 'R',
  С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'KH', Ц: 'TS', Ч: 'CH', Ш: 'SH',
  Щ: 'SHCH', Ъ: '', Ы: 'Y', Ь: '', Э: 'E', Ю: 'YU', Я: 'YA'
};

/* Normalisation du prénom : majuscules, accents retirés, espaces coupés (§5.1).
   « Axatya » et « axatia » restent deux étiquettes différentes, mais c'est le
   device_id qui identifie réellement l'opérateur dans l'export. */
function normName(s) {
  const majuscules = String(s || '').toUpperCase();
  let latin = '';
  for (const c of majuscules) latin += (c in TRANSLIT_CYR) ? TRANSLIT_CYR[c] : c;
  return latin
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, '_');
}

function buzz() { if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) { /* sans effet */ } } }

function minutesSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
}

function arbreId(terrain, rang, position) {
  return terrain + '-R' + pad(rang, 2) + '-' + pad(position, 3);
}

function rangKey(terrain, rang) { return terrain + '-R' + pad(rang, 2); }

/* ===================================================================
   3. PRÉFÉRENCES — localStorage, uniquement (§1)
   =================================================================== */

const PREF = {
  get lang() { return localStorage.getItem('os_lang') || 'FR'; },
  set lang(v) { localStorage.setItem('os_lang', v); },
  get operateur() { return localStorage.getItem('os_operateur') || ''; },
  set operateur(v) { localStorage.setItem('os_operateur', v); },
  get deviceId() {
    let d = localStorage.getItem('os_device_id');
    if (!d) {
      d = 'D' + Math.random().toString(36).slice(2, 7).toUpperCase();
      localStorage.setItem('os_device_id', d);
    }
    return d;
  }
};

/* ===================================================================
   4. INTERNATIONALISATION (§3)
   =================================================================== */

let STR = {};
let LANG = PREF.lang;

async function loadStrings() {
  const r = await fetch('strings.json', { cache: 'no-cache' });
  STR = await r.json();
}

/* t('cle', {n: 3}) — jamais de chaîne en dur ailleurs que dans strings.json. */
function t(key, vars) {
  const e = STR[key];
  let s = e ? (e[LANG.toLowerCase()] || e.fr) : ('?' + key + '?');
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}

function setLang(l) {
  LANG = l;
  PREF.lang = l;
  document.documentElement.lang = l.toLowerCase();
  applyStatic();
  markGroup('lang', l);
  renderDynamic();
}

/* Remplit tous les [data-i18n] et [data-i18n-ph]. */
function applyStatic() {
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  $$('[data-fitted]').forEach(el => { delete el.dataset.fitted; });
  fitAll();
}

/* La mise en page ne bouge pas entre les langues : les boutons gardent leurs
   dimensions, c'est la police qui se réduit jusqu'à ce que le texte entre (§3). */
function overflows(el) {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

function fitButton(b) {
  if (!b.dataset.fs) b.dataset.fs = String(parseFloat(getComputedStyle(b).fontSize));
  const base = parseFloat(b.dataset.fs);
  const sub = b.querySelector('.s');
  if (sub && !sub.dataset.fs) sub.dataset.fs = String(parseFloat(getComputedStyle(sub).fontSize));
  const subBase = sub ? parseFloat(sub.dataset.fs) : 0;

  b.style.fontSize = base + 'px';
  if (sub) sub.style.fontSize = subBase + 'px';

  let size = base, guard = 0;
  while (overflows(b) && size > 9 && guard++ < 60) {
    size -= 0.5;
    b.style.fontSize = size + 'px';
    if (sub) sub.style.fontSize = Math.max(8, subBase * (size / base)) + 'px';
  }
}

function fitAll(root) {
  $$('button', root || document).forEach(b => {
    if (b.offsetParent === null) return;   // écran caché : mesure impossible
    fitButton(b);
  });
}

/* Un bloc conditionnel n'est mesurable qu'une fois visible. On l'ajuste à sa
   première apparition seulement : refaire le calcul à chaque tap coûterait
   une lecture de mise en page par bouton, et la latence perçue est
   l'ennemi (§10.7). Le drapeau est effacé au changement de langue. */
function revealFit(container) {
  if (!container || container.classList.contains('hidden')) return;
  if (container.dataset.fitted) return;
  fitAll(container);
  container.dataset.fitted = '1';
}

/* ===================================================================
   5. INDEXEDDB — COUCHE 1 (§2.1)
   =================================================================== */

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = (ev) => {
      const d = ev.target.result;
      if (!d.objectStoreNames.contains('rangs')) {
        d.createObjectStore('rangs', { keyPath: 'key' }).createIndex('terrain', 'terrain');
      }
      if (!d.objectStoreNames.contains('observations')) {
        const os = d.createObjectStore('observations', { keyPath: 'obs_id' });
        os.createIndex('arbre_id', 'arbre_id');
        os.createIndex('rang_key', 'rang_key');
        os.createIndex('source', 'source');
      }
      if (!d.objectStoreNames.contains('medias')) {
        d.createObjectStore('medias', { keyPath: 'media_id' });
      }
      if (!d.objectStoreNames.contains('meta')) {
        d.createObjectStore('meta', { keyPath: 'k' });
      }
      /* Les relevés de référence importés vivent dans leur propre magasin,
         jamais dans `observations` : c'est ce qui garantit qu'ils ne peuvent
         pas ressortir dans un export et être recomptés comme du travail de
         cet appareil. Ils servent de corrigé, rien d'autre. */
      if (!d.objectStoreNames.contains('reference')) {
        d.createObjectStore('reference', { keyPath: 'arbre_id' })
          .createIndex('rang_key', 'rang_key');
      }
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

function idbReq(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const rq = fn(tx.objectStore(store));
    tx.onabort = tx.onerror = () => reject(tx.error);
    if (rq) rq.onsuccess = () => resolve(rq.result);
    else tx.oncomplete = () => resolve();
  });
}

const dbPut = (store, val) => idbReq(store, 'readwrite', s => s.put(val));
const dbGet = (store, key) => idbReq(store, 'readonly', s => s.get(key));
const dbAll = (store) => idbReq(store, 'readonly', s => s.getAll());
const dbDel = (store, key) => idbReq(store, 'readwrite', s => s.delete(key));
const dbIndexAll = (store, index, key) =>
  idbReq(store, 'readonly', s => s.index(index).getAll(key));

/* Les toutes premières versions écrivaient passe = 1 (saisie) et 2 (recontrôle).
   Ces lignes deviendraient des passes distinctes de ETE_2026 à la fusion, et
   des données d'essai se retrouveraient comptées comme des relevés réels.
   La migration les normalise une fois pour toutes. Elle est idempotente. */
async function migrerPasseNumerique() {
  if (await metaGet('migration_passe_campagne', false)) return 0;
  const obs = await dbAll('observations');
  let n = 0;
  for (const o of obs) {
    if (typeof o.passe === 'number') {
      o.passe = o.passe === 2 ? CAMPAGNE_RECONTROLE : CAMPAGNE;
      await dbPut('observations', o);
      n++;
    }
  }
  await metaSet('migration_passe_campagne', true);
  return n;
}

/* Remise à zéro avant le premier jour de campagne.
   Les essais se font sur de vrais numéros de rang : sans cela, T1-R01 resterait
   marqué COMPLET et l'application le sauterait le 8 août. Détruit tout ce qui
   a été saisi et rend au registre ses comptes d'origine. */
async function reinitialiserCampagne() {
  for (const o of await dbAll('observations')) await dbDel('observations', o.obs_id);
  for (const m of await dbAll('medias')) await dbDel('medias', m.media_id);
  for (const r of await dbAll('rangs')) await dbDel('rangs', r.key);
  await metaSet('session', null);
  await metaSet('dernier_export', null);
  await metaSet('registry_loaded', false);
  await loadRegistry();
  session = null;
  await refreshCounts();
}

async function metaGet(k, dflt) {
  const r = await dbGet('meta', k);
  return r === undefined ? dflt : r.v;
}
const metaSet = (k, v) => dbPut('meta', { k: k, v: v });

/* --- Stockage permanent (§2.1) --------------------------------------- */

let persistGranted = false;

async function askPersist() {
  try {
    if (navigator.storage && navigator.storage.persisted) {
      persistGranted = await navigator.storage.persisted();
      if (!persistGranted && navigator.storage.persist) {
        persistGranted = await navigator.storage.persist();
      }
    }
  } catch (e) {
    persistGranted = false;
  }
  await metaSet('persist_granted', persistGranted);
  $('pbanner').classList.toggle('hidden', persistGranted);
  refreshGates();
  return persistGranted;
}

/* Tant que la persistance est refusée, aucune session ne démarre (§2.1). */
function refreshGates() {
  const lock = !persistGranted;
  ['gosetup', 'resumebtn', 'm-start', 't3go', 'btn-reco'].forEach(id => {
    const el = $(id);
    if (el) el.disabled = lock;
  });
}

/* ===================================================================
   6. REGISTRE DES RANGS (§4.1)
   =================================================================== */

/* Deux fichiers entrent dans l'application, avec des séparateurs différents :
   rangs_registry_v2.csv est en virgule (§4.1), un export réimporté comme
   corrigé d'entraînement est en point-virgule. Le BOM et la directive sep=
   sont avalés dans les deux cas. */
function parseCsvDelim(text, sep) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nettes = rows.filter(r => r.length > 1 || (r[0] || '').trim() !== '');
  if (nettes.length && /^sep=/i.test((nettes[0][0] || '').trim())) nettes.shift();
  return nettes;
}

const parseCsvComma = (text) => parseCsvDelim(text, ',');

async function loadRegistry() {
  const already = await metaGet('registry_loaded', false);
  if (already) return;
  const res = await fetch(REGISTRY_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error('registry');
  const rows = parseCsvComma(await res.text());
  const head = rows[0].map(h => h.trim());
  const idx = {};
  head.forEach((h, i) => { idx[h] = i; });

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const terrain = (r[idx.terrain] || '').trim();
    if (!terrain) continue;
    const rang = parseInt(r[idx.rang], 10);
    const attendues = (r[idx.positions_attendues] || '').trim();
    await dbPut('rangs', {
      key: rangKey(terrain, rang),
      terrain: terrain,
      rang: rang,
      positions_attendues: attendues === '' ? null : parseInt(attendues, 10),
      longueur_m: parseFloat(r[idx.longueur_m]) || null,
      espacement_m: parseFloat(r[idx.espacement_m]) || null,
      porte_greffe: (r[idx.porte_greffe] || '').trim(),
      origine_position_1: (r[idx.origine_position_1] || '').trim(),
      a_verifier: (r[idx.a_verifier] || '').trim().toUpperCase() === 'OUI',
      statut: 'NEUF',
      positions_reelles: null,
      derniere_position: 0
    });
  }
  await metaSet('registry_loaded', true);
}

async function rangsOf(terrain) {
  const all = await dbIndexAll('rangs', 'terrain', terrain);
  return all.sort((a, b) => a.rang - b.rang);
}

/* L'application assigne, l'opérateur ne choisit pas (§5.3).
   Un rang PARTIEL est reproposé en priorité, à la position où il s'est arrêté. */
async function nextRang(terrain) {
  const all = await rangsOf(terrain);
  return all.find(r => r.statut === 'PARTIEL')
    || all.find(r => r.statut === 'EN_COURS')
    || all.find(r => r.statut === 'NEUF')
    || null;
}

/* ===================================================================
   7. EXPORT CSV (§8) — COUCHES 2 ET 3
   =================================================================== */

const NULLV = 'NULL';   // NULL explicite, jamais de zéro par défaut (§8)

function csvCell(v) {
  if (v === null || v === undefined || v === '') return NULLV;
  const s = String(v);
  if (/[;"\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function pair(mapName, value) {
  if (value === null || value === undefined || value === '') return [NULLV, NULLV];
  const e = MAP[mapName][value];
  if (!e) return [NULLV, NULLV];
  return [e.code, e.label];
}

function obsToRow(o, rangStatut) {
  const [etatC, etatL] = pair('etat', o.etat);
  const [troncC, troncL] = pair('tronc', o.tronc);
  const [archC, archL] = pair('arch', o.arch);
  const fruitsPair = o.charge_mode === 'BINAIRE'
    ? pair('fruits_bin', o.fruits_bin)
    : pair('fruits', o.fruits);
  const [coulC, coulL] = pair('couleur', o.couleur);
  const [pourC, pourL] = pair('pourri', o.pourri);
  const [ecoC, ecoL] = pair('ecorce', o.ecorce);

  const rec = {
    arbre_id: o.arbre_id,
    terrain: o.terrain,
    rang: o.rang,
    position: o.position,
    hors_plan: o.hors_plan,
    rang_statut: rangStatut,
    etat_code: etatC, etat_label: etatL,
    autre_type: o.autre_type ? MAP.autre_type[o.autre_type] : null,
    autre_fruit: o.autre_fruit,
    espece: o.espece ? MAP.espece[o.espece] : null,
    tronc_code: troncC, tronc_label: troncL,
    arch_code: archC, arch_label: archL,
    fruits_code: fruitsPair[0], fruits_label: fruitsPair[1],
    charge_mode: o.charge_mode,
    couleur_code: coulC, couleur_label: coulL,
    pourri_code: pourC, pourri_label: pourL,
    ecorce_code: ecoC, ecorce_label: ecoL,
    arbre_complet: o.arbre_complet,
    duree_saisie_s: o.duree_saisie_s,
    flag_qc: o.flag_qc,
    horodatage_iso: o.horodatage_iso,
    operateur_label: o.operateur_label,
    device_id: o.device_id,
    app_version: o.app_version,
    passe: o.passe,
    langue_saisie: o.langue_saisie,
    version: o.version,
    source: o.source,
    media_ref: o.media_ref
  };
  /* Valeurs brutes : l'échappement et l'assemblage appartiennent à
     csvDocument, qui est le seul à savoir écrire un CSV. */
  return COLS.map(c => rec[c]);
}

/* Le fichier commence par le BOM, puis « sep=; », puis les en-têtes.
   Ces deux premiers octets/lignes sont ce qui fait qu'Excel ouvre le fichier
   correctement au double-clic, quelle que soit la locale du poste (§8). */
const CSV_SEP = ';';
const CSV_EOL = '\r\n';
const CSV_DIRECTIVE = 'sep=' + CSV_SEP;

/* POINT UNIQUE DE GÉNÉRATION DE CSV.
   Aucune autre fonction n'a le droit d'assembler un CSV : export de rang,
   export complet, presse-papier et index des photos passent tous par ici.
   Un seul endroit produit le BOM, la directive et les fins de ligne, donc
   un seul endroit peut se tromper — et il est vérifié à l'exécution par
   verifierFormatExport(). */
function csvDocument(colonnes, lignesDeCellules) {
  const out = [CSV_DIRECTIVE, colonnes.join(CSV_SEP)];
  for (const cells of lignesDeCellules) out.push(cells.map(csvCell).join(CSV_SEP));
  return '﻿' + out.join(CSV_EOL) + CSV_EOL;
}

function buildCsv(observations, statutByRang) {
  return csvDocument(COLS, observations.map(
    o => obsToRow(o, statutByRang[o.rang_key] || 'EN_COURS')));
}

/* Auto-contr\u00F4le du format, ex\u00E9cutable depuis \u00C9TAT DES DONN\u00C9ES.
   Reproduit les deux tests d'acceptation du \u00A712.1 sur les octets r\u00E9ellement
   produits : le BOM qui prot\u00E8ge les accents, et la directive qui force le
   d\u00E9coupage en colonnes quelle que soit la locale. Si l'un des deux tombe,
   l'export n'existe plus, et il vaut mieux le savoir au bureau qu'au champ. */
async function verifierFormatExport() {
  const echantillon = csvDocument(
    ['a', 'b'],
    [['\u00C9CORCE', 'TROU, \u00C9CORCE PARTIE'], [0, null], ['a;b', 'x']]
  );
  const octets = new Uint8Array(await new Blob([echantillon]).arrayBuffer());
  const lignes = echantillon.split(CSV_EOL);

  /* Un \u00C8 correctement encod\u00E9 vaut C3 88. Doublement encod\u00E9 il devient
     C3 83 (\u00C3) suivi d'autre chose : c'est la signature d'un fichier relu
     en latin-1 puis r\u00E9\u00E9crit en UTF-8. On cherche donc l'un et pas l'autre. */
  const paire = (a, b) => {
    for (let i = 0; i < octets.length - 1; i++) {
      if (octets[i] === a && octets[i + 1] === b) return true;
    }
    return false;
  };

  const controles = [
    ['BOM UTF-8', octets[0] === 0xEF && octets[1] === 0xBB && octets[2] === 0xBF],
    ['directive sep=;', lignes[0].replace('\uFEFF', '') === CSV_DIRECTIVE],
    ['s\u00E9parateur point-virgule', lignes[1] === 'a;b'],
    ['aucune virgule s\u00E9paratrice', !lignes[1].includes(',')],
    ['fins de ligne CRLF', echantillon.endsWith(CSV_EOL) && !/[^\r]\n/.test(echantillon)],
    ['accents encod\u00E9s une seule fois', paire(0xC3, 0x89) && !paire(0xC3, 0x83)],
    ['virgule laiss\u00E9e telle quelle', lignes[2] === '\u00C9CORCE;TROU, \u00C9CORCE PARTIE'],
    ['z\u00E9ro conserv\u00E9, vide en NULL', lignes[3] === '0;NULL'],
    ['point-virgule interne \u00E9chapp\u00E9', lignes[4] === '"a;b";x']
  ];
  return { ok: controles.every(c => c[1]), controles: controles };
}

async function statutMap() {
  const all = await dbAll('rangs');
  const m = {};
  all.forEach(r => { m[r.key] = (r.statut === 'NEUF' ? 'EN_COURS' : r.statut); });
  return m;
}

function download(filename, text, mime) {
  try {
    const blob = new Blob([text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  } catch (e) {
    return false;
  }
}

function downloadBlob(filename, blob) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  } catch (e) {
    return false;
  }
}

async function markExported() {
  await metaSet('dernier_export', nowIso());
  paintSaveBar();
}

/* Couche 2 — dépôt automatique en fin de rang (§2.1).
   Nommage strict : T1_R07_AXATYA_20260808_1432.csv */
async function exportRang(terrain, rang) {
  const key = rangKey(terrain, rang);
  const obs = (await dbIndexAll('observations', 'rang_key', key))
    .sort((a, b) => a.position - b.position || a.version - b.version);
  const csv = buildCsv(obs, await statutMap());
  const name = terrain + '_R' + pad(rang, 2) + '_' + (PREF.operateur || PREF.deviceId)
    + '_' + stampLocal() + '.csv';
  const ok = download(name, csv);
  if (ok) await markExported();
  return { ok: ok, name: name };
}

/* Couche 3 — export manuel complet (§2.1). */
async function exportAll() {
  const obs = (await dbAll('observations'))
    .sort((a, b) => (a.terrain + a.rang_key).localeCompare(b.terrain + b.rang_key)
      || a.position - b.position || a.version - b.version);
  const csv = buildCsv(obs, await statutMap());
  const name = 'ORCHARD_TOUT_' + (PREF.operateur || PREF.deviceId) + '_' + stampLocal() + '.csv';
  const ok = download(name, csv);
  if (ok) await markExported();
  return { ok: ok, name: name, rows: obs.length, csv: csv };
}

/* ===================================================================
   8. ÉTAT DE SESSION
   =================================================================== */

let session = null;     // persisté dans meta.session à chaque tap
let S = {};             // réponses de l'arbre affiché
let curObsId = null;    // enregistrement en cours (créé au premier tap)
let curIsNewTree = false; // la position n'avait encore aucune observation
let baseVersion = 0;    // version de départ ; une correction crée base+1
let t0 = Date.now();
let wakeLock = null;
let recoState = null;   // mode recontrôle

async function saveSession() {
  await metaSet('session', session);
}

async function wakeOn() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* refusé : sans effet sur la saisie */ }
}
function wakeOff() {
  if (wakeLock) { try { wakeLock.release(); } catch (e) { /* déjà relâché */ } wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session) wakeOn();
});

/* --- construction et écriture d'une observation ---------------------- */

function isT3() { return session && session.terrain === 'T3'; }

function computeComplete() {
  if (isT3()) {
    if (!S.espece) return false;
    if (['MORT', 'VIDE'].includes(S.espece)) return true;
    return !!S.fruits_bin;
  }
  if (!S.etat) return false;
  if (S.etat === 'AUTRE') return !!S.autre_type && !!S.autre_fruit;
  if (['MORT', 'VIDE'].includes(S.etat)) return true;
  if (!S.tronc || !S.arch || !S.fruits || !S.ecorce) return false;
  if (S.fruits !== '0' && (!S.couleur || !S.pourri)) return false;
  return true;
}

function currentSignature() {
  return isT3()
    ? [S.espece, S.fruits_bin].join('|')
    : [S.etat, S.tronc, S.arch, S.fruits, S.couleur, S.pourri, S.ecorce].join('|');
}

function newObsRecord() {
  const pos = session.position;
  const t3 = isT3();
  return {
    obs_id: uid(),
    arbre_id: arbreId(session.terrain, session.rang, pos),
    rang_key: rangKey(session.terrain, session.rang),
    terrain: session.terrain,
    rang: session.rang,
    position: pos,
    hors_plan: (session.plan && pos > session.plan) ? 'OUI' : 'NON',
    passe: session.passe,
    version: baseVersion + 1,
    charge_mode: t3 ? 'BINAIRE' : 'PALIER',
    etat: null, autre_type: null, autre_fruit: null, espece: null,
    tronc: null, arch: null, fruits: null, fruits_bin: null,
    couleur: null, pourri: null, ecorce: null,
    arbre_complet: 'NON',
    t_start: t0,
    duree_saisie_s: 0,
    flag_qc: 'OK',
    horodatage_iso: nowIso(),
    operateur_label: PREF.operateur,
    device_id: PREF.deviceId,
    app_version: APP_VERSION,
    langue_saisie: LANG,
    source: session.mode === 'RECONTROLE' ? 'RECONTROLE'
      : session.mode === 'ENTRAINEMENT' ? 'ENTRAINEMENT' : 'SAISIE',
    media_ref: null
  };
}

/* Écriture disque à chaque tap (§10.3). Rien n'est différé. */
async function persistTap() {
  let rec;
  if (curObsId) {
    rec = await dbGet('observations', curObsId);
    if (!rec) { curObsId = null; }
  }
  if (!curObsId) {
    rec = newObsRecord();
    curObsId = rec.obs_id;
    if (curIsNewTree) { treeCountCache++; curIsNewTree = false; }
  }

  const dur = Math.max(0, Math.round((Date.now() - t0) / 1000));
  Object.assign(rec, {
    etat: S.etat || null,
    autre_type: S.autre_type || null,
    autre_fruit: S.autre_fruit || null,
    espece: isT3() ? (['MORT', 'VIDE'].includes(S.espece) ? null : (S.espece || null)) : null,
    tronc: S.tronc || null,
    arch: S.arch || null,
    fruits: S.fruits || null,
    fruits_bin: S.fruits_bin || null,
    couleur: S.couleur || null,
    pourri: S.pourri || null,
    ecorce: S.ecorce || null,
    media_ref: S.media_ref || null,
    duree_saisie_s: dur,
    horodatage_iso: nowIso(),
    langue_saisie: LANG,
    arbre_complet: computeComplete() ? 'OUI' : 'NON'
  });

  /* Sur T3 l'espèce MORT/VIDE se range dans etat, pas dans espece. */
  if (isT3()) {
    rec.etat = ['MORT', 'VIDE'].includes(S.espece) ? S.espece
      : (S.espece ? 'VIVANT' : null);
  }

  rec.flag_qc = flagFor(rec, dur);
  await dbPut('observations', rec);
  await saveSession();
  paintSaveBar();
}

/* flag_qc ne prend que les deux valeurs définies par la spécification.
   Une série monotone déclenche l'écran de rappel (§11) mais n'est pas marquée
   ici : elle se lit directement dans le fichier, où quinze lignes consécutives
   strictement identiques se repèrent sans aide, et inventer une troisième
   valeur casserait les filtres de l'analyste. */
function flagFor(rec, dur) {
  return (rec.arbre_complet === 'OUI' && dur < FAST_ENTRY_S) ? 'RAPIDE' : 'OK';
}

/* ===================================================================
   9. ÉCRANS
   =================================================================== */

const SCREENS = ['scr-first', 'scr-home', 'scr-mission', 'scr-mission3',
  'scr-tree', 'scr-tree3', 'scr-data'];

function show(id) {
  SCREENS.forEach(s => $(s).classList.toggle('hidden', s !== id));
  fitAll($(id));
}

/* --- barre de sauvegarde et alerte d'export (§2.2) -------------------- */

let treeCountCache = 0;

async function refreshCounts() {
  const obs = await dbAll('observations');
  const ids = new Set(obs.map(o => o.arbre_id));
  treeCountCache = ids.size;
  paintSaveBar();
  return { trees: ids.size, rows: obs.length, obs: obs };
}

async function paintSaveBar() {
  const last = await metaGet('dernier_export', null);
  const mins = minutesSince(last);
  const late = mins === null || mins >= EXPORT_ALERT_MIN;
  $('savebar').classList.toggle('alert', late);
  $('savecount').textContent = t('bar.saved') + ' · ' + treeCountCache + ' ' + t('common.trees');
  $('saveexport').textContent =
    mins === null ? t('bar.export_never')
      : late ? t('bar.export_late', { n: mins })
        : mins < 1 ? t('bar.export_now')
          : t('bar.export_ago', { n: mins });

  /* Le rappel s'affiche sur SUIVANT mais ne bloque jamais la saisie (§2.2). */
  [['nextnote'], ['nextnote3']].forEach(([id]) => {
    const el = $(id);
    if (!el) return;
    el.textContent = t('tree.export_reminder');
    el.classList.toggle('hidden', !late);
  });
}

/* --- premier lancement (§5.1) ---------------------------------------- */

function initFirstRun() {
  const input = $('nameinput');
  const btn = $('namesave');
  const check = () => btn.classList.toggle('ready', normName(input.value).length >= 2);
  input.addEventListener('input', check);
  btn.addEventListener('click', async () => {
    const n = normName(input.value);
    if (n.length < 2) return;
    PREF.operateur = n;
    PREF.deviceId;                       // force la création si absent
    await metaSet('first_run_done', true);
    buzz();
    await goHome();
  });
  check();
}

/* --- accueil (§5.2) --------------------------------------------------- */

async function goHome() {
  const counts = {};
  for (const tr of ['T1', 'T2']) counts[tr] = (await rangsOf(tr)).length;
  $('t1sub').textContent = t('setup.t1s', { n: counts.T1 });
  $('t2sub').textContent = t('setup.t2s', { n: counts.T2 });
  $('whoname').textContent = PREF.operateur;

  const s = await metaGet('session', null);
  const rb = $('resumebtn');
  if (s) {
    rb.classList.remove('hidden');
    $('resumewhere').textContent =
      t('setup.resume_at', { t: s.terrain, r: pad(s.rang, 2), p: s.position });
  } else {
    rb.classList.add('hidden');
  }

  markGroup('ter', null);
  pendingTerrain = null;
  $('gosetup').classList.remove('ready');
  await refreshCounts();
  show('scr-home');
  refreshGates();
}

/* Sélection exclusive dans un groupe. null efface le groupe. */
function markGroup(group, value) {
  $$('[data-g=' + group + '] button').forEach(b => {
    b.classList.toggle('on', value !== null && b.dataset.v === value);
  });
}

/* --- mission T1/T2 (§5.3) --------------------------------------------- */

let pendingTerrain = null;

async function goMission(terrain) {
  pendingTerrain = terrain;
  if (terrain === 'T3') return goMission3();

  const r = await nextRang(terrain);
  if (!r) {
    $('m-terrain').textContent = t('mission.all_done');
    $('m-terrain').style.fontSize = '22px';
    $('m-rang').textContent = '';
    $('m-plan').textContent = '';
    $('m-note').textContent = t('mission.all_done_note');
    $('m-start').classList.add('hidden');
    show('scr-mission');
    return;
  }
  $('m-start').classList.remove('hidden');
  $('m-terrain').style.fontSize = '';
  $('m-terrain').textContent = t('mission.terrain', { n: terrain.slice(1) });
  $('m-rang').textContent = t('mission.rang', { n: r.rang });

  /* origine_position_1 est vide pour les 88 rangs du registre livré : le sens
     de parcours n'est affiché que si la colonne est un jour renseignée, plutôt
     que d'inventer un « pars du BAS » que rien ne fonde. */
  const plan = r.positions_attendues
    ? t('mission.plan', { n: r.positions_attendues })
    : t('mission.plan_unknown');
  const sens = r.origine_position_1
    ? t('mission.sens_known', {
      sens: /HAUT|TOP/i.test(r.origine_position_1) ? t('mission.sens_haut') : t('mission.sens_bas')
    })
    : '';
  $('m-plan').textContent = sens ? plan + ' · ' + sens : plan;

  const resumeAt = r.statut === 'PARTIEL' ? r.derniere_position + 1 : 1;
  $('m-note').textContent = r.statut === 'PARTIEL'
    ? t('mission.resume_note', { p: resumeAt })
    : t('mission.note');

  $('m-start').onclick = () => startSession(terrain, r.rang, r.positions_attendues, resumeAt);
  show('scr-mission');
}

/* --- session de saisie ------------------------------------------------ */

async function startSession(terrain, rang, plan, position) {
  if (!persistGranted) return;
  session = {
    terrain: terrain,
    rang: rang,
    plan: plan || null,
    position: position || 1,
    passe: CAMPAGNE,
    mode: 'NORMAL',
    porte_greffe: '',
    ladder: {},
    started_iso: nowIso()
  };
  const r = await dbGet('rangs', rangKey(terrain, rang));
  if (r) {
    session.porte_greffe = r.porte_greffe || '';
    if (r.statut === 'NEUF') { r.statut = 'EN_COURS'; await dbPut('rangs', r); }
  }
  await rebuildLadder();
  await saveSession();
  await wakeOn();
  await enterPosition(session.position);
  show(isT3() ? 'scr-tree3' : 'scr-tree');
}

async function resumeSession() {
  if (!persistGranted) return;
  const s = await metaGet('session', null);
  if (!s) return goHome();
  /* Un recontrôle interrompu ne se reprend pas : le tirage est perdu et
     reprendre à l'aveugle sur une liste partielle fausserait le taux. */
  if (s.mode === 'RECONTROLE') {
    await metaSet('session', null);
    return goHome();
  }
  /* Un entraînement, si : c'est une centaine d'arbres, la liste est ordonnée
     et sauvegardée, la perdre pour une batterie vide serait absurde. */
  if (s.mode === 'ENTRAINEMENT') {
    const t = await metaGet('entrainement', null);
    if (!t || !t.ids || !t.ids.length) {
      await metaSet('session', null);
      return goHome();
    }
    trainState = t;
    await wakeOn();
    await trainLoad(trainState.i);
    return show('scr-tree');
  }
  session = s;
  await rebuildLadder();
  await wakeOn();
  await enterPosition(session.position);
  show(isT3() ? 'scr-tree3' : 'scr-tree');
}

/* Une visite sur une position ne modifie jamais l'enregistrement existant :
   elle en crée un nouveau au premier tap, avec version + 1 (§10.10).
   L'arbre laissé incomplet par un crash reste donc dans la base, tel quel. */
async function enterPosition(pos) {
  session.position = pos;
  const aid = arbreId(session.terrain, session.rang, pos);
  const toutes = await dbIndexAll('observations', 'arbre_id', aid);
  /* Sert à faire monter le compteur de la barre dès le premier tap : relire
     toute la base à chaque tap pour recompter coûterait trop cher, et une
     barre figée à zéro pendant tout un rang dit exactement le contraire de
     ce qu'elle doit dire. */
  curIsNewTree = toutes.length === 0;
  const prior = toutes
    .filter(o => o.passe === session.passe)
    .sort((a, b) => a.version - b.version);
  const latest = prior[prior.length - 1] || null;

  S = {};
  if (latest) {
    ['etat', 'autre_type', 'autre_fruit', 'espece', 'tronc', 'arch', 'fruits',
      'fruits_bin', 'couleur', 'pourri', 'ecorce', 'media_ref'].forEach(k => {
        if (latest[k]) S[k] = latest[k];
      });
    if (isT3() && ['MORT', 'VIDE'].includes(latest.etat)) S.espece = latest.etat;
  }
  baseVersion = latest ? latest.version : 0;
  curObsId = null;
  t0 = Date.now();

  await saveSession();
  paintTree();
}

async function rebuildLadder() {
  session.ladder = {};
  const obs = await dbIndexAll('observations', 'rang_key', rangKey(session.terrain, session.rang));
  const byPos = {};
  obs.filter(o => o.passe === session.passe).forEach(o => {
    if (!byPos[o.position] || byPos[o.position].version < o.version) byPos[o.position] = o;
  });
  Object.keys(byPos).forEach(p => {
    session.ladder[p] = byPos[p].etat === 'MORT' ? 'dead' : 'done';
  });
}

/* --- rendu de l'écran arbre (§5.4) ------------------------------------ */

function paintLadder() {
  const lad = $('ladder');
  const plan = session.plan || 0;
  const n = Math.max(plan, session.position, 1);
  lad.style.gap = n > 40 ? '1px' : '2px';
  lad.innerHTML = '';
  for (let i = 1; i <= n; i++) {
    const d = document.createElement('div');
    let cls = 'tick';
    const st = session.ladder[i];
    if (i === session.position) cls += ' now';
    else if (st === 'dead') cls += ' dead';
    else if (st === 'done') cls += ' done';
    else if (plan && i > plan) cls += ' extra';
    d.className = cls;
    lad.appendChild(d);
  }
}

function paintTree() {
  if (isT3()) return paintTree3();
  const pos = session.position;
  const plan = session.plan;
  const hors = plan && pos > plan;

  $('addr').innerHTML = '';
  const head = document.createElement('span');
  head.textContent = session.terrain + ' · R' + pad(session.rang, 2) + ' · ' + pad(pos, 3);
  $('addr').appendChild(head);
  if (plan) {
    const small = document.createElement('small');
    small.textContent = ' / ' + pad(plan, 3);
    $('addr').appendChild(small);
  }

  $('hdr').classList.toggle('hors', !!hors);
  $('hint').textContent = hors ? '⚠ ' + t('tree.hors')
    : session.mode === 'RECONTROLE'
      ? t('qc.reco_running', { i: recoState.i + 1, n: recoState.ids.length })
      : session.mode === 'ENTRAINEMENT'
        ? t('train.running', { i: trainState.i + 1, n: trainState.ids.length })
        : [PREF.operateur, session.porte_greffe].filter(Boolean).join(' · ');

  /* En recontrôle et en entraînement, c'est l'application qui décide de
     l'arbre suivant : une réglette de progression du rang n'aurait pas de
     sens, et TERMINER CE RANG non plus. */
  const guide = session.mode === 'RECONTROLE' || session.mode === 'ENTRAINEMENT';
  $('ladder').classList.toggle('hidden', guide);
  if (!guide) paintLadder();
  $('endrow').classList.toggle('hidden', guide);

  ['etat', 'tronc', 'arch', 'fruits', 'couleur', 'pourri', 'ecorce']
    .forEach(g => markGroup(g, S[g] || null));

  refreshTree();
}

function refreshTree() {
  const terminal = ETAT_TERMINAL.includes(S.etat);
  $('rest').classList.toggle('hidden', terminal);
  const hasFruit = S.fruits && S.fruits !== '0';
  $('iffruit').classList.toggle('hidden', !hasFruit);
  $('next').classList.toggle('ready', computeComplete());
  revealFit($('rest'));
  revealFit($('iffruit'));
}

function paintTree3() {
  $('addr3').textContent = 'T3 · R' + pad(session.rang, 2) + ' · ' + pad(session.position, 3);
  markGroup('sp', S.espece || null);
  markGroup('fr3', S.fruits_bin || null);
  refreshTree3();
}

function refreshTree3() {
  const live = ['POMMIER', 'POIRIER', 'AUTRE'].includes(S.espece);
  $('fr3').classList.toggle('hidden', !live);
  $('next3').classList.toggle('ready', computeComplete());
  revealFit($('fr3'));
}

/* --- taps ------------------------------------------------------------- */

async function onTap(group, value) {
  if (group === 'lang') { setLang(value); buzz(); return; }
  if (group === 'ter') {
    markGroup('ter', value);
    $('gosetup').classList.add('ready');
    pendingTerrain = value;
    buzz();
    return;
  }
  if (!session) return;

  buzz();

  if (group === 'sp') {
    S.espece = value;
    delete S.fruits_bin;
    markGroup('sp', value);
    markGroup('fr3', null);
    await persistTap();
    refreshTree3();
    return;
  }
  if (group === 'fr3') {
    S.fruits_bin = value;
    markGroup('fr3', value);
    await persistTap();
    refreshTree3();
    return;
  }

  S[group] = value;
  markGroup(group, value);

  if (group === 'etat') {
    if (value !== 'AUTRE') { delete S.autre_type; delete S.autre_fruit; }
    if (ETAT_TERMINAL.includes(value)) {
      ['tronc', 'arch', 'fruits', 'couleur', 'pourri', 'ecorce'].forEach(k => {
        delete S[k]; markGroup(k, null);
      });
    }
  }
  /* Aucune valeur n'est pré-sélectionnée, et un retour à 0 pomme efface
     les blocs conditionnels au lieu de laisser un faux zéro (§8, §10.4). */
  if (group === 'fruits' && value === '0') {
    delete S.couleur; delete S.pourri;
    markGroup('couleur', null); markGroup('pourri', null);
  }

  await persistTap();
  refreshTree();

  if (group === 'etat' && value === 'AUTRE') openAutre();
}

/* --- AUTRE : liste fermée, aucune saisie clavier (§5.4) --------------- */

let ovCurrent = null;

function openOv(renderer) {
  ovCurrent = renderer;
  $('ovb').innerHTML = '';
  renderer($('ovb'));
  $('ov').classList.add('show');
  fitAll($('ov'));
}

function closeOv() {
  $('ov').classList.remove('show');
  ovCurrent = null;
}

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}

function bigButton(labelKey, subKey, onClick, style) {
  const b = el('button', 'bl');
  b.appendChild(el('span', null, t(labelKey)));
  if (subKey) b.appendChild(el('span', 's', t(subKey)));
  if (style) b.setAttribute('style', style);
  b.onclick = () => { buzz(); onClick(); };
  return b;
}

function openAutre() {
  openOv(root => {
    root.appendChild(el('h2', null, t('autre.h')));
    const list = [
      ['POIRIER', 'autre.pear', null],
      ['REPLANT', 'autre.replant', null],
      ['SAUVAGEON', 'autre.wild', 'autre.wild_s'],
      ['SOUCHE', 'autre.stump', null],
      ['AUTRE_ESP', 'autre.other_sp', null]
    ];
    list.forEach(([v, k, s]) => root.appendChild(bigButton(k, s, () => pickAutre(v))));
    root.appendChild(bigButton('autre.voice', 'autre.voice_s', startVoice,
      'border-style:dashed'));
  });
}

async function pickAutre(v) {
  S.autre_type = v;
  if (v === 'SOUCHE') {           // la question fruits est sautée (§5.4)
    S.autre_fruit = 'NON';
    await persistTap();
    closeOv();
    refreshTree();
    return;
  }
  await persistTap();
  openOv(root => {
    root.appendChild(el('h2', null, t('autre.fruit_h')));
    const c = el('div', 'card');
    c.appendChild(el('div', 'd', MAP.autre_type[v] + ' — ' + t('autre.fruit_note')));
    root.appendChild(c);
    root.appendChild(bigButton('autre.fruit_yes', null, () => pickAutreFruit('OUI'),
      'border-color:var(--green);color:var(--green)'));
    root.appendChild(bigButton('autre.fruit_no', null, () => pickAutreFruit('NON')));
  });
}

async function pickAutreFruit(v) {
  S.autre_fruit = v;
  await persistTap();
  closeOv();
  refreshTree();
}

/* --- note vocale facultative de 30 s ---------------------------------- */

let mediaRec = null;

async function startVoice() {
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('voice.denied', true);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    return toast('voice.denied', true);
  }
  const chunks = [];
  mediaRec = new MediaRecorder(stream);
  mediaRec.ondataavailable = e => chunks.push(e.data);
  mediaRec.onstop = async () => {
    stream.getTracks().forEach(tr => tr.stop());
    const blob = new Blob(chunks, { type: mediaRec.mimeType || 'audio/webm' });
    const id = uid();
    await dbPut('medias', {
      media_id: id, type: 'AUDIO', blob: blob,
      terrain: session.terrain, rang: session.rang, position: session.position,
      horodatage_iso: nowIso(),
      filename: session.terrain + '_R' + pad(session.rang, 2) + '_' + pad(session.position, 3)
        + '_' + stampLocal() + '.webm'
    });
    S.media_ref = id;
    await persistTap();
    openAutreAfterVoice();
  };

  let left = VOICE_MAX_S;
  openOv(root => {
    root.appendChild(el('h2', null, t('autre.voice')));
    const c = el('div', 'card');
    const d = el('div', 't', t('voice.recording', { n: left }));
    c.appendChild(d);
    root.appendChild(c);
    root.appendChild(bigButton('voice.stop', null, () => {
      if (mediaRec && mediaRec.state === 'recording') mediaRec.stop();
    }, 'border-color:var(--red);color:var(--red)'));
    const iv = setInterval(() => {
      left--;
      d.textContent = t('voice.recording', { n: Math.max(0, left) });
      if (left <= 0) {
        clearInterval(iv);
        if (mediaRec && mediaRec.state === 'recording') mediaRec.stop();
      }
    }, 1000);
  });
  mediaRec.start();
}

function openAutreAfterVoice() {
  openOv(root => {
    root.appendChild(el('h2', null, t('voice.saved')));
    const list = [
      ['POIRIER', 'autre.pear'], ['REPLANT', 'autre.replant'],
      ['SAUVAGEON', 'autre.wild'], ['SOUCHE', 'autre.stump'],
      ['AUTRE_ESP', 'autre.other_sp']
    ];
    list.forEach(([v, k]) => root.appendChild(bigButton(k, null, () => pickAutre(v))));
  });
}

/* --- navigation entre arbres ------------------------------------------ */

async function goNext() {
  if (!computeComplete()) return;
  buzz();

  if (session.mode === 'RECONTROLE') return recoNext();
  if (session.mode === 'ENTRAINEMENT') return trainNext();

  session.ladder[session.position] = S.etat === 'MORT' ? 'dead' : 'done';

  /* La détection de monotonie interrompt l'avance : c'est l'accusé de
     réception de l'écran de rappel qui reprend la main (§11). */
  if (await monotonyBlocks()) return;
  await advanceToNext();
}

/* enterPosition repeint déjà l'écran ; rien à ajouter ici. */
async function advanceToNext() {
  const r = await dbGet('rangs', rangKey(session.terrain, session.rang));
  if (r && session.position > (r.derniere_position || 0)) {
    r.derniere_position = session.position;
    await dbPut('rangs', r);
  }
  await enterPosition(session.position + 1);
  window.scrollTo(0, 0);
}

async function goPrev() {
  if (session.position <= 1) return toast('tree.no_prev', false);
  buzz();
  await enterPosition(session.position - 1);
  if (!isT3()) paintTree(); else paintTree3();
  toast('tree.prev_traced', false);
}

/* --- fin de rang, deux réponses de sens opposé (§5.5) ----------------- */

async function countRang() {
  const obs = await dbIndexAll('observations', 'rang_key', rangKey(session.terrain, session.rang));
  return new Set(obs.filter(o => o.passe === session.passe).map(o => o.position)).size;
}

async function openEndRow() {
  buzz();
  const n = await countRang();
  const t3 = isT3();
  openOv(root => {
    root.appendChild(el('h2', null, t3 ? t('fin.t3_h') : t('fin.h')));
    const c = el('div', 'card');
    const inner = el('div');
    inner.appendChild(el('div', 't', t3 ? t('fin.t3_count', { n: n }) : t('fin.count', { n: n })));
    inner.appendChild(el('div', 'd', t3 ? t('fin.t3_note')
      : (session.plan ? t('fin.plan_expects', { n: session.plan }) : t('fin.plan_unknown'))));
    c.appendChild(inner);
    root.appendChild(c);

    root.appendChild(bigButton(t3 ? 'fin.t3_finished' : 'fin.finished',
      t3 ? null : 'fin.finished_s', () => closeRow('FINI', n),
      t3 ? 'border-color:var(--teal);color:var(--teal)'
        : 'border-color:var(--green);color:var(--green)'));
    root.appendChild(bigButton(t3 ? 'fin.t3_pause' : 'fin.pause',
      t3 ? null : 'fin.pause_s', () => closeRow('PAUSE', n),
      'border-color:var(--amber);color:var(--amber)'));
    root.appendChild(bigButton('common.cancel', null, closeOv));
  });
}

/* COMPLET  : « il n'y a plus d'arbres », le registre est corrigé au compte réel.
   PARTIEL  : « je m'arrête ici », le rang est exclu des calculs de taux.
   ÉCART    : le rang est terminé mais le registre n'avait pas de compte fiable
              (colonne a_verifier, ou aucune valeur attendue). L'analyste doit
              savoir qu'il n'y a rien à quoi comparer. */
async function closeRow(kind, n) {
  const key = rangKey(session.terrain, session.rang);
  const r = await dbGet('rangs', key);
  const plan = session.plan;
  let statut, message;

  if (kind === 'PAUSE') {
    statut = 'PARTIEL';
    message = t('fin.done_partiel', { p: session.position });
  } else if (isT3()) {
    statut = 'COMPLET';
    message = t('fin.done_t3');
  } else if (!plan || (r && r.a_verifier)) {
    statut = 'ECART';
    message = t('fin.done_ecart', { n: n, plan: plan || '—' });
  } else if (n === plan) {
    statut = 'COMPLET';
    message = t('fin.done_complet_exact', { n: n });
  } else {
    statut = 'COMPLET';
    message = t('fin.done_complet', { n: n, plan: plan });
  }

  if (r) {
    r.statut = statut;
    r.positions_reelles = n;
    r.derniere_position = kind === 'PAUSE' ? session.position - 1 : n;
    if (kind !== 'PAUSE') r.positions_attendues = n;   // registre corrigé au réel
    await dbPut('rangs', r);
  }

  /* Couche 2 : le fichier part tout seul, sans intervention de l'opérateur. */
  const exp = await exportRang(session.terrain, session.rang);

  session = null;
  await metaSet('session', null);
  wakeOff();
  await refreshCounts();

  closeOv();
  openOv(root => {
    root.appendChild(el('h2', null, t(kind === 'PAUSE' ? 'fin.pause' : 'fin.h')));
    const c = el('div', 'card');
    c.appendChild(el('div', 'd', message));
    root.appendChild(c);
    const c2 = el('div', exp.ok ? 'msg good' : 'msg bad');
    c2.textContent = exp.ok ? t('fin.exported', { f: exp.name }) : t('fin.export_failed');
    root.appendChild(c2);
    root.appendChild(bigButton('common.ok', null, async () => { closeOv(); await goHome(); }));
  });
}

/* --- Terrain 3 : mode inventaire (§6) --------------------------------- */

let t3pick = null;
let t3photo = null;    // {blob, lat, lon, acc}

async function goMission3() {
  t3pick = null;
  t3photo = null;
  $('t3photook').classList.add('hidden');
  $('t3retake').classList.add('hidden');
  $('t3photoreq').classList.remove('hidden');
  $('t3go').classList.remove('ready');

  const existing = await rangsOf('T3');
  const used = {};
  existing.forEach(r => { used[r.rang] = r.statut; });

  const box = $('t3rows');
  box.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const b = el('button', 'b4');
    b.appendChild(el('span', null, String(i)));
    b.onclick = () => pickT3Row(i, used);
    box.appendChild(b);
  }
  const more = el('button', 'b4');
  more.appendChild(el('span', null, t('t3.other_row')));
  more.onclick = () => openT3Keypad(used);
  box.appendChild(more);

  show('scr-mission3');
}

function pickT3Row(n, used) {
  buzz();
  if (used[n] === 'COMPLET') return toast('t3.row_taken', true, { n: n, s: used[n] });
  t3pick = n;
  $$('#t3rows button').forEach(b => b.classList.remove('on'));
  const btns = $$('#t3rows button');
  if (n <= 5) btns[n - 1].classList.add('on'); else btns[5].classList.add('on');
  updateT3Go();
}

/* Le numéro de rang se compose au pavé tactile : aucune saisie clavier
   n'est autorisée au champ (§10.1). */
function openT3Keypad(used) {
  let buf = '';
  openOv(root => {
    root.appendChild(el('h2', null, t('t3.keypad_h')));
    const view = el('div', 'padview', '—');
    root.appendChild(view);
    const grid = el('div', 'pad');
    const push = (d) => { if (buf.length < 3) { buf += d; view.textContent = buf; } buzz(); };
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(d => {
      const b = el('button', null);
      b.appendChild(el('span', null, d));
      b.onclick = () => push(d);
      grid.appendChild(b);
    });
    const clr = el('button', null);
    clr.appendChild(el('span', null, '⌫'));
    clr.onclick = () => { buf = buf.slice(0, -1); view.textContent = buf || '—'; buzz(); };
    grid.appendChild(clr);
    const zero = el('button', null);
    zero.appendChild(el('span', null, '0'));
    zero.onclick = () => push('0');
    grid.appendChild(zero);
    const ok = el('button', null);
    ok.appendChild(el('span', null, '✓'));
    ok.onclick = () => {
      const n = parseInt(buf, 10);
      if (!n) return;
      closeOv();
      pickT3Row(n, used);
      $$('#t3rows button')[5].querySelector('span').textContent = String(n);
    };
    grid.appendChild(ok);
    root.appendChild(grid);
  });
}

function updateT3Go() {
  $('t3go').classList.toggle('ready', !!t3pick && !!t3photo);
}

/* Photo de tête de rang : obligatoire, horodatée, géolocalisée (§6).
   Le GPS n'est qu'une métadonnée de cette photo — jamais un identifiant (§4.2). */
function gpsOnce() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

function initT3() {
  $('t3go').addEventListener('click', async () => {
    if (!persistGranted) return;
    if (!t3pick) return;
    if (!t3photo) { $('t3file').click(); return; }
    await startT3(t3pick);
  });
  $('t3file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    $('t3photook').classList.remove('hidden');
    $('t3photook').textContent = t('t3.gps_wait');
    const g = await gpsOnce();
    t3photo = { blob: f, lat: g ? g.lat : null, lon: g ? g.lon : null, acc: g ? g.acc : null };
    const gpsTxt = g ? t('t3.gps_ok', { a: Math.round(g.acc) }) : t('t3.gps_none');
    $('t3photook').textContent = t('t3.photo_taken', { gps: gpsTxt });
    $('t3photoreq').classList.add('hidden');
    $('t3retake').classList.remove('hidden');
    buzz();
    updateT3Go();
  });
  /* Une photo floue ou prise devant le mauvais rang ne se corrige plus une
     fois la session lancée : c'est la seule ancre du Terrain 3. */
  $('t3retake').addEventListener('click', () => {
    t3photo = null;
    $('t3photook').classList.add('hidden');
    $('t3retake').classList.add('hidden');
    $('t3photoreq').classList.remove('hidden');
    updateT3Go();
    $('t3file').click();
  });
  $('t3back').addEventListener('click', goHome);
}

async function startT3(rang) {
  const key = rangKey('T3', rang);
  let r = await dbGet('rangs', key);
  if (!r) {
    r = {
      key: key, terrain: 'T3', rang: rang, positions_attendues: null,
      longueur_m: null, espacement_m: null, porte_greffe: '', origine_position_1: '',
      a_verifier: false, statut: 'EN_COURS', positions_reelles: null, derniere_position: 0
    };
  }
  const mediaId = uid();
  await dbPut('medias', {
    media_id: mediaId, type: 'PHOTO', blob: t3photo.blob,
    terrain: 'T3', rang: rang, position: 0,
    lat: t3photo.lat, lon: t3photo.lon, acc: t3photo.acc,
    horodatage_iso: nowIso(),
    filename: 'T3_R' + pad(rang, 2) + '_TETE_' + (PREF.operateur || PREF.deviceId)
      + '_' + stampLocal() + '.jpg'
  });
  r.photo_id = mediaId;
  await dbPut('rangs', r);
  await startSession('T3', rang, null, (r.derniere_position || 0) + 1);
}

/* --- fiches de référence (§7) ----------------------------------------- */

function figure(src, titleKey, descKey) {
  const f = el('div', 'figure');
  const img = document.createElement('img');
  img.src = src;                       // chemin relatif, jamais de base64 (§1)
  img.alt = t(titleKey);
  /* Pas de chargement différé : les six photos sont préchargées par le service
     worker et la fiche s'ouvre devant l'arbre. Faire attendre l'opérateur le
     temps qu'une image entre dans le champ de vision n'a aucun intérêt ici. */
  f.appendChild(img);
  const c = el('div', 'fc');
  c.appendChild(el('div', 'ft', t(titleKey)));
  c.appendChild(el('div', 'fd', t(descKey)));
  f.appendChild(c);
  return f;
}

const FICHES = {
  tronc(root) {
    root.appendChild(el('h2', null, t('fiche.tronc_h')));
    const c = el('div', 'card');
    c.innerHTML = '<svg width="86" height="66" viewBox="0 0 86 66" aria-hidden="true">'
      + '<rect x="6" y="9" width="72" height="48" fill="none" stroke="#0B0E10" stroke-width="4"/>'
      + '<path d="M6 24h20a10 10 0 0 1 0 18H6" fill="none" stroke="#0B0E10" stroke-width="4"/>'
      + '<path d="M78 18H50a15 15 0 0 0 0 30h28" fill="none" stroke="#0B0E10" stroke-width="4"/></svg>';
    c.appendChild(el('div', 'd', t('fiche.tronc_how')));
    root.appendChild(c);
    [['tree.thin', 'fiche.tronc_thin'], ['tree.medium', 'fiche.tronc_medium'],
    ['tree.thick', 'fiche.tronc_thick']].forEach(([a, b]) => {
      const k = el('div', 'card');
      const inner = el('div');
      inner.appendChild(el('div', 't', t(a)));
      inner.appendChild(el('div', 'd', t(b)));
      k.appendChild(inner);
      root.appendChild(k);
    });
  },

  arch(root) {
    root.appendChild(el('h2', null, t('fiche.arch_h')));
    /* L'avertissement est en haut de fiche et encadré : ces deux pièges font
       passer un arbre mal formé pour un arbre bien formé (§7.2). */
    const w = el('div', 'warn');
    w.appendChild(el('div', 'wt', t('fiche.arch_warn_t')));
    const ul = el('ul');
    ul.appendChild(el('li', null, t('fiche.arch_warn_1')));
    ul.appendChild(el('li', null, t('fiche.arch_warn_2')));
    w.appendChild(ul);
    w.appendChild(el('div', 'wt', t('fiche.arch_warn_t2')));
    const ul2 = el('ul');
    ul2.appendChild(el('li', null, t('fiche.arch_warn_3')));
    w.appendChild(ul2);
    w.appendChild(el('div', 'link', t('fiche.arch_link')));
    root.appendChild(w);

    const svgs = {
      A: '<svg width="72" height="98" viewBox="0 0 72 98" aria-hidden="true"><path d="M36 94V14" stroke="#0B0E10" stroke-width="7"/><path d="M36 48L10 28M36 42l28-18M36 68L14 57M36 62l26-11" stroke="#0F8A3C" stroke-width="5" stroke-linecap="round"/></svg>',
      B: '<svg width="72" height="98" viewBox="0 0 72 98" aria-hidden="true"><path d="M36 94V8" stroke="#0B0E10" stroke-width="7"/><path d="M36 42l15-8" stroke="#E08600" stroke-width="4" stroke-linecap="round"/><path d="M36 62l-10 6M36 28l11 6" stroke="#C9CFD3" stroke-width="2.5" stroke-linecap="round"/></svg>',
      C: '<svg width="72" height="98" viewBox="0 0 72 98" aria-hidden="true"><path d="M36 94V52" stroke="#0B0E10" stroke-width="7"/><path d="M36 52l13-13" stroke="#6B3FA0" stroke-width="7" stroke-linecap="round"/><path d="M44 39l6-6M50 45l6-6" stroke="#6B3FA0" stroke-width="3"/></svg>'
    };
    [['A', '#0F8A3C', 'fiche.arch_a', 'fiche.arch_a_do'],
    ['B', '#E08600', 'fiche.arch_b', 'fiche.arch_b_do'],
    ['C', '#6B3FA0', 'fiche.arch_c', 'fiche.arch_c_do']].forEach(([L, col, d, doK]) => {
      const c = el('div', 'card');
      c.innerHTML = svgs[L];
      const inner = el('div');
      const tt = el('div', 't', L);
      tt.style.color = col;
      inner.appendChild(tt);
      const dd = el('div', 'd');
      dd.appendChild(document.createTextNode(t(d) + ' '));
      const b = document.createElement('b');
      b.textContent = t(doK);
      dd.appendChild(b);
      inner.appendChild(dd);
      c.appendChild(inner);
      root.appendChild(c);
    });
  },

  ecorce(root) {
    root.appendChild(el('h2', null, t('fiche.ecorce_h')));
    root.appendChild(figure('assets/ecorce_0_lisse.jpg', 'tree.smooth', 'fiche.ecorce_0'));
    root.appendChild(figure('assets/ecorce_1_quelques_bosses.jpg', 'tree.bumps', 'fiche.ecorce_1'));
    root.appendChild(figure('assets/ecorce_2_couverte.jpg', 'tree.covered', 'fiche.ecorce_2'));
    root.appendChild(figure('assets/ecorce_3_trou.jpg', 'tree.hole', 'fiche.ecorce_3'));

    const c = el('div', 'card col');
    const img = document.createElement('img');
    img.src = 'assets/discrimination_bosse_vs_plaie.jpg';
    img.alt = t('fiche.discr_h');
    c.appendChild(img);
    const cap = el('div', 'cap');
    const b = document.createElement('b');
    b.textContent = t('fiche.discr_h') + ' ';
    cap.appendChild(b);
    cap.appendChild(document.createTextNode(t('fiche.discr_1')));
    cap.appendChild(document.createElement('br'));
    cap.appendChild(document.createTextNode(t('fiche.discr_2')));
    cap.appendChild(document.createElement('br'));
    cap.appendChild(document.createTextNode(t('fiche.discr_3')));
    c.appendChild(cap);
    root.appendChild(c);
  },

  coul(root) {
    root.appendChild(el('h2', null, t('fiche.coul_h')));
    [['#4C9A2A', 'tree.green', 'fiche.coul_green'],
    ['#E8C51E', 'tree.yellow', 'fiche.coul_yellow'],
    ['#C0392B', 'tree.red', 'fiche.coul_red']].forEach(([col, a, b]) => {
      const c = el('div', 'card');
      const dot = el('span');
      dot.setAttribute('style', 'width:48px;height:48px;border-radius:50%;background:' + col
        + ';border:3px solid #0B0E10;display:block;flex:none');
      c.appendChild(dot);
      const inner = el('div');
      inner.appendChild(el('div', 't', t(a)));
      inner.appendChild(el('div', 'd', t(b)));
      c.appendChild(inner);
      root.appendChild(c);
    });
    const n = el('div', 'card');
    n.appendChild(el('div', 'd', t('fiche.coul_note')));
    root.appendChild(n);
  },

  blanc(root) {
    root.appendChild(el('h2', null, t('fiche.blanc_h')));
    const c = el('div', 'card col');
    const img = document.createElement('img');
    img.src = 'assets/discrimination_blanc_oidium_vs_puceron.jpg';
    img.alt = t('fiche.blanc_h');
    c.appendChild(img);
    const cap = el('div', 'cap');
    const b = document.createElement('b');
    b.textContent = t('fiche.blanc_q');
    cap.appendChild(b);
    cap.appendChild(document.createElement('br'));
    cap.appendChild(document.createTextNode(t('fiche.blanc_leaves')));
    cap.appendChild(document.createElement('br'));
    cap.appendChild(document.createTextNode(t('fiche.blanc_wood')));
    c.appendChild(cap);
    root.appendChild(c);
    const n = el('div', 'card');
    n.appendChild(el('div', 'd', t('fiche.blanc_note')));
    root.appendChild(n);
  }
};

function toast(key, bad, vars) {
  openOv(root => {
    const c = el('div', bad ? 'msg bad' : 'msg');
    c.textContent = t(key, vars);
    root.appendChild(c);
  });
}

/* ===================================================================
   10. CONTRÔLE QUALITÉ (§11)
   =================================================================== */

let monoRun = [];

/* Renvoie true si l'avance doit s'arrêter pour afficher l'écran de rappel.
   La série est remise à zéro dès que le rappel est affiché, pour ne pas
   le redéclencher à chaque arbre suivant. */
async function monotonyBlocks() {
  monoRun.push(currentSignature());
  if (monoRun.length > MONOTONY_N) monoRun.shift();
  const full = monoRun.length === MONOTONY_N && monoRun.every(x => x === monoRun[0]);
  if (!full) return false;

  monoRun = [];
  openOv(root => {
    root.appendChild(el('h2', null, t('qc.mono_h')));
    const c = el('div', 'msg bad');
    c.textContent = t('qc.mono_b');
    root.appendChild(c);
    root.appendChild(bigButton('qc.mono_ok', null, async () => {
      closeOv();
      await advanceToNext();
    }));
  });
  return true;
}

/* Recontrôle à l'aveugle : l'application repropose des arbres déjà saisis
   sans jamais afficher la réponse précédente (§11). */
async function openRecontrole() {
  const obs = (await dbAll('observations'))
    .filter(o => o.passe === CAMPAGNE && o.arbre_complet === 'OUI'
      && o.source === 'SAISIE' && o.terrain !== DEMO_TERRAIN);
  const byTree = {};
  obs.forEach(o => {
    if (!byTree[o.arbre_id] || byTree[o.arbre_id].version < o.version) byTree[o.arbre_id] = o;
  });
  const pool = Object.values(byTree);
  if (pool.length < 5) return toast('qc.reco_none', true);

  const n = Math.min(RECONTROLE_N, pool.length);
  for (let i = pool.length - 1; i > 0; i--) {          // mélange de Fisher-Yates
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, n);

  openOv(root => {
    root.appendChild(el('h2', null, t('qc.reco_h')));
    const c = el('div', 'msg');
    c.textContent = t('qc.reco_b', { n: n });
    root.appendChild(c);
    root.appendChild(bigButton('qc.reco_start', null, () => {
      closeOv();
      startRecontrole(picked);
    }, 'border-color:var(--green);color:var(--green)'));
    root.appendChild(bigButton('common.cancel', null, closeOv));
  });
}

/* ===================================================================
   MODE ENTRAÎNEMENT (nouvel opérateur)

   Le stagiaire refait les 4 premiers rangs déjà relevés par un opérateur
   expérimenté, dans l'ordre, à l'aveugle. À la fin, le responsable obtient
   un taux de concordance par variable et la liste des arbres à revoir
   ensemble — c'est cette liste qui sert à former, pas le pourcentage.

   Le corrigé vient d'un export réimporté : le téléphone d'un nouvel arrivant
   est vide, il n'a aucun relevé auquel se comparer.
   =================================================================== */

/* Les exports portent des codes ordinaux ; l'application travaille avec des
   clés internes. On reconstruit la correspondance inverse à partir de MAP,
   pour n'avoir qu'une seule table à maintenir. */
function fromCode(mapName, code) {
  const c = String(code).trim();
  if (c === '' || c === NULLV) return null;
  const table = MAP[mapName];
  for (const cle in table) {
    if (String(table[cle].code) === c) return cle;
  }
  return null;
}

const VARS_COMPAREES = [
  ['etat', 'qc.var_etat'], ['tronc', 'qc.var_tronc'], ['arch', 'qc.var_arch'],
  ['fruits', 'qc.var_fruits'], ['couleur', 'qc.var_couleur'],
  ['pourri', 'qc.var_pourri'], ['ecorce', 'qc.var_ecorce']
];

/* Importe un export ORCHARD-SCAN comme corrigé. On ne garde qu'une ligne par
   arbre, la plus récente : c'est la même règle que merge.py, pour que le
   corrigé soit exactement ce que l'analyste retiendrait. */
async function importerReference(file) {
  const texte = await file.text();
  const rows = parseCsvDelim(texte, ';');
  if (rows.length < 2) throw new Error('vide');
  const head = rows[0].map(h => h.trim());
  const idx = {};
  head.forEach((h, i) => { idx[h] = i; });
  if (idx.arbre_id === undefined || idx.etat_code === undefined) throw new Error('colonnes');

  const cell = (r, nom) => (idx[nom] === undefined ? '' : (r[idx[nom]] || '').trim());
  const meilleur = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = cell(r, 'arbre_id');
    if (!id || id === NULLV) continue;
    const source = cell(r, 'source');
    if (source === 'DEMO' || source === 'ENTRAINEMENT') continue;
    if (cell(r, 'terrain') === DEMO_TERRAIN) continue;
    const h = cell(r, 'horodatage_iso');
    if (meilleur[id] && meilleur[id].h >= h) continue;
    meilleur[id] = {
      h: h,
      rec: {
        arbre_id: id,
        rang_key: rangKey(cell(r, 'terrain'), parseInt(cell(r, 'rang'), 10) || 0),
        terrain: cell(r, 'terrain'),
        rang: parseInt(cell(r, 'rang'), 10) || 0,
        position: parseInt(cell(r, 'position'), 10) || 0,
        etat: fromCode('etat', cell(r, 'etat_code')),
        tronc: fromCode('tronc', cell(r, 'tronc_code')),
        arch: fromCode('arch', cell(r, 'arch_code')),
        fruits: fromCode('fruits', cell(r, 'fruits_code')),
        couleur: fromCode('couleur', cell(r, 'couleur_code')),
        pourri: fromCode('pourri', cell(r, 'pourri_code')),
        ecorce: fromCode('ecorce', cell(r, 'ecorce_code')),
        operateur_label: cell(r, 'operateur_label'),
        horodatage_iso: h
      }
    };
  }

  const anciens = await dbAll('reference');
  for (const a of anciens) await dbDel('reference', a.arbre_id);
  let n = 0;
  for (const id in meilleur) {
    /* Le Terrain 3 ne porte pas de diagnostic : rien à comparer. */
    if (meilleur[id].rec.terrain === 'T3') continue;
    await dbPut('reference', meilleur[id].rec);
    n++;
  }
  await metaSet('reference_importee_le', nowIso());
  return n;
}

/* Les 4 premiers rangs présents dans le corrigé, dans l'ordre du terrain
   puis du rang — le stagiaire les parcourt physiquement. */
async function rangsEntrainement() {
  const ref = await dbAll('reference');
  const parRang = {};
  ref.forEach(r => {
    parRang[r.rang_key] = parRang[r.rang_key] || { key: r.rang_key, terrain: r.terrain, rang: r.rang, arbres: [] };
    parRang[r.rang_key].arbres.push(r);
  });
  const rangs = Object.values(parRang)
    .sort((a, b) => a.terrain.localeCompare(b.terrain) || a.rang - b.rang)
    .slice(0, ENTRAINEMENT_RANGS);
  rangs.forEach(r => r.arbres.sort((a, b) => a.position - b.position));
  return rangs;
}

async function openEntrainement() {
  const rangs = await rangsEntrainement();
  if (!rangs.length) return toast('train.aucune_reference', true);
  const total = rangs.reduce((s, r) => s + r.arbres.length, 0);
  const libelle = rangs.map(r => r.terrain + '-R' + pad(r.rang, 2)).join(' · ');

  openOv(root => {
    root.appendChild(el('h2', null, t('train.h')));
    const m = el('div', 'msg');
    m.textContent = t('train.intro', { n: total, rangs: libelle });
    root.appendChild(m);
    root.appendChild(bigButton('train.start', null, () => {
      closeOv();
      startEntrainement(rangs);
    }, 'border-color:var(--green);color:var(--green)'));
    root.appendChild(bigButton('common.cancel', null, closeOv));
  });
}

let trainState = null;

async function startEntrainement(rangs) {
  if (!persistGranted) return;
  const ids = [];
  rangs.forEach(r => r.arbres.forEach(a => ids.push(a.arbre_id)));
  trainState = { ids: ids, i: 0, answers: [], debut_iso: nowIso() };
  await metaSet('entrainement', trainState);
  await trainLoad(0);
  await wakeOn();
  show('scr-tree');
}

async function trainLoad(i) {
  const ref = await dbGet('reference', trainState.ids[i]);
  trainState.i = i;
  session = {
    terrain: ref.terrain, rang: ref.rang, plan: null, position: ref.position,
    passe: CAMPAGNE_ENTRAINEMENT, mode: 'ENTRAINEMENT', porte_greffe: '', ladder: {},
    started_iso: nowIso()
  };
  S = {};                 // à l'aveugle : le corrigé n'est jamais montré
  curObsId = null;
  baseVersion = 0;
  t0 = Date.now();
  await saveSession();
  await metaSet('entrainement', trainState);
  paintTree();
}

async function trainNext() {
  trainState.answers.push({ id: trainState.ids[trainState.i], got: Object.assign({}, S) });
  await metaSet('entrainement', trainState);
  if (trainState.i + 1 < trainState.ids.length) {
    await trainLoad(trainState.i + 1);
    window.scrollTo(0, 0);
    return;
  }
  session = null;
  await metaSet('session', null);
  wakeOff();
  await refreshCounts();
  await showTrainResult();
}

/* Statistiques et, surtout, la liste des arbres à revoir. Un pourcentage ne
   forme personne ; un arbre qu'on va regarder ensemble, si. */
async function comparerEntrainement() {
  const stats = {};
  VARS_COMPAREES.forEach(([k]) => { stats[k] = { ok: 0, tot: 0 }; });
  const lignes = [];
  const parArbre = {};

  for (const a of trainState.answers) {
    const ref = await dbGet('reference', a.id);
    if (!ref) continue;
    for (const [k] of VARS_COMPAREES) {
      if (ref[k] === null || ref[k] === undefined) continue;
      const attendu = ref[k];
      const donne = a.got[k] === undefined ? null : a.got[k];
      const accord = attendu === donne;
      stats[k].tot++;
      if (accord) stats[k].ok++;
      lignes.push({
        arbre_id: a.id, terrain: ref.terrain, rang: ref.rang, position: ref.position,
        variable: k, reference: attendu, stagiaire: donne, accord: accord
      });
      if (!accord) {
        parArbre[a.id] = parArbre[a.id] || { arbre_id: a.id, terrain: ref.terrain, rang: ref.rang, position: ref.position, ecarts: [] };
        parArbre[a.id].ecarts.push({ variable: k, reference: attendu, stagiaire: donne });
      }
    }
  }
  const aRevoir = Object.values(parArbre).sort(
    (x, y) => y.ecarts.length - x.ecarts.length
      || x.terrain.localeCompare(y.terrain) || x.rang - y.rang || x.position - y.position);
  return { stats: stats, lignes: lignes, aRevoir: aRevoir };
}

function libelleValeur(variable, cle) {
  if (cle === null || cle === undefined) return NULLV;
  const table = MAP[variable];
  return (table && table[cle]) ? table[cle].label : String(cle);
}

async function showTrainResult() {
  const r = await comparerEntrainement();
  const totalOk = Object.values(r.stats).reduce((s, v) => s + v.ok, 0);
  const totalTot = Object.values(r.stats).reduce((s, v) => s + v.tot, 0);
  const global = totalTot ? Math.round(100 * totalOk / totalTot) : 0;

  openOv(root => {
    root.appendChild(el('h2', null, t('train.result_h')));

    const g = el('div', global >= ENTRAINEMENT_SEUIL ? 'msg good' : 'msg bad');
    g.textContent = t('train.global', { pct: global, ok: totalOk, tot: totalTot });
    root.appendChild(g);

    VARS_COMPAREES.forEach(([k, lk]) => {
      const s = r.stats[k];
      if (!s.tot) return;
      const pct = Math.round(100 * s.ok / s.tot);
      const d = el('div', 'dl');
      d.appendChild(el('span', 'k', t(lk)));
      d.appendChild(el('span', 'v ' + (pct >= ENTRAINEMENT_SEUIL ? 'ok' : 'ko'),
        t('qc.reco_rate_short', { pct: pct, ok: s.ok, tot: s.tot })));
      root.appendChild(d);
    });

    const h = el('div', 'lbl');
    h.style.marginTop = '14px';
    h.appendChild(el('span', 'txt', t('train.a_revoir', { n: r.aRevoir.length })));
    root.appendChild(h);

    if (!r.aRevoir.length) {
      const p = el('div', 'msg good');
      p.textContent = t('train.parfait');
      root.appendChild(p);
    }
    /* On montre les vingt premiers : au-delà, c'est le fichier qu'on lit,
       pas un écran de téléphone. */
    r.aRevoir.slice(0, 20).forEach(a => {
      const c = el('div', 'card col');
      c.appendChild(el('div', 't', a.arbre_id));
      a.ecarts.forEach(e => {
        c.appendChild(el('div', 'd', t('train.ecart', {
          v: t(VARS_COMPAREES.find(x => x[0] === e.variable)[1]),
          ref: libelleValeur(e.variable, e.reference),
          eleve: libelleValeur(e.variable, e.stagiaire)
        })));
      });
      root.appendChild(c);
    });
    if (r.aRevoir.length > 20) {
      const p = el('div', 'msg');
      p.textContent = t('train.et_plus', { n: r.aRevoir.length - 20 });
      root.appendChild(p);
    }

    root.appendChild(bigButton('train.export', null, () => exportEntrainement(r),
      'border-color:var(--green);color:var(--green)'));
    root.appendChild(bigButton('common.ok', null, async () => {
      trainState = null;
      await metaSet('entrainement', null);
      closeOv();
      await goHome();
    }));
  });
}

/* Rapport au format long, une ligne par arbre et par variable comparée :
   le responsable peut trier, filtrer, faire un tableau croisé. */
async function exportEntrainement(r) {
  const colonnes = ['arbre_id', 'terrain', 'rang', 'position', 'variable',
    'valeur_reference', 'valeur_stagiaire', 'accord',
    'stagiaire_label', 'stagiaire_device', 'campagne', 'horodatage_iso'];
  const stamp = nowIso();
  const lignes = r.lignes.map(l => [
    l.arbre_id, l.terrain, l.rang, l.position, l.variable,
    libelleValeur(l.variable, l.reference),
    libelleValeur(l.variable, l.stagiaire),
    l.accord ? 'OUI' : 'NON',
    PREF.operateur, PREF.deviceId, CAMPAGNE_ENTRAINEMENT, stamp
  ]);
  const nom = 'ENTRAINEMENT_' + (PREF.operateur || PREF.deviceId) + '_' + stampLocal() + '.csv';
  const ok = download(nom, csvDocument(colonnes, lignes));
  toast(ok ? 'fin.exported' : 'fin.export_failed', !ok, { f: nom });
}

async function startRecontrole(picked) {
  recoState = { ids: picked.map(o => o.arbre_id), ref: {}, i: 0, answers: [] };
  picked.forEach(o => { recoState.ref[o.arbre_id] = o; });
  await recoLoad(0);
  await wakeOn();
  show('scr-tree');
}

async function recoLoad(i) {
  const ref = recoState.ref[recoState.ids[i]];
  recoState.i = i;
  session = {
    terrain: ref.terrain, rang: ref.rang, plan: null, position: ref.position,
    passe: CAMPAGNE_RECONTROLE, mode: 'RECONTROLE', porte_greffe: '', ladder: {},
    started_iso: nowIso()
  };
  S = {};                 // à l'aveugle : rien n'est pré-rempli
  curObsId = null;
  baseVersion = 0;
  t0 = Date.now();
  await saveSession();
  paintTree();
}

async function recoNext() {
  recoState.answers.push({ id: recoState.ids[recoState.i], got: Object.assign({}, S) });
  if (recoState.i + 1 < recoState.ids.length) {
    await recoLoad(recoState.i + 1);
    window.scrollTo(0, 0);
    return;
  }
  session = null;
  await metaSet('session', null);
  wakeOff();
  await refreshCounts();
  showRecoResult();
}

function showRecoResult() {
  const vars = [['etat', 'qc.var_etat'], ['tronc', 'qc.var_tronc'], ['arch', 'qc.var_arch'],
  ['fruits', 'qc.var_fruits'], ['ecorce', 'qc.var_ecorce']];
  const stats = {};
  vars.forEach(([k]) => { stats[k] = { ok: 0, tot: 0 }; });
  recoState.answers.forEach(a => {
    const ref = recoState.ref[a.id];
    vars.forEach(([k]) => {
      if (ref[k] === null || ref[k] === undefined) return;
      stats[k].tot++;
      if (ref[k] === a.got[k]) stats[k].ok++;
    });
  });
  const archPct = stats.arch.tot ? Math.round(100 * stats.arch.ok / stats.arch.tot) : 100;

  openOv(root => {
    root.appendChild(el('h2', null, t('qc.reco_done_h')));
    vars.forEach(([k, lk]) => {
      const s = stats[k];
      const pct = s.tot ? Math.round(100 * s.ok / s.tot) : 0;
      const d = el('div', 'dl');
      d.appendChild(el('span', 'k', t(lk)));
      const v = el('span', 'v ' + (pct >= RECONTROLE_MIN_RATE ? 'ok' : 'ko'),
        t('qc.reco_rate_short', { pct: pct, ok: s.ok, tot: s.tot }));
      d.appendChild(v);
      root.appendChild(d);
    });
    const m = el('div', archPct < RECONTROLE_MIN_RATE ? 'msg bad' : 'msg good');
    m.textContent = archPct < RECONTROLE_MIN_RATE ? t('qc.reco_recalibrate') : t('qc.reco_good');
    m.style.marginTop = '12px';
    root.appendChild(m);
    if (archPct < RECONTROLE_MIN_RATE) {
      root.appendChild(bigButton('fiche.arch_h', null, () => openOv(FICHES.arch)));
    }
    root.appendChild(bigButton('common.ok', null, async () => {
      recoState = null;
      closeOv();
      await goHome();
    }));
  });
}

/* ===================================================================
   ÉTAT DES DONNÉES (§2.3)
   =================================================================== */

function dline(k, v, cls) {
  const d = el('div', 'dl');
  d.appendChild(el('span', 'k', k));
  d.appendChild(el('span', 'v ' + (cls || ''), v));
  return d;
}

async function goData() {
  const { trees, rows, obs } = await refreshCounts();
  const byT = {};
  obs.forEach(o => {
    byT[o.terrain] = byT[o.terrain] || new Set();
    byT[o.terrain].add(o.arbre_id);
  });
  const rangs = await dbAll('rangs');
  const doneRows = rangs.filter(r => ['COMPLET', 'PARTIEL', 'ECART'].includes(r.statut)).length;

  let space = t('data.space_unknown');
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      if (e && e.quota) {
        space = Math.round((e.quota - (e.usage || 0)) / 1048576) + ' Mo';
      }
    }
  } catch (e) { /* laissé inconnu */ }

  const last = await metaGet('dernier_export', null);
  const box = $('datalist');
  box.innerHTML = '';
  box.appendChild(dline(t('data.total'), String(trees)));
  Object.keys(byT).sort().forEach(k => {
    box.appendChild(dline(t('data.by_terrain') + ' ' + k, String(byT[k].size), 'sm'));
  });
  box.appendChild(dline(t('data.observations'), String(rows), 'sm'));
  box.appendChild(dline(t('data.rows_done'), String(doneRows), 'sm'));
  box.appendChild(dline(t('data.last_export'),
    last ? new Date(last).toLocaleString() : t('common.never'),
    last && minutesSince(last) < EXPORT_ALERT_MIN ? 'sm ok' : 'sm ko'));
  box.appendChild(dline(t('data.free_space'), space, 'sm'));
  box.appendChild(dline(t('data.persist'), persistGranted ? t('common.yes') : t('common.no'),
    persistGranted ? 'ok' : 'ko'));
  box.appendChild(dline(t('data.campagne'), CAMPAGNE, 'sm'));
  box.appendChild(dline(t('data.version'), APP_VERSION, 'sm'));
  box.appendChild(dline(t('data.device'), PREF.deviceId + ' · ' + PREF.operateur, 'sm'));
  $('datamsg').innerHTML = '';
  show('scr-data');
}

function dataMsg(key, bad, vars) {
  const box = $('datamsg');
  box.innerHTML = '';
  const m = el('div', bad ? 'msg bad' : 'msg good');
  m.textContent = t(key, vars);
  box.appendChild(m);
}

/* Jeu de démonstration : 50 arbres sur un terrain fictif, pour éprouver
   l'export sans aller au champ. Il ne touche jamais T1/T2/T3 (§9). */
async function loadDemo() {
  const rng = (n) => Math.floor(Math.random() * n);
  const pick = (a) => a[rng(a.length)];
  const key = rangKey(DEMO_TERRAIN, 1);
  await dbPut('rangs', {
    key: key, terrain: DEMO_TERRAIN, rang: 1, positions_attendues: 50,
    longueur_m: 150, espacement_m: 3, porte_greffe: 'MM106', origine_position_1: '',
    a_verifier: false, statut: 'COMPLET', positions_reelles: 50, derniere_position: 50
  });
  const base = Date.now() - 50 * 60000;
  for (let p = 1; p <= 50; p++) {
    const etat = p % 17 === 0 ? 'MORT' : (p % 23 === 0 ? 'VIDE' : 'VIVANT');
    const alive = etat === 'VIVANT';
    const fruits = alive ? pick(['0', '1', '2', '3']) : null;
    const withFruit = fruits && fruits !== '0';
    const dur = 4 + rng(20);
    await dbPut('observations', {
      obs_id: uid(),
      arbre_id: arbreId(DEMO_TERRAIN, 1, p),
      rang_key: key, terrain: DEMO_TERRAIN, rang: 1, position: p,
      hors_plan: 'NON', passe: CAMPAGNE, version: 1, charge_mode: 'PALIER',
      etat: etat,
      autre_type: null, autre_fruit: null, espece: null,
      tronc: alive ? pick(['F', 'M', 'G']) : null,
      arch: alive ? pick(['A', 'B', 'C']) : null,
      fruits: fruits, fruits_bin: null,
      couleur: withFruit ? pick(['V', 'J', 'R']) : null,
      pourri: withFruit ? pick(['NON', 'OUI']) : null,
      ecorce: alive ? pick(['0', '1', '2', '3']) : null,
      arbre_complet: 'OUI',
      t_start: base + p * 40000,
      duree_saisie_s: dur,
      flag_qc: dur < FAST_ENTRY_S ? 'RAPIDE' : 'OK',
      horodatage_iso: new Date(base + p * 40000).toISOString(),
      operateur_label: PREF.operateur || 'DEMO',
      device_id: PREF.deviceId, app_version: APP_VERSION, langue_saisie: LANG,
      source: 'DEMO', media_ref: null
    });
  }
  await refreshCounts();
}

async function purgeDemo() {
  const all = await dbAll('observations');
  const demo = all.filter(o => o.source === 'DEMO');
  for (const o of demo) await dbDel('observations', o.obs_id);
  await dbDel('rangs', rangKey(DEMO_TERRAIN, 1));
  await refreshCounts();
  return demo.length;
}

async function exportPhotos() {
  const medias = (await dbAll('medias'));
  if (!medias.length) return dataMsg('data.no_photos', true);
  const colonnes = ['media_id', 'type', 'fichier', 'terrain', 'rang', 'position',
    'lat', 'lon', 'precision_m', 'horodatage_iso'];
  const lignes = [];
  for (const m of medias) {
    lignes.push([m.media_id, m.type, m.filename, m.terrain, m.rang, m.position,
      m.lat, m.lon,
      m.acc === null || m.acc === undefined ? null : Math.round(m.acc),
      m.horodatage_iso]);
    downloadBlob(m.filename, m.blob);
  }
  download('PHOTOS_' + (PREF.operateur || PREF.deviceId) + '_' + stampLocal() + '.csv',
    csvDocument(colonnes, lignes));
  dataMsg('fin.exported', false, { f: medias.length + ' + index' });
}

/* ===================================================================
   11. DÉMARRAGE
   =================================================================== */

function wireGroups() {
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (b) {
      const g = b.parentElement && b.parentElement.dataset.g;
      if (g) { onTap(g, b.dataset.v); return; }
    }
    const h = ev.target.closest('.help');
    if (h) { openOv(FICHES[h.dataset.fiche]); return; }
  });
}

function wireButtons() {
  $('ovclose').addEventListener('click', closeOv);
  $('whochange').addEventListener('click', () => {
    $('nameinput').value = PREF.operateur;
    show('scr-first');
  });
  $('gosetup').addEventListener('click', () => {
    if (!persistGranted || !pendingTerrain) return;
    goMission(pendingTerrain);
  });
  $('resumebtn').addEventListener('click', resumeSession);
  $('m-back').addEventListener('click', goHome);
  $('btn-data').addEventListener('click', goData);
  $('btn-blanc').addEventListener('click', () => openOv(FICHES.blanc));
  $('btn-reco').addEventListener('click', openRecontrole);
  $('btn-train').addEventListener('click', openEntrainement);
  $('btn-ref').addEventListener('click', () => $('reffile').click());
  $('reffile').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
      const n = await importerReference(f);
      const rangs = await rangsEntrainement();
      toast('train.ref_ok', false, {
        n: n,
        rangs: rangs.map(r => r.terrain + '-R' + pad(r.rang, 2)).join(' · ') || '—'
      });
    } catch (e) {
      toast('train.ref_ko', true);
    }
  });
  $('btn-exportall').addEventListener('click', async () => {
    const r = await exportAll();
    toast(r.ok ? 'fin.exported' : 'fin.export_failed', !r.ok, { f: r.name });
  });

  $('next').addEventListener('click', goNext);
  $('next3').addEventListener('click', goNext);
  $('prev').addEventListener('click', goPrev);
  $('prev3').addEventListener('click', goPrev);
  $('endrow').addEventListener('click', openEndRow);
  $('endrow3').addEventListener('click', openEndRow);

  $('d-back').addEventListener('click', goHome);
  $('d-export').addEventListener('click', async () => {
    const r = await exportAll();
    dataMsg(r.ok ? 'fin.exported' : 'fin.export_failed', !r.ok, { f: r.name });
    await goDataRefresh();
  });
  $('d-copy').addEventListener('click', async () => {
    const obs = await dbAll('observations');
    const csv = buildCsv(obs.sort((a, b) => a.arbre_id.localeCompare(b.arbre_id)), await statutMap());
    try {
      await navigator.clipboard.writeText(csv);
      await markExported();
      dataMsg('data.copied', false);
    } catch (e) {
      dataMsg('data.copy_failed', true);
    }
  });
  $('d-reset').addEventListener('click', async () => {
    const { trees } = await refreshCounts();
    openOv(root => {
      root.appendChild(el('h2', null, t('data.reset_h')));
      const m = el('div', 'msg bad');
      m.textContent = t('data.reset_warn', { n: trees });
      root.appendChild(m);
      root.appendChild(bigButton('data.reset_confirm', null, async () => {
        await reinitialiserCampagne();
        closeOv();
        dataMsg('data.reset_done', false);
        await goDataRefresh();
      }, 'border-color:var(--red);color:var(--red)'));
      root.appendChild(bigButton('common.cancel', null, closeOv));
    });
  });
  $('d-verif').addEventListener('click', async () => {
    const r = await verifierFormatExport();
    openOv(root => {
      root.appendChild(el('h2', null, t('data.verif_h')));
      r.controles.forEach(([nom, ok]) => {
        const d = el('div', 'dl');
        d.appendChild(el('span', 'k', nom));
        d.appendChild(el('span', 'v ' + (ok ? 'ok' : 'ko'), ok ? '✓' : '✗'));
        root.appendChild(d);
      });
      const m = el('div', r.ok ? 'msg good' : 'msg bad');
      m.textContent = r.ok ? t('data.verif_ok') : t('data.verif_ko');
      m.style.marginTop = '12px';
      root.appendChild(m);
    });
  });
  $('d-photos').addEventListener('click', exportPhotos);
  $('d-demo').addEventListener('click', () => {
    openOv(root => {
      root.appendChild(el('h2', null, t('data.demo')));
      const m = el('div', 'msg');
      m.textContent = t('data.demo_confirm');
      root.appendChild(m);
      root.appendChild(bigButton('common.yes', null, async () => {
        await loadDemo();
        closeOv();
        dataMsg('data.demo_done', false);
        await goDataRefresh();
      }, 'border-color:var(--green);color:var(--green)'));
      root.appendChild(bigButton('common.cancel', null, closeOv));
    });
  });
  $('d-purge').addEventListener('click', async () => {
    const n = await purgeDemo();
    dataMsg('data.purge_done', false, { n: n });
    await goDataRefresh();
  });
  $('persistretry').addEventListener('click', askPersist);
  window.addEventListener('resize', () => fitAll());
}

async function goDataRefresh() {
  const msg = $('datamsg').innerHTML;
  await goData();
  $('datamsg').innerHTML = msg;
}

/* Le chronomètre est purement visuel ; la durée réelle est calculée à
   l'écriture, pas lue ici. */
function startClock() {
  setInterval(() => {
    if (!session) return;
    const s = Math.floor((Date.now() - t0) / 1000);
    const v = pad(Math.floor(s / 60), 2) + ':' + pad(s % 60, 2);
    const a = $('clock'), b = $('clock3');
    if (a) a.textContent = v;
    if (b) b.textContent = v;
  }, 250);
  setInterval(paintSaveBar, 20000);
}

async function boot() {
  try {
    await loadStrings();
  } catch (e) {
    /* Sans strings.json aucune phrase n'est disponible, pas même le message
       d'erreur. On l'écrit dans les deux langues, en dur, une seule fois. */
    document.body.innerHTML = '<div style="padding:24px;color:#fff;font:700 15px sans-serif">'
      + 'strings.json introuvable — recharge la page une fois en ligne.<br><br>'
      + 'strings.json missing — reload the page once while online.</div>';
    return;
  }
  document.documentElement.lang = LANG.toLowerCase();
  applyStatic();
  markGroup('lang', LANG);
  wireGroups();
  wireButtons();
  initFirstRun();
  initT3();
  startClock();

  try {
    db = await openDB();
  } catch (e) {
    document.body.innerHTML = '<div class="msg bad" style="margin:20px">' + t('err.db') + '</div>';
    return;
  }

  await askPersist();

  try {
    await loadRegistry();
  } catch (e) {
    toast('err.registry', true);
  }

  await migrerPasseNumerique();

  await refreshCounts();

  const done = await metaGet('first_run_done', false);
  if (!done || !PREF.operateur) {
    show('scr-first');
  } else {
    await goHome();
  }

  if ('serviceWorker' in navigator) {
    /* updateViaCache: 'none' — le script du service worker lui-même ne doit
       jamais venir du cache HTTP, sinon une correction resterait invisible
       jusqu'à l'expiration du max-age. */
    navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' })
      .then(reg => reg.update())
      .catch(() => { /* hors ligne : la version en cache fait le travail */ });
  }
}

function renderDynamic() {
  if (session) {
    if (isT3()) paintTree3(); else paintTree();
  }
  paintSaveBar();
  if ($('scr-home') && !$('scr-home').classList.contains('hidden')) {
    $('whoname').textContent = PREF.operateur;
    rangsOf('T1').then(r => { $('t1sub').textContent = t('setup.t1s', { n: r.length }); });
    rangsOf('T2').then(r => { $('t2sub').textContent = t('setup.t2s', { n: r.length }); });
    metaGet('session', null).then(s => {
      if (s) $('resumewhere').textContent =
        t('setup.resume_at', { t: s.terrain, r: pad(s.rang, 2), p: s.position });
    });
  }
  if (!$('scr-mission').classList.contains('hidden') && pendingTerrain) goMission(pendingTerrain);
  if (!$('scr-data').classList.contains('hidden')) goData();
  if (ovCurrent && $('ov').classList.contains('show')) {
    const r = ovCurrent;
    $('ovb').innerHTML = '';
    r($('ovb'));
    fitAll($('ov'));
  }
}

boot();

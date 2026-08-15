#!/usr/bin/env node
/* check-strings.js — barrière avant déploiement (§3).
 *
 *   node check-strings.js
 *
 * Sort avec le code 1 si :
 *   - une clé manque en français ou en anglais, ou est vide ;
 *   - une clé référencée par index.html ou app.js n'existe pas ;
 *   - strings.json porte un BOM (il est lu par fetch, pas par Excel) ;
 *   - les marqueurs {xxx} d'une langue ne sont pas ceux de l'autre.
 *
 * Ce dernier point attrape l'erreur discrète : traduire « {n} arbres » par
 * « trees planned » sans le marqueur produit un écran vide de son chiffre,
 * sans lever la moindre exception au champ.
 *
 * Un équivalent Python — check_strings.py — est livré à côté : il donne
 * exactement le même verdict, pour les postes sans Node.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LANGS = ['fr', 'en', 'ru'];
const errors = [];
const warnings = [];

/* --- 1. lecture ------------------------------------------------------- */

const raw = fs.readFileSync(path.join(ROOT, 'strings.json'));
if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
  errors.push('strings.json commence par un BOM — il doit être en UTF-8 sans BOM.');
}

let dict;
try {
  dict = JSON.parse(raw.toString('utf8'));
} catch (e) {
  console.error('strings.json illisible : ' + e.message);
  process.exit(1);
}

const keys = Object.keys(dict).filter(k => k !== '_comment');

/* --- 2. complétude des deux langues ----------------------------------- */

for (const k of keys) {
  const entry = dict[k];
  if (typeof entry !== 'object' || entry === null) {
    errors.push('« ' + k + ' » n\'est pas un objet { fr, en }.');
    continue;
  }
  for (const l of LANGS) {
    if (!(l in entry)) errors.push('« ' + k + ' » n\'a pas de traduction ' + l + '.');
    else if (typeof entry[l] !== 'string' || entry[l].trim() === '') {
      errors.push('« ' + k +' » a une traduction ' + l + ' vide.');
    }
  }
}

/* --- 3. cohérence des marqueurs {xxx} --------------------------------- */

const placeholders = (s) => (String(s).match(/\{[a-z0-9_]+\}/gi) || []).sort().join(',');

/* Le français fait référence : chaque langue doit porter exactement les mêmes
   marqueurs. Une traduction qui perd son {n} affiche un écran privé de son
   chiffre, sans lever la moindre exception au champ. */
for (const k of keys) {
  const e = dict[k];
  if (!e || typeof e !== 'object') continue;
  if (!LANGS.every(l => typeof e[l] === 'string')) continue;
  const ref = placeholders(e.fr);
  for (const l of LANGS) {
    if (l === 'fr') continue;
    const got = placeholders(e[l]);
    if (got !== ref) {
      errors.push('« ' + k + ' » : marqueurs différents — fr [' + ref
        + '] contre ' + l + ' [' + got + '].');
    }
  }
}

/* --- 4. clés référencées par le code ----------------------------------- */

const namespaces = new Set(keys.map(k => k.split('.')[0]));
const used = new Set();

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const m of html.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)) used.add(m[1]);

/* Dans app.js les clés arrivent aussi comme arguments littéraux
   (bigButton, toast, dataMsg, figure…), pas seulement dans t('…').
   On relève donc tout littéral ayant la forme d'une clé, et on ne retient
   que ceux dont l'espace de noms existe — « strings.json » ou « app.js »
   ont la même forme mais ne sont pas des clés. */
const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
for (const m of js.matchAll(/'([a-z0-9_]+\.[a-z0-9_]+)'/g)) {
  const cand = m[1];
  if (namespaces.has(cand.split('.')[0])) used.add(cand);
  else warnings.push('littéral « ' + cand + ' » ignoré : espace de noms inconnu.');
}

for (const k of used) {
  if (!keys.includes(k)) errors.push('clé « ' + k + ' » utilisée par le code mais absente de strings.json.');
}

/* --- 5. clés jamais utilisées : signalé, pas bloquant ------------------ */

for (const k of keys) {
  if (!used.has(k)) warnings.push('clé « ' + k + ' » définie mais jamais utilisée.');
}

/* --- 6. verdict -------------------------------------------------------- */

console.log(keys.length + ' clés · ' + used.size + ' référencées par le code');

if (warnings.length) {
  console.log('\n' + warnings.length + ' avertissement(s) :');
  warnings.forEach(w => console.log('  · ' + w));
}

if (errors.length) {
  console.error('\n' + errors.length + ' ERREUR(S) — déploiement interdit :');
  errors.forEach(e => console.error('  ✗ ' + e));
  process.exit(1);
}

console.log('\nOK — les ' + LANGS.length + ' langues sont complètes et cohérentes.');
process.exit(0);

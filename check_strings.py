#!/usr/bin/env python3
"""check_strings.py — equivalent exact de check-strings.js, pour les postes
sans Node. Meme verdict, meme code de sortie.

    python check_strings.py

La specification demande check-strings.js ; ce jumeau existe parce que le
poste de deploiement de ce projet a Python mais pas Node, et qu'une barriere
qu'on ne peut pas executer ne protege rien.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
LANGS = ("fr", "en")
errors = []
warnings = []

# --- 1. lecture -----------------------------------------------------------

with open(os.path.join(ROOT, "strings.json"), "rb") as f:
    raw = f.read()

if raw[:3] == b"\xef\xbb\xbf":
    errors.append("strings.json commence par un BOM — il doit etre en UTF-8 sans BOM.")

try:
    dico = json.loads(raw.decode("utf-8"))
except Exception as e:                                    # noqa: BLE001
    print("strings.json illisible : %s" % e, file=sys.stderr)
    sys.exit(1)

keys = [k for k in dico if k != "_comment"]

# --- 2. completude des deux langues ---------------------------------------

for k in keys:
    entry = dico[k]
    if not isinstance(entry, dict):
        errors.append("« %s » n'est pas un objet { fr, en }." % k)
        continue
    for l in LANGS:
        if l not in entry:
            errors.append("« %s » n'a pas de traduction %s." % (k, l))
        elif not isinstance(entry[l], str) or not entry[l].strip():
            errors.append("« %s » a une traduction %s vide." % (k, l))

# --- 3. coherence des marqueurs {xxx} -------------------------------------

PH = re.compile(r"\{[A-Za-z0-9_]+\}")


def placeholders(s):
    return ",".join(sorted(PH.findall(str(s))))


for k in keys:
    e = dico[k]
    if not isinstance(e, dict):
        continue
    if not all(isinstance(e.get(l), str) for l in LANGS):
        continue
    a, b = placeholders(e["fr"]), placeholders(e["en"])
    if a != b:
        errors.append(
            "« %s » : marqueurs differents entre les langues — fr [%s] contre en [%s]." % (k, a, b)
        )

# --- 4. cles referencees par le code --------------------------------------

namespaces = {k.split(".")[0] for k in keys}
used = set()

with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
    html = f.read()
for m in re.finditer(r'data-i18n(?:-ph)?="([^"]+)"', html):
    used.add(m.group(1))

with open(os.path.join(ROOT, "app.js"), encoding="utf-8") as f:
    js = f.read()
for m in re.finditer(r"'([a-z0-9_]+\.[a-z0-9_]+)'", js):
    cand = m.group(1)
    if cand.split(".")[0] in namespaces:
        used.add(cand)
    else:
        warnings.append("litteral « %s » ignore : espace de noms inconnu." % cand)

for k in sorted(used):
    if k not in keys:
        errors.append("cle « %s » utilisee par le code mais absente de strings.json." % k)

# --- 5. cles jamais utilisees : signale, pas bloquant ---------------------

for k in keys:
    if k not in used:
        warnings.append("cle « %s » definie mais jamais utilisee." % k)

# --- 6. verdict ------------------------------------------------------------

print("%d cles · %d referencees par le code" % (len(keys), len(used)))

if warnings:
    print("\n%d avertissement(s) :" % len(warnings))
    for w in warnings:
        print("  · %s" % w)

if errors:
    print("\n%d ERREUR(S) — deploiement interdit :" % len(errors), file=sys.stderr)
    for e in errors:
        print("  x %s" % e, file=sys.stderr)
    sys.exit(1)

print("\nOK — les deux langues sont completes et coherentes.")
sys.exit(0)

#!/usr/bin/env python3
"""merge.py — fusion des exports ORCHARD-SCAN.

    python merge.py <dossier_des_csv> [-o <dossier_de_sortie>]

Lit tous les .csv d'un dossier — typiquement deux appareils x ~88 fichiers de
fin de rang, plus les exports complets — et produit :

    consolide_<horodatage>.csv   une ligne par arbre par passe, dedoublonnee
    doublons.csv                 les saisies ecartees, conservees telles quelles
    liste_taille_2026-27.csv     la feuille du tailleur, un bloc par rang

Regle de dedoublonnage (§9) : la cle est arbre_id + passe, la saisie la plus
recente gagne. Les perdantes ne sont pas jetees : elles vont dans doublons.csv,
parce que le cas qui produit un doublon — un rang refait apres une pause mal
reprise — est justement celui ou l'on veut pouvoir verifier ce qui a ete
ecrase.

Sur le format : la premiere ligne des fichiers d'entree est « sep=; », une
instruction qu'Excel interprete pour forcer le decoupage en colonnes quelle
que soit la locale du poste. Elle est sautee a la lecture et reecrite a
l'ecriture. Le BOM UTF-8 suit le meme chemin. Sans ces deux details, le
fichier s'ouvre en une seule colonne ou avec des accents corrompus, et il
est inutilisable pour l'analyste comme pour l'operateur.

Ce script ne fait aucune imputation et ne corrige aucune valeur : il fusionne.
"""
import argparse
import csv
import datetime as dt
import os
import sys
from collections import defaultdict

SEP = ";"
SEP_LINE = "sep=;"
ENC_IN = "utf-8-sig"      # avale le BOM s'il est la
ENC_OUT = "utf-8-sig"     # le remet : Excel en a besoin

# Colonnes minimales attendues. Le script reste pilote par l'en-tete reel des
# fichiers : toute colonne supplementaire est conservee et repositionnee a la
# fin, de sorte qu'ajouter un champ dans l'application ne casse pas la fusion.
CLE = ("arbre_id", "passe")
TRI = ("terrain", "rang", "position", "passe")

# Ni le jeu de demonstration, ni les saisies d'entrainement ne doivent
# atteindre l'analyste. Les secondes portent sur de vrais arbres, mais elles
# ont ete faites par quelqu'un qui apprend, sur des rangs deja releves : les
# compter reviendrait a ecraser le travail de l'operateur experimente.
TERRAIN_DEMO = "TD"
SOURCES_EXCLUES = ("DEMO", "ENTRAINEMENT")


def lire_csv(chemin):
    """Renvoie (entetes, lignes). Saute la ligne sep=; si elle est presente."""
    with open(chemin, "r", encoding=ENC_IN, newline="") as f:
        premiere = f.readline()
        if premiere.strip().lower() != SEP_LINE:
            f.seek(0)                       # fichier sans directive : on repart du debut
        lecteur = csv.DictReader(f, delimiter=SEP)
        entetes = lecteur.fieldnames or []
        lignes = [dict(r) for r in lecteur]
    return entetes, lignes


def ecrire_csv(chemin, entetes, lignes):
    with open(chemin, "w", encoding=ENC_OUT, newline="") as f:
        f.write(SEP_LINE + "\r\n")
        w = csv.DictWriter(f, fieldnames=entetes, delimiter=SEP,
                           lineterminator="\r\n", extrasaction="ignore")
        w.writeheader()
        for l in lignes:
            w.writerow({k: l.get(k, "NULL") for k in entetes})


def entier(v, defaut=0):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return defaut


def horodatage(ligne):
    """Cle de recence. Un horodatage illisible perd contre n'importe quel
    horodatage valide, mais ne fait pas tomber la fusion."""
    v = (ligne.get("horodatage_iso") or "").strip()
    try:
        return dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return dt.datetime.min.replace(tzinfo=dt.timezone.utc)


def recence(ligne):
    """Plus recent d'abord : horodatage, puis version, pour departager deux
    saisies enregistrees dans la meme seconde."""
    h = horodatage(ligne)
    if h.tzinfo is None:
        h = h.replace(tzinfo=dt.timezone.utc)
    return (h, entier(ligne.get("version"), 0))


def cle_tri(ligne):
    # `passe` est un identifiant de campagne (ETE_2026), pas un entier :
    # il se trie comme une chaine. Le numero de revision, lui, est `version`.
    return (
        str(ligne.get("terrain", "")),
        entier(ligne.get("rang"), 0),
        entier(ligne.get("position"), 0),
        str(ligne.get("passe", "")),
    )


def fusionner(dossier):
    fichiers = sorted(
        os.path.join(dossier, n) for n in os.listdir(dossier)
        if n.lower().endswith(".csv")
        and not n.lower().startswith(("consolide", "doublons", "liste_taille"))
    )
    if not fichiers:
        print("Aucun .csv dans %s" % dossier, file=sys.stderr)
        sys.exit(1)

    entetes = []
    toutes = []
    exclues = {s: 0 for s in SOURCES_EXCLUES}

    for chemin in fichiers:
        try:
            h, lignes = lire_csv(chemin)
        except Exception as e:                                   # noqa: BLE001
            print("  ! %-44s illisible : %s" % (os.path.basename(chemin), e))
            continue
        for col in h:
            if col not in entetes:
                entetes.append(col)
        gardees = 0
        for l in lignes:
            if not (l.get("arbre_id") or "").strip():
                continue
            src = (l.get("source") or "").strip()
            if l.get("terrain") == TERRAIN_DEMO:
                exclues["DEMO"] += 1
                continue
            if src in SOURCES_EXCLUES:
                exclues[src] += 1
                continue
            l["_fichier"] = os.path.basename(chemin)
            toutes.append(l)
            gardees += 1
        print("  · %-44s %5d ligne(s)" % (os.path.basename(chemin), gardees))

    if not toutes:
        print("Aucune ligne exploitable.", file=sys.stderr)
        sys.exit(1)

    groupes = defaultdict(list)
    for l in toutes:
        groupes[(l.get("arbre_id"), l.get("passe"))].append(l)

    retenues, doublons = [], []
    for _, groupe in groupes.items():
        groupe.sort(key=recence, reverse=True)
        retenues.append(groupe[0])
        doublons.extend(groupe[1:])

    retenues.sort(key=cle_tri)
    doublons.sort(key=cle_tri)
    return entetes, retenues, doublons, exclues, len(fichiers)


# --------------------------------------------------------------------------
# Liste de taille — le livrable qui rend le screening utile en hiver.
# --------------------------------------------------------------------------

# arch_code 1 = B = moins de 3 branches  -> restructurer cet hiver
# arch_code 2 = C = casse, fendu, couche -> rabattre ou arracher
ACTIONS = [("1", "restructurer"), ("2", "rabattre")]


def liste_taille(lignes):
    """Un bloc par rang et par action, trie par rang puis par position.

    Les rangs PARTIEL sont conserves : ils sont exclus des calculs de taux,
    pas du travail de taille — un arbre a restructurer le reste meme si le
    rang n'a pas ete fini.
    """
    par_rang = defaultdict(lambda: defaultdict(list))
    for l in lignes:
        code = (l.get("arch_code") or "").strip()
        for attendu, action in ACTIONS:
            if code == attendu:
                rang = "%s-R%02d" % (l.get("terrain", "?"), entier(l.get("rang"), 0))
                par_rang[rang][action].append(entier(l.get("position"), 0))

    sorties = []
    for rang in sorted(par_rang, key=lambda r: (r.split("-R")[0], entier(r.split("-R")[1]))):
        for _, action in ACTIONS:
            positions = sorted(set(par_rang[rang].get(action, [])))
            if not positions:
                continue
            n = len(positions)
            sorties.append({
                "rang": rang,
                "action": action,
                "positions": ("position " if n == 1 else "positions ")
                             + ", ".join(str(p) for p in positions),
                "nb_arbres": "%d %s" % (n, "arbre" if n == 1 else "arbres"),
            })
    return sorties


def ecrire_liste_taille(chemin, sorties):
    with open(chemin, "w", encoding=ENC_OUT, newline="") as f:
        f.write(SEP_LINE + "\r\n")
        w = csv.writer(f, delimiter=SEP, lineterminator="\r\n")
        w.writerow(["rang", "action", "positions", "nb_arbres"])
        for s in sorties:
            w.writerow([s["rang"], s["action"], s["positions"], s["nb_arbres"]])


# --------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(description="Fusionne les exports ORCHARD-SCAN.")
    ap.add_argument("dossier", help="dossier contenant les .csv exportes")
    ap.add_argument("-o", "--sortie", default=None, help="dossier de sortie (defaut : le meme)")
    args = ap.parse_args()

    if not os.path.isdir(args.dossier):
        print("Dossier introuvable : %s" % args.dossier, file=sys.stderr)
        sys.exit(1)
    sortie = args.sortie or args.dossier
    os.makedirs(sortie, exist_ok=True)

    print("Lecture de %s" % os.path.abspath(args.dossier))
    entetes, retenues, doublons, exclues, nb_fichiers = fusionner(args.dossier)

    if "_fichier" not in entetes:
        entetes.append("_fichier")

    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M")
    f_cons = os.path.join(sortie, "consolide_%s.csv" % stamp)
    f_doub = os.path.join(sortie, "doublons.csv")
    f_tail = os.path.join(sortie, "liste_taille_2026-27.csv")

    ecrire_csv(f_cons, entetes, retenues)
    ecrire_csv(f_doub, entetes, doublons)
    taille = liste_taille(retenues)
    ecrire_liste_taille(f_tail, taille)

    # --- rapport ---------------------------------------------------------
    arbres = {l.get("arbre_id") for l in retenues}
    par_terrain = defaultdict(set)
    for l in retenues:
        par_terrain[l.get("terrain", "?")].add(l.get("arbre_id"))
    incomplets = sum(1 for l in retenues if (l.get("arbre_complet") or "").upper() == "NON")
    rapides = sum(1 for l in retenues if "RAPIDE" in (l.get("flag_qc") or ""))
    partiels = {l.get("terrain", "?") + "-R%02d" % entier(l.get("rang"), 0)
                for l in retenues if (l.get("rang_statut") or "") == "PARTIEL"}
    hors_plan = sum(1 for l in retenues if (l.get("hors_plan") or "").upper() == "OUI")

    print("")
    print("  fichiers lus .................. %d" % nb_fichiers)
    print("  lignes retenues ............... %d" % len(retenues))
    print("  arbres distincts .............. %d" % len(arbres))
    for terrain in sorted(par_terrain):
        print("      %-4s ...................... %d" % (terrain, len(par_terrain[terrain])))
    print("  doublons ecartes .............. %d" % len(doublons))
    for src, n in sorted(exclues.items()):
        if n:
            print("  lignes %-13s exclues .. %d" % (src.lower(), n))
    print("  arbres incomplets ............. %d" % incomplets)
    print("  saisies sous 4 s (RAPIDE) ..... %d" % rapides)
    print("  arbres hors plan .............. %d" % hors_plan)
    print("  rangs PARTIEL (hors taux) ..... %d" % len(partiels))
    if partiels:
        print("      %s" % ", ".join(sorted(partiels)))
    print("  blocs de taille ............... %d" % len(taille))
    print("")
    print("  -> %s" % f_cons)
    print("  -> %s" % f_doub)
    print("  -> %s" % f_tail)


if __name__ == "__main__":
    main()

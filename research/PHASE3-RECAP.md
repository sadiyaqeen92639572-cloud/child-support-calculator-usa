# Phase 3 — Récapitulatif (session du 2026-07-13)

50 états + DC désormais shippés (51/51). Cette session a couvert les 20 derniers : Kansas, Alaska, Arkansas, Connecticut, Idaho, Maine, Massachusetts, Mississippi, Nebraska, New Hampshire, New Mexico, North Dakota, Oklahoma, Rhode Island, South Dakota, Utah, Vermont, West Virginia, Wyoming, District of Columbia.

Détail source/vérif par état : `research/sourcing-tracker.csv` et `research/verification-log.csv`.

## Nouveaux modèles de calcul ajoutés au moteur

- **Kansas** (`ks_age_schedule`) — barème différencié par âge d'enfant (0-5/6-11/12-18), une des trois structures inédites.
- **Idaho** (`id_bracket_shares`), **Wyoming** (`wy_bracket_shares`) — formules à tranches marginales (façon barème d'impôt) plutôt que table de lookup.
- **North Dakota** (`nd_obligor_schedule`) — barème basé uniquement sur le revenu du parent débiteur (pas de partage de revenus).
- **Utah** (`ut_low_income_or_shares`) — double table (table principale + table bas-revenus indexée sur le revenu individuel).
- **Maine**, **DC** (`me_weekly_table_annual_income`, `dc_annual_shares`) — axes annuels/hebdomadaires mélangés, conversion vers affichage mensuel.
- **Massachusetts** (`ma_table_a_shares`) — formule algébrique exacte rétro-extraite du script JS live d'un formulaire XFA (le PDF imprimé donnait une fausse impression de simple barème).

## Erreurs détectées et corrigées (pas dans notre code — dans les sources officielles elles-mêmes)

- **Idaho** : le barème 4-enfants publié était incohérent avec le plafond de revenu combiné de tous les autres barèmes ; corrigé par extrapolation cohérente, écart documenté.
- **District of Columbia** : deux erreurs de frappe à un chiffre dans le barème officiel publié (valeurs aberrantes comparées aux lignes voisines) ; corrigées par interpolation, documentées dans le schedule JSON.
- **New Hampshire** : un résumé IA de recherche web citait un mauvais montant de self-support reserve ; vérifié et corrigé contre le document PDF officiel.
- **Wyoming** : un résumé IA affirmait un montant de base erroné à revenu combiné $5000 ; recalculé à la main depuis le texte de loi et confirmé faux, écarté.

## Limites connues / ce qui n'a pas été modélisé

Ce ne sont pas des tâches "à finir" au sens strict — ce sont des cas volontairement exclus car ils nécessitent une mécanique de calcul entièrement différente (garde partagée réelle, garde alternée, etc.), documentés dans le `deviation_note` de chaque état :

- **Garde partagée / shared custody avec formule dédiée non modélisée** dans plusieurs états où le mécanisme diffère trop du cas standard (ex: Massachusetts Worksheet B, Utah joint physical custody, West Virginia Extended Shared Parenting, DC Worksheet B, Vermont Shared/Split Custody).
- **Ajustements discrétionnaires** (déviations judiciaires, imputation de revenu, dettes matrimoniales, etc.) — jamais modélisés nulle part sur le site par design, seulement le montant présomptif.
- **Tables/paliers secondaires simplifiés** : ex. DC a une deuxième couche de "modified self-support reserve" (16-916.01(g-2)) non implémentée — seule la réserve standard + minimum présomptif de $75/mois sont modélisés.
- **Certaines tables basses résolution / anchors au lieu du barème complet** quand la source primaire n'était disponible qu'en image scannée (ex. Kansas, Rhode Island) — interpolation entre points d'ancrage réels plutôt que ligne par ligne exacte. Écart typique de quelques dollars, jamais inventé.

## Limites techniques rencontrées pendant la session

- Plusieurs sites officiels d'État bloquent l'accès direct (WAF/403) : contournés systématiquement via Wayback Machine, avec vérification que le snapshot n'est pas périmé (comparaison de date d'entrée en vigueur, parfois cross-check avec une re-capture fraîche).
- Deux PDFs de formulaires étaient des formulaires XFA/LiveCycle dynamiques (Massachusetts) illisibles par extraction de texte standard — contournés via extraction du paquet XFA et lecture du JavaScript de calcul embarqué.
- Plusieurs tables étaient uniquement disponibles en image scannée sans couche de texte (Kansas, Rhode Island, Iowa lors des sessions précédentes) — transcription manuelle via lecture d'image, à résolution réduite (points d'ancrage) plutôt qu'exhaustive vu le volume.

## Prochaines étapes possibles (pas des blocages, juste des suites logiques)

- Revue quadriennale à venir pour plusieurs états (ex. Rhode Island, révision 2027) — dates à surveiller pour re-vérification.
- Connecticut a une refonte des guidelines prévue au 2026-08-01 (nouveau barème 3-parents, plafond de revenu relevé) — non reflétée, à reprendre après cette date.
- Ajout éventuel des mécanismes de garde partagée/dédiés non modélisés, si demandé — nécessiterait du nouveau code moteur par état, pas une simple correction de données.

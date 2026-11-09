# Panneau d'agent pour le Studio web (DGX AI-MPower)

Demande d'Amine (2026-11-09) : dialoguer avec l'IA depuis la plateforme (film.ai-mpower.com), sans terminal, en
économisant les ressources. Constat : dans OpenFilm, le chat d'agent n'existe que dans l'application de bureau (hors de
ce dépôt) ; le Studio web n'a ni panneau d'agent ni panneau Media ouvert par défaut.

## Principe : fournir l'hôte que Studio attend déjà

Studio lit `globalThis.openfilmHost` (`studio/ui/src/lib/host.ts`, interface `StudioHost`, version 1). L'application de
bureau le fournit ; nous le fournissons dans la page web, par un script injecté dans `index.html` au moment où Studio
sert la page. Rien à changer dans le cœur de Studio, et chaque nouvelle version amont garde le contrat.

Ce que l'hôte web implémente :

| Membre de `StudioHost` | Rôle dans le panneau web |
|---|---|
| `panel` (label, open, width, assets, setOpen, setWidth, setPlacement, onChange) | le panneau de conversation à gauche ; `assets` y loge le panneau Media (ce qui règle aussi le panneau Media invisible) |
| `refer`, `ask` | « Reference in chat » et ⌘L de Studio insèrent clips, calques, plages dans le message |
| `onSelection`, `onHover` | « @sélection courante », « @temps courant » |
| `useSkill`, `onCommand` | skills de la bibliothèque, commandes de Studio |
| `agents` (Settings → Agents) | l'agent du DGX, et son modèle |

## L'agent : sur le DGX, dans le dossier du projet

- Processus agent lancé par le serveur Studio pour un projet : CLI `openfilm` (skills edit, media, look, render), les
  fournisseurs DGX (voix, musique, sfx, image, vidéo LTX, transcription) et la recherche libre.
- Modèle : passerelle d'AI-MPower (LiteLLM), modèles locaux d'abord (DGX), payant seulement en repli et au choix
  d'Amine ; jamais de modèle imposé dans le code.
- Transport : WebSocket du serveur Studio (même origine, même contrôle de clé et d'origine que le reste), flux des
  messages, des appels d'outils et des fichiers changés ; le film se met à jour en direct dans Studio.
- Conversations persistées par projet (`.film/agent/`), reprises à la réouverture.
- Ressources : un seul agent actif par projet, conteneur ou processus plafonné en mémoire, travaux lourds (rendu,
  transcription, génération) en file d'attente un par un sur le DGX (incident du 2026-11-09).

## Étapes

1. Hôte web minimal : `panel` + `assets` (le panneau Media s'ouvre dans le panneau), vérifié dans un navigateur.
2. Route serveur `agent` (WebSocket) et processus agent dans le dossier du projet ; un message aller-retour prouvé (réalisée, voir plus bas).
3. Outils : le CLI `openfilm` complet ; premier cas réel, le montage « Projet Bouchra ».
4. `refer`, `ask`, `onSelection` ; Settings → Agents (modèle, passerelle).
5. File des travaux lourds et plafonds ; rendu vérifié de bout en bout.

## Réalisation de l'étape 2 (2026-11-09)

- L'agent n'est pas réécrit : c'est celui de l'application de bureau (Pi, `apps/desktop/src/pi-agent.mjs`, par sa classe
  `AgentSession`), du Node pur sans Electron, lancé par le serveur Studio (`studio/server/agent.mjs`) dans le dossier du
  projet, avec la commande `openfilm` en tête de son PATH et les compétences d'OpenFilm (edit, media, canvas).
- Transport : WebSocket `/api/projects/:id/agent`, derrière le même contrôle de clé et d'origine que les flux de Studio.
  Un agent par projet ; toutes les pages ouvertes sur le projet voient chaque tour ; un tour à la fois ; l'agent s'arrête
  après 15 minutes sans page ni travail, sa conversation reprise au démarrage suivant (`.film/agent/web.json`).
- Modèle : nommé par l'environnement (`OPENFILM_AGENT_BASE_URL`, `OPENFILM_AGENT_MODEL`, `OPENFILM_AGENT_NAME`,
  `OPENFILM_AGENT_VISION`), jamais par le code ; clé dans un fichier du volume (`/root/.openfilm/agent/litellm.key`),
  clé LiteLLM d'alias `openfilm-agent` bornée au seul modèle choisi (prouvé : 200 sur ce modèle, 403 sur un modèle payant).
- Modèle retenu : `qwen3.8-27b` (spark-550f, par la passerelle), appel d'outils prouvé. **Il ne lit pas les images**
  (le serveur répond « served with --vision » requis) : l'agent est déclaré texte seul (`input: ['text']`, ajouté à
  `pi-config.mjs`), Pi remplace alors chaque image par une mention. Mesuré le 2026-11-09 : les modèles locaux avec vision
  de la passerelle (`gemma4-26b-local`, `qwen2.5vl-7b-local`) échouent (Pillow absent du conteneur LiteLLM) ;
  `gemini-2.5-flash-lite` voit un carré rouge « bleu » ; `gemini-3.1-flash-lite` répond juste mais est payant.
- Sécurité, risque résiduel : Pi exécute `bash` sans bac à sable, en root dans le conteneur Studio (réseau de l'hôte).
  Ce qu'il peut lire de sensible se limite à la clé de Studio (dont il a besoin pour `openfilm`) et à sa propre clé
  bornée ; `providers.json` ne contient aucune clé (vérifié). Le risque restant est l'accès au réseau local depuis une
  commande, par exemple sur injection de consigne via une page lue par `openfilm get web-fetch`. L'accès à la page reste
  fermé par le mot de passe du relais et la clé de Studio.
- Demandes de permission et questions de l'agent : refusées pour l'instant (étape 4).

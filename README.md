# DigiArt

> Outil web personnel pour installations d'art interactif et projection mapping — des organismes virtuels vivants, intelligents, évolutifs et génératifs qui réagissent au geste, au son et à la lumière.

![status](https://img.shields.io/badge/status-alpha-orange)
![stack](https://img.shields.io/badge/stack-vite%20%2B%20react%20%2B%20three.js-blue)

## Fonctionnalités

- **4 espèces d'organismes** : boids, particules, tendrils, cellules
- **3 sens** : main (MediaPipe Hands), audio (FFT bass/mid/high), lumière ambiante (luminosité webcam)
- **Scene Composer** : palette, paramètres live, presets persistés (IndexedDB), export/import JSON
- **Projection mapping** : warping 4 coins + edge blend multi-projecteurs (shader WebGL)
- **Compagnon IA** : Claude (Anthropic) modifie ta scène à la voix (ou plutôt au prompt)
- **Sortie** : fullscreen, capture PNG, enregistrement WebM
- **PWA** : installable, partageable via URL

## Démarrage local

```bash
npm install
npm run dev
```

Ouvre `http://localhost:5173`. Active la caméra et le micro dans la barre du haut, puis joue.

## Configuration (Vercel KV + clés API)

DigiArt embarque une page **`/admin`** qui te permet de gérer toutes tes clés API (Anthropic, fal.ai, OpenAI, Replicate, ElevenLabs, Stability) **sans redéployer**. Les clés sont chiffrées AES-256-GCM avant d'être stockées dans Vercel KV (Upstash Redis).

### Étapes (une seule fois)

1. **Provisionne une base KV** : Vercel Dashboard → ton projet → **Storage** → **Create Database** → **KV**. Vercel injecte automatiquement `KV_REST_API_URL` et `KV_REST_API_TOKEN` dans les env vars du projet.
2. **Ajoute 2 secrets** :
   ```bash
   # Génère localement
   openssl rand -hex 32   # ENCRYPT_KEY  (chiffrement des clés API)
   openssl rand -hex 32   # JWT_SECRET   (signature des sessions)

   # Ajoute sur Vercel
   vercel env add ENCRYPT_KEY production
   vercel env add JWT_SECRET production
   vercel deploy --prod
   ```
3. **Ouvre `/admin`** : tu seras invité à créer ton compte admin (premier lancement), puis tu pourras coller toutes tes clés API dans la dashboard.

### Variables d'environnement résumées

| Variable | Obligatoire | Origine | Description |
|---|---|---|---|
| `KV_REST_API_URL` | oui | auto (Vercel KV) | URL REST Upstash |
| `KV_REST_API_TOKEN` | oui | auto (Vercel KV) | Token serveur |
| `ENCRYPT_KEY` | oui | manuel | 32+ caractères pour chiffrer les clés API |
| `JWT_SECRET` | oui | manuel | 16+ caractères pour signer les sessions |
| `ANTHROPIC_API_KEY` | non | fallback | Si configurée ici, prime sur l'admin si KV inaccessible |

Les clés API spécifiques aux providers (`ANTHROPIC_API_KEY`, `FAL_KEY`, …) **n'ont plus besoin d'être en env var** : tu les gères depuis `/admin`.

### Pourquoi Vercel KV (Upstash) et pas Supabase ?

- **Zéro service externe à créer** : 1 clic dans le dashboard Vercel.
- **Edge-natif** : REST API consommée directement depuis les Edge Functions, latence <30 ms.
- **Adapté au scope** : 1 admin + 6 clés API = 7 entrées. Pas besoin de SQL.
- **Free tier confortable** pour cet usage (lectures/écritures occasionnelles).

## Stack

- **Vite** + **React 19** + **TypeScript**
- **Three.js** (rendu)
- **MediaPipe Tasks Vision** (hand tracking, WASM dans le navigateur)
- **Web Audio API** (analyse FFT)
- **Zustand** (state)
- **IndexedDB** via `idb` (persistance locale)
- **Claude Sonnet** via Vercel Edge Function (`/api/claude.ts`)

## Architecture

```
src/
├── engine/           # Three.js stage, organismes, mapping shader
├── senses/           # SenseBus (refs) + Hands/Audio/Light
├── store/            # sceneStore Zustand
├── lib/              # persistence (idb), defaultScenes, recorder
├── types/            # Scene type
├── ui/               # Stage, SceneList, ParamPanel, TopBar, AIChat, MappingOverlay
└── admin/            # AdminPage, AdminLogin, AdminSetup, AdminDashboard

api/
├── claude.ts                # Compagnon IA (lit la clé depuis Vercel KV)
├── _lib/                    # kv (Upstash), crypto AES-GCM, auth PBKDF2 + JWT, settings
└── admin/
    ├── status.ts            # Health check (env vars + setup state)
    ├── setup.ts             # Création du compte admin (1er lancement)
    ├── login.ts | logout.ts | me.ts
    └── settings.ts          # GET/PUT des clés API chiffrées
```

## Concept

Chaque scène est un *vivarium numérique* : une espèce d'organismes avec des paramètres, une palette, des liaisons capteurs et — optionnellement — une calibration mapping. Tout est sérialisable en JSON (versionnable Git).

## Déploiement

Déployé sur Vercel : `vercel` puis `vercel --prod` (ou push sur main si l'intégration GitHub est branchée).

## Idées prochaines

- Compute shaders WebGPU pour 50k+ agents
- Évolution génétique réelle (mutation + sélection)
- Génération de textures par fal.ai SDXL Turbo (live img2img)
- Bridge OSC vers TouchDesigner / Resolume
- Multi-écran via Window Management API
- WebMIDI pour contrôleur physique

---

Construit avec amour par mounemus, accompagné de Claude.

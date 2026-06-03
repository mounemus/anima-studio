# Anima Studio

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

## Variables d'environnement (Vercel)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Clé API Anthropic pour le compagnon IA (`/api/claude`) |

Le compagnon IA est optionnel — l'outil fonctionne sans, tu n'auras juste pas le chat.

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
│   ├── Engine.ts
│   ├── MappingPass.ts
│   └── organisms/    # Boids, Particles, Tendrils, Cells
├── senses/           # SenseBus (refs) + Hands/Audio/Light
├── store/            # sceneStore Zustand
├── lib/              # persistence (idb), defaultScenes, recorder
├── types/            # Scene type
└── ui/               # Stage, SceneList, ParamPanel, TopBar, AIChat, MappingOverlay
api/
└── claude.ts         # Vercel edge function
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

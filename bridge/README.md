# Anima OSC bridge

A browser can't send/receive raw UDP, and OSC (Resolume, TouchDesigner, Ableton,
QLab, TouchOSC…) rides on UDP. This ~40-line relay bridges the gap:

```
Anima (navigateur) ──WebSocket(OSC binaire)──► bridge ──UDP──► Resolume / TD   (OUT)
Anima (navigateur) ◄─WebSocket(OSC binaire)── bridge ◄─UDP── Resolume / TD     (IN)
```

## Lancer

```bash
cd bridge
npm install ws     # unique dépendance
node osc-bridge.js
```

Puis dans Anima → onglet **Sens** → section **OSC** :
- URL : `ws://localhost:8080` → **Connecter**
- cocher **IN** (recevoir) et/ou **OUT** (émettre)

## Ports (défauts, surchargeables par variables d'env)

| Rôle | Port UDP | Sens |
|------|----------|------|
| `OSC_SEND_PORT` | **7000** | Anima → ton outil : configure l'**entrée OSC** de Resolume/TD sur ce port |
| `OSC_RECV_PORT` | **7001** | ton outil → Anima : fais **envoyer** l'OSC de ton outil vers ce port |
| `WS_PORT` | **8080** | WebSocket écouté par le pont (= l'URL dans Anima) |

Exemple avec des ports custom :

```bash
WS_PORT=8080 OSC_HOST=127.0.0.1 OSC_SEND_PORT=7000 OSC_RECV_PORT=7001 node osc-bridge.js
```

## Ce qu'Anima émet (OUT)

À ~30 Hz quand OUT est activé :

- `/anima/audio/level`, `/anima/audio/bass`, `/anima/audio/mid`, `/anima/audio/high` — floats 0..1
- `/anima/agents` — nombre d'agents
- `/anima/obstacle/<id>` — compteur de contacts par obstacle (organismes CPU)

## Ce qu'Anima reçoit (IN)

Toute adresse OSC entrante (ex. `/1/fader1`) devient une **source bindable** dans
l'onglet Sens → Bindings, sous le nom `osc:/1/fader1`. Mappe-la à n'importe quel
paramètre (vitesse, cohésion, feedback, angle de flux…) comme un CC MIDI.

## Exemple TouchDesigner

- **OSC In DAT** : port `7000` → reçoit `/anima/*`.
- **OSC Out DAT** : Network Port `7001`, address `127.0.0.1` → envoie vers Anima.

## Exemple Resolume

- Preferences → OSC → **Incoming port 7000** (reçoit d'Anima).
- Pour piloter Anima : configure une sortie OSC de Resolume vers `127.0.0.1:7001`.

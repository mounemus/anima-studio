#!/usr/bin/env python3
"""
Pont Leap Motion → UbDesigner Studio (MK178, v1.3).

Ultraleap Gemini / Hyperion ne servent plus le WebSocket « leapd » que les applications web
utilisaient. Ce script lit le capteur par LeapC (la DLL fournie avec le logiciel Leap) et
rediffuse chaque trame au format leapd v6.json sur ws://127.0.0.1:6437, exactement ce que
l'onglet Vision IA → Leap Motion du Studio attend.

Utilisation (Windows, Python 3.9+, module `websockets`) :
    py leap_bridge.py                 # port 6437, DLL trouvée automatiquement
    py leap_bridge.py --port 6438     # autre port (à reporter dans le champ « Adresse » du Studio)
    py leap_bridge.py --dll "C:\\chemin\\LeapC.dll"
    pip install websockets            # si le module manque

Pas de pyleap ni de LeapSDK à installer : les structures LeapC sont déclarées ici en ctypes
(LeapC.h 5.x). Un seul fichier, aucune dépendance autre que `websockets`.
"""
import argparse
import asyncio
import faulthandler
import ctypes as C
import json
import os
import sys
import threading
import time

# ───────────────────────────── LeapC (ctypes) ─────────────────────────────
DLL_CANDIDATES = [
    r"C:\Program Files\Ultraleap\LeapSDK\lib\x64\LeapC.dll",
    r"C:\Program Files\Ultraleap\Tracking\LeapC.dll",
    r"C:\Program Files\Ultraleap\Tracking\x64\LeapC.dll",
    r"C:\Program Files\Leap Motion\LeapSDK\lib\x64\LeapC.dll",
    r"C:\Program Files\Leap Motion\Core Services\LeapC.dll",
    r"C:\Program Files\Leap Motion\Core Services\VRVisualizer\VRVisualizer_Data\Plugins\LeapC.dll",
    r"C:\Program Files\Leap Motion\Core Services\VRVisualizer\VRVisualizer_Data\Plugins\x86_64\LeapC.dll",
]


def find_dll(explicit=None):
    cands = [explicit] if explicit else []
    cands += DLL_CANDIDATES
    for c in cands:
        if c and os.path.isfile(c):
            return c
    # dernier recours : parcours des dossiers Leap / Ultraleap
    for root in (r"C:\Program Files\Ultraleap", r"C:\Program Files\Leap Motion", r"C:\Program Files (x86)\Leap Motion"):
        for dp, _dn, fn in os.walk(root):
            if "LeapC.dll" in fn:
                return os.path.join(dp, "LeapC.dll")
    return None


# LeapC.h compacte ses structures (pas de remplissage 8 octets) : vérifié sur Gemini 5.0 avec LeapGetFrameSize
# (48 octets d'en-tête + 1084 par main). Sans ce _pack_, pHands était lu 4 octets trop loin → violation d'accès.
class _S(C.Structure):
    _pack_ = 4


class LEAP_VECTOR(_S):
    _fields_ = [("x", C.c_float), ("y", C.c_float), ("z", C.c_float)]

    def l(self):
        return [round(self.x, 2), round(self.y, 2), round(self.z, 2)]


class LEAP_QUATERNION(_S):
    _fields_ = [("x", C.c_float), ("y", C.c_float), ("z", C.c_float), ("w", C.c_float)]


class LEAP_BONE(_S):
    _fields_ = [("prev_joint", LEAP_VECTOR), ("next_joint", LEAP_VECTOR), ("width", C.c_float), ("rotation", LEAP_QUATERNION)]


class LEAP_DIGIT(_S):
    _fields_ = [("finger_id", C.c_int32), ("bones", LEAP_BONE * 4), ("is_extended", C.c_uint32)]


class LEAP_PALM(_S):
    _fields_ = [("position", LEAP_VECTOR), ("stabilized_position", LEAP_VECTOR), ("velocity", LEAP_VECTOR),
                ("normal", LEAP_VECTOR), ("width", C.c_float), ("direction", LEAP_VECTOR), ("orientation", LEAP_QUATERNION)]


class LEAP_HAND(_S):
    _fields_ = [("id", C.c_uint32), ("flags", C.c_uint32), ("type", C.c_int32), ("confidence", C.c_float),
                ("visible_time", C.c_uint64), ("pinch_distance", C.c_float), ("grab_angle", C.c_float),
                ("pinch_strength", C.c_float), ("grab_strength", C.c_float), ("palm", LEAP_PALM),
                ("digits", LEAP_DIGIT * 5), ("arm", LEAP_BONE)]


class LEAP_FRAME_HEADER(_S):
    _fields_ = [("reserved", C.c_void_p), ("frame_id", C.c_int64), ("timestamp", C.c_int64)]


class LEAP_TRACKING_EVENT(_S):
    # 24 + 8 + 4 + 8 + 4 = 48 octets, compacté : pHands à l'offset 36, framerate à 44
    _fields_ = [("info", LEAP_FRAME_HEADER), ("tracking_frame_id", C.c_int64), ("nHands", C.c_uint32),
                ("pHands", C.POINTER(LEAP_HAND)), ("framerate", C.c_float)]


class LEAP_CONNECTION_MESSAGE(_S):
    _fields_ = [("size", C.c_uint32), ("type", C.c_uint32), ("pointer", C.c_void_p), ("device_id", C.c_uint32)]


EV_CONNECTION, EV_CONNECTION_LOST, EV_DEVICE, EV_DEVICE_FAILURE, EV_POLICY = 1, 2, 3, 4, 5
EV_TRACKING, EV_DEVICE_LOST = 0x100, 0x104
POLICY_BACKGROUND_FRAMES = 0x1
RS_SUCCESS, RS_TIMEOUT = 0, 0xE0010003


class Leap:
    def __init__(self, dll_path):
        self.dll = C.CDLL(dll_path)
        d = self.dll
        d.LeapCreateConnection.argtypes = [C.c_void_p, C.POINTER(C.c_void_p)]
        d.LeapCreateConnection.restype = C.c_uint32
        d.LeapOpenConnection.argtypes = [C.c_void_p]
        d.LeapOpenConnection.restype = C.c_uint32
        d.LeapPollConnection.argtypes = [C.c_void_p, C.c_uint32, C.POINTER(LEAP_CONNECTION_MESSAGE)]
        d.LeapPollConnection.restype = C.c_uint32
        if hasattr(d, "LeapSetPolicyFlags"):
            d.LeapSetPolicyFlags.argtypes = [C.c_void_p, C.c_uint64, C.c_uint64]
            d.LeapSetPolicyFlags.restype = C.c_uint32
        if hasattr(d, "LeapGetFrameSize"):
            d.LeapGetFrameSize.argtypes = [C.c_void_p, C.c_int64, C.POINTER(C.c_uint64)]
            d.LeapGetFrameSize.restype = C.c_uint32
        self.h = C.c_void_p()
        rs = d.LeapCreateConnection(None, C.byref(self.h))
        if rs != RS_SUCCESS:
            raise RuntimeError("LeapCreateConnection a échoué (0x%08X)" % rs)
        rs = d.LeapOpenConnection(self.h)
        if rs != RS_SUCCESS:
            raise RuntimeError("LeapOpenConnection a échoué (0x%08X) : le service Leap tourne-t-il ?" % rs)

    def frame_size(self, timestamp):
        """Taille de la trame selon LeapC : sert à vérifier que nos structures ctypes collent à cette version."""
        if not hasattr(self.dll, "LeapGetFrameSize"):
            return None
        sz = C.c_uint64(0)
        return sz.value if self.dll.LeapGetFrameSize(self.h, timestamp, C.byref(sz)) == RS_SUCCESS else None

    def poll(self, timeout_ms=100):
        """Retourne ('tracking', LEAP_TRACKING_EVENT) | ('event', code) | None."""
        msg = LEAP_CONNECTION_MESSAGE()
        rs = self.dll.LeapPollConnection(self.h, timeout_ms, C.byref(msg))
        if rs == RS_TIMEOUT or rs != RS_SUCCESS:
            return None
        if msg.type == EV_TRACKING and msg.pointer:
            return ("tracking", C.cast(msg.pointer, C.POINTER(LEAP_TRACKING_EVENT)).contents)
        if msg.type == EV_CONNECTION and hasattr(self.dll, "LeapSetPolicyFlags"):
            self.dll.LeapSetPolicyFlags(self.h, POLICY_BACKGROUND_FRAMES, 0)   # trames même sans focus
        return ("event", msg.type)


# ───────────────────────────── LeapC → leapd v6.json ─────────────────────────────
INTERACTION_BOX = {"center": [0.0, 200.0, 0.0], "size": [235.247, 235.247, 147.751]}   # valeurs du LM-010 (V2)


def hand_to_json(h, frame_id):
    hands_json = {
        "id": int(h.id),
        "type": "left" if h.type == 0 else "right",
        "confidence": round(float(h.confidence), 3),
        "pinchStrength": round(float(h.pinch_strength), 3),
        "grabStrength": round(float(h.grab_strength), 3),
        "pinchDistance": round(float(h.pinch_distance), 1),
        "grabAngle": round(float(h.grab_angle), 3),
        "palmPosition": h.palm.position.l(),
        "stabilizedPalmPosition": h.palm.stabilized_position.l(),
        "palmVelocity": h.palm.velocity.l(),
        "palmNormal": h.palm.normal.l(),
        "palmWidth": round(float(h.palm.width), 1),
        "direction": h.palm.direction.l(),
        "wrist": h.arm.next_joint.l(),
        "elbow": h.arm.prev_joint.l(),
        "armWidth": round(float(h.arm.width), 1),
        "timeVisible": round(h.visible_time / 1e6, 3),
    }
    pointables = []
    for t in range(5):
        dg = h.digits[t]
        b = dg.bones   # 0 metacarpal, 1 proximal, 2 intermediate, 3 distal
        positions = [b[0].prev_joint.l(), b[1].prev_joint.l(), b[2].prev_joint.l(), b[3].prev_joint.l(), b[3].next_joint.l()]
        pointables.append({
            "id": int(h.id) * 10 + t, "handId": int(h.id), "type": t, "tool": False,
            "extended": bool(dg.is_extended),
            "tipPosition": positions[4], "stabilizedTipPosition": positions[4],
            "btipPosition": positions[4], "dipPosition": positions[3], "pipPosition": positions[2],
            "mcpPosition": positions[1], "carpPosition": positions[0],
            "positions": positions,
            "direction": [round(b[3].next_joint.x - b[3].prev_joint.x, 2), round(b[3].next_joint.y - b[3].prev_joint.y, 2), round(b[3].next_joint.z - b[3].prev_joint.z, 2)],
            "width": round(float(b[3].width), 1), "length": 0,
        })
    return hands_json, pointables


def frame_to_json(ev, fps):
    hands, pointables = [], []
    n = int(ev.nHands)
    if n:
        # Copie exacte de n × sizeof(LEAP_HAND) octets dans notre tampon : on ne lit jamais au-delà du tampon du service
        buf = (LEAP_HAND * n)()
        C.memmove(buf, ev.pHands, n * C.sizeof(LEAP_HAND))
        for i in range(n):
            hj, pj = hand_to_json(buf[i], ev.info.frame_id)
            hands.append(hj)
            pointables.extend(pj)
    return {
        "id": int(ev.info.frame_id), "timestamp": int(ev.info.timestamp),
        "currentFrameRate": round(float(fps), 1),
        "interactionBox": INTERACTION_BOX,
        "hands": hands, "pointables": pointables, "gestures": [], "devices": [],
        "r": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "s": 1.0, "t": [0, 0, 0],
    }


# ───────────────────────────── Serveur WebSocket ─────────────────────────────
class Bridge:
    def __init__(self, leap, max_hz=90):
        self.leap = leap
        self.clients = set()
        self.loop = None
        self.last_send = 0.0
        self.min_dt = 1.0 / max_hz
        self.stats = {"frames": 0, "sent": 0, "hands": 0, "fps": 0.0}
        self.stop = False
        self._fps_t0 = time.monotonic()
        self._fps_n = 0
        self._checked = False

    def reader(self):
        """Thread : lit LeapC et pousse les trames dans la boucle asyncio."""
        while not self.stop:
            r = self.leap.poll(100)
            if not r:
                continue
            kind, data = r
            if kind == "event":
                names = {EV_CONNECTION: "connexion au service", EV_CONNECTION_LOST: "service perdu", EV_DEVICE: "capteur détecté",
                         EV_DEVICE_FAILURE: "panne du capteur", EV_DEVICE_LOST: "capteur débranché", EV_POLICY: "politique appliquée"}
                if data in names:
                    print("[leap]", names[data], flush=True)
                continue
            self.stats["frames"] += 1
            self.stats["hands"] = int(data.nHands)
            now = time.monotonic()
            self._fps_n += 1
            if now - self._fps_t0 >= 1.0:
                self.stats["fps"] = self._fps_n / (now - self._fps_t0)
                self._fps_t0, self._fps_n = now, 0
            if data.nHands and not self._checked:
                # Autocontrôle à la première main : la taille annoncée par LeapC doit valoir en-tête + n × main
                self._checked = True
                sz = self.leap.frame_size(data.info.timestamp)
                exp = C.sizeof(LEAP_TRACKING_EVENT) + int(data.nHands) * C.sizeof(LEAP_HAND)
                if sz is not None and sz != exp:
                    print("[leap] ATTENTION : taille de trame %d ≠ attendue %d : structures LeapC différentes, données de mains suspectes" % (sz, exp), flush=True)
                else:
                    print("[leap] structures LeapC vérifiées (%d octets, %d main(s))" % (sz or exp, data.nHands), flush=True)
                try:
                    hj, pj = hand_to_json(data.pHands[0], data.info.frame_id)
                    print("[leap] première main : %s conf=%.2f pince=%.2f poing=%.2f paume=%s normale=%s doigts tendus=%d index=%s" % (
                        hj["type"], hj["confidence"], hj["pinchStrength"], hj["grabStrength"], hj["palmPosition"], hj["palmNormal"],
                        sum(1 for q in pj if q["extended"]), pj[1]["tipPosition"]), flush=True)
                except Exception as e:
                    print("[leap] lecture de la première main impossible :", repr(e), flush=True)
            if now - self.last_send < self.min_dt or not self.clients:
                continue
            self.last_send = now
            try:
                payload = json.dumps(frame_to_json(data, self.stats["fps"]), separators=(",", ":"))
            except Exception as e:
                if self.stats["frames"] % 300 == 0:
                    print("[leap] conversion de trame impossible :", repr(e), flush=True)
                continue
            if self.loop:
                self.loop.call_soon_threadsafe(self.broadcast, payload)

    def broadcast(self, payload):
        self.stats["sent"] += 1
        for ws in list(self.clients):
            try:
                asyncio.ensure_future(ws.send(payload))
            except Exception:
                self.clients.discard(ws)

    async def handler(self, ws):
        path = getattr(ws, "request", None)
        path = getattr(path, "path", None) or getattr(ws, "path", "?")
        self.clients.add(ws)
        print("[ws] client connecté", path, "(%d)" % len(self.clients), flush=True)
        try:
            await ws.send(json.dumps({"version": 6, "serviceVersion": "leap_bridge 1.3 (Gemini via LeapC)"}))
            async for msg in ws:   # messages de configuration leap.js : acceptés, sans effet
                try:
                    m = json.loads(msg)
                    if "focused" in m or "background" in m or "enableGestures" in m or "optimizeHMD" in m:
                        continue
                except Exception:
                    pass
        except Exception:
            pass
        finally:
            self.clients.discard(ws)
            print("[ws] client parti (%d)" % len(self.clients), flush=True)

    async def status(self):
        while not self.stop:
            await asyncio.sleep(5)
            s = self.stats
            print("[état] trames LeapC %d · envoyées %d · mains %d · %.0f i/s · clients %d" %
                  (s["frames"], s["sent"], s["hands"], s["fps"], len(self.clients)), flush=True)


async def main_async(args):
    try:
        import websockets
    except ImportError:
        print("Module manquant : lancez  pip install websockets", file=sys.stderr)
        sys.exit(2)
    dll = find_dll(args.dll)
    if not dll:
        print("LeapC.dll introuvable : installez le logiciel Ultraleap (Gemini/Hyperion) ou passez --dll <chemin>", file=sys.stderr)
        sys.exit(2)
    print("[leap] DLL :", dll, flush=True)
    leap = Leap(dll)
    bridge = Bridge(leap, max_hz=args.hz)
    bridge.loop = asyncio.get_running_loop()
    threading.Thread(target=bridge.reader, daemon=True).start()
    async with websockets.serve(bridge.handler, args.host, args.port, max_size=None, compression=None):
        print("[ws] pont prêt : ws://%s:%d/v6.json  (Studio → Vision IA → Leap Motion → Connecter)" % (args.host, args.port), flush=True)
        await bridge.status()


def main():
    faulthandler.enable()   # trace Python en cas de violation d'accès dans LeapC
    ap = argparse.ArgumentParser(description="Pont Leap Motion (LeapC) → WebSocket leapd v6.json pour UbDesigner Studio")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=6437)
    ap.add_argument("--hz", type=int, default=90, help="cadence maximale d'envoi (défaut 90)")
    ap.add_argument("--dll", default=None, help="chemin de LeapC.dll")
    args = ap.parse_args()
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\n[ws] pont arrêté")


if __name__ == "__main__":
    main()

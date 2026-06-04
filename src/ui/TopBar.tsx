import { useEffect, useState } from 'react'
import { Camera, Mic, Sun, Maximize2, MessageCircle, Video, ImageDown, Settings, Monitor, MonitorPlay, Music, ScanFace, Glasses, Clock, Sparkles, Aperture } from 'lucide-react'
import { startMood, stopMood, isMoodActive, triggerMoodReflect } from '../engine/MoodEngine'
import { Link } from 'react-router-dom'
import { listDisplays, openOutputWindow, type DisplayInfo } from '../lib/multiDisplay'
import { startMIDI, stopMIDI } from '../senses/MIDI'
import { useSceneStore } from '../store/sceneStore'
import { startHands, stopHands, createCameraStream } from '../senses/Hands'
import { startPose, stopPose } from '../senses/Pose'
import { startAudio, stopAudio } from '../senses/Audio'
import { startLight, stopLight } from '../senses/Light'
import { enterFullscreen, startRecording, stopRecording, screenshot, recordingElapsed } from '../lib/recorder'
import { soundEngine } from '../engine/SoundEngine'
import { isXRARSupported, startXR, endXR } from '../lib/webxr'
import { MasterSound } from './MasterSound'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  fpsRef: React.RefObject<number>
  onToggleAI: () => void
  onToggleOutput: () => void
  outputMode: boolean
  onToggleMirror: () => void
  mirrorMode: boolean
  onToggleTimeline: () => void
  timelineOpen: boolean
  canvasGetter: () => HTMLCanvasElement | null
  stageRef: React.RefObject<HTMLDivElement>
}

export function TopBar({ videoRef, fpsRef, onToggleAI, onToggleOutput, outputMode, onToggleMirror, mirrorMode, onToggleTimeline, timelineOpen, canvasGetter, stageRef }: Props) {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))
  const [handsOn, setHandsOn] = useState(false)
  const [audioOn, setAudioOn] = useState(false)
  const [lightOn, setLightOn] = useState(false)
  const [midiOn, setMidiOn] = useState(false)
  const [xrSupported, setXrSupported] = useState(false)
  const [xrOn, setXrOn] = useState(false)

  useEffect(() => { isXRARSupported().then(setXrSupported) }, [])

  // Broadcast camera state to the rest of the app (ContentSources, ParamPanel, Stage)
  // so they can react when the user turns the webcam on/off.
  useEffect(() => {
    ;(window as any).__animaCameraOn = handsOn
    window.dispatchEvent(new CustomEvent('anima:camera-state', { detail: handsOn }))
  }, [handsOn])
  // Same for AR state
  useEffect(() => {
    ;(window as any).__animaArOn = mirrorMode
    window.dispatchEvent(new CustomEvent('anima:ar-state', { detail: mirrorMode }))
  }, [mirrorMode])
  // Listen for requests to auto-start the camera (e.g. when a zone selects 'webcam' content
  // or when the user toggles AR — webcam zones are useless without an active MediaStream).
  useEffect(() => {
    const onReq = () => { if (!handsOn) toggleHands() }
    window.addEventListener('anima:request-camera', onReq)
    return () => window.removeEventListener('anima:request-camera', onReq)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handsOn])
  const [recOn, setRecOn] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  const [moodOn, setMoodOn] = useState(isMoodActive())
  const [fps, setFps] = useState(0)
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)
  const [displays, setDisplays] = useState<DisplayInfo[] | null>(null)
  const [showDisplayMenu, setShowDisplayMenu] = useState(false)

  const openDisplayMenu = async () => {
    if (showDisplayMenu) { setShowDisplayMenu(false); return }
    try {
      const d = await listDisplays()
      setDisplays(d)
      setShowDisplayMenu(true)
    } catch (e: any) {
      showToast('Impossible de lister les écrans: ' + (e?.message ?? e), true)
    }
  }

  const sendOutputTo = (d: DisplayInfo) => {
    setShowDisplayMenu(false)
    const w = openOutputWindow(d)
    if (w) showToast(`Sortie ouverte sur ${d.label}`)
    else showToast('Popup bloquée — autorise les fenêtres pour ce site.', true)
  }

  useEffect(() => {
    const id = setInterval(() => {
      const v = fpsRef.current ?? 0
      setFps(v)
      // Expose for MoodEngine sampler (no React subscription overhead)
      ;(window as any).__animaFps = v
    }, 400)
    return () => clearInterval(id)
  }, [fpsRef])

  const showToast = (msg: string, err = false) => {
    setToast({ msg, err })
    setTimeout(() => setToast(null), 2500)
  }

  const toggleHands = async () => {
    if (!videoRef.current) return
    if (handsOn) {
      // Turning camera off — also exit AR (would be black otherwise)
      stopHands()
      stopPose()
      setHandsOn(false)
      if (mirrorMode) {
        onToggleMirror()
        showToast('Caméra coupée — AR désactivé')
      }
      // Stop the underlying MediaStream so the browser shows the camera as released
      const stream = videoRef.current.srcObject as MediaStream | null
      if (stream) {
        stream.getTracks().forEach((t) => t.stop())
        videoRef.current.srcObject = null
      }
      return
    }
    try {
      await createCameraStream(videoRef.current)
      await startHands(videoRef.current)
      startPose(videoRef.current).catch((e) => console.warn('Pose start failed', e))
      setHandsOn(true)
      showToast('Webcam + tracking main/corps actifs')
    } catch (e: any) {
      showToast('Webcam refusée: ' + (e?.message ?? e), true)
    }
  }

  const toggleAudio = async () => {
    if (audioOn) { stopAudio(); setAudioOn(false); return }
    try {
      await startAudio()
      setAudioOn(true)
      showToast('Microphone actif')
    } catch (e: any) {
      showToast('Micro refusé: ' + (e?.message ?? e), true)
    }
  }

  const toggleLight = () => {
    if (!videoRef.current) return
    if (lightOn) { stopLight(); setLightOn(false); return }
    if (!handsOn) {
      showToast('Active la webcam d\'abord', true)
      return
    }
    startLight(videoRef.current)
    setLightOn(true)
  }

  const toggleAR = async () => {
    // Entering AR auto-starts the camera (and pose), because without webcam the mirror is just black.
    if (!mirrorMode && !handsOn) {
      await toggleHands()
    }
    onToggleMirror()
  }

  const toggleXR = async () => {
    const canvas = canvasGetter()
    if (!canvas) return
    // We need the THREE renderer; expose via a small hack: window.__animaRenderer is set by Stage
    const r = (window as any).__animaRenderer
    if (!r) { showToast('Renderer non prêt', true); return }
    if (xrOn) { endXR(); setXrOn(false); return }
    const ok = await startXR(r, () => setXrOn(false))
    if (ok) { setXrOn(true); showToast('Session AR démarrée') }
    else showToast('Impossible d\'entrer en AR sur ce navigateur', true)
  }

  const toggleMood = () => {
    if (moodOn) {
      stopMood(); setMoodOn(false); showToast('Mood Engine arrêté')
    } else {
      startMood((reply) => showToast('✨ ' + reply))
      setMoodOn(true)
      showToast('✨ Mood Engine activé — l\'IA observera la scène toutes les 30s')
    }
  }

  const toggleMIDI = async () => {
    if (midiOn) { stopMIDI(); setMidiOn(false); return }
    const r = await startMIDI()
    if (!r.ok) { showToast(r.error ?? 'MIDI échec', true); return }
    setMidiOn(true)
    showToast(r.inputs.length > 0 ? `MIDI : ${r.inputs.join(', ')}` : 'MIDI prêt (aucun appareil connecté)')
  }

  const toggleFs = () => {
    if (stageRef.current) enterFullscreen(stageRef.current)
  }

  const toggleRec = async () => {
    const c = canvasGetter()
    if (!c) return
    if (recOn) {
      await stopRecording()
      setRecOn(false)
      setRecSecs(0)
      showToast('Vidéo WebM sauvegardée 🎬')
    } else {
      // Mux the live master audio into the recording so the WebM has sound
      // (sonified obstacles + MIDI synth). Null if audio was never started.
      const audio = soundEngine.getRecordingAudioStream()
      startRecording(c, { fps: 60, audio })
      setRecOn(true)
      showToast(audio ? 'Enregistrement vidéo + audio…' : 'Enregistrement vidéo (audio muet — active le son)')
    }
  }

  // Live recording timer
  useEffect(() => {
    if (!recOn) return
    const id = window.setInterval(() => setRecSecs(Math.floor(recordingElapsed() / 1000)), 500)
    return () => clearInterval(id)
  }, [recOn])

  const shot = () => {
    const c = canvasGetter()
    if (c) {
      const { w, h } = screenshot(c)
      showToast(`Image capturée — ${w}×${h}px 📸`)
    }
  }

  const fpsClass = fps >= 50 ? 'fps-good' : fps >= 30 ? 'fps-mid' : 'fps-bad'

  return (
    <>
      <div className="topbar">
        <div className="brand">
          <svg className="brand-icon" viewBox="0 0 64 64">
            <defs>
              <radialGradient id="bg">
                <stop offset="0%" stopColor="#00ffa3" />
                <stop offset="60%" stopColor="#00d4ff" />
                <stop offset="100%" stopColor="#7c3aed" />
              </radialGradient>
            </defs>
            <circle cx="32" cy="32" r="28" fill="url(#bg)" />
            <circle cx="22" cy="26" r="4" fill="#fff" opacity=".9" />
            <circle cx="42" cy="34" r="6" fill="#fff" opacity=".6" />
            <circle cx="32" cy="44" r="3" fill="#fff" opacity=".8" />
          </svg>
          ANIMA STUDIO
        </div>

        <div className="topbar-group">
          <button onClick={toggleHands} className={handsOn ? 'primary' : ''} title="Webcam + tracking main + corps">
            <Camera size={14} /> Caméra
          </button>
          <button onClick={toggleAudio} className={audioOn ? 'primary' : ''} title="Microphone (FFT)">
            <Mic size={14} /> Micro
          </button>
          <button onClick={toggleLight} className={lightOn ? 'primary' : ''} title="Lumière ambiante (nécessite caméra)">
            <Sun size={14} /> Lumière
          </button>
          <button onClick={toggleMIDI} className={midiOn ? 'primary' : ''} title="Contrôleur MIDI (WebMIDI)">
            <Music size={14} /> MIDI
          </button>
        </div>
        <div className="topbar-sep" />
        <div className="topbar-group">
          <button onClick={toggleAR} className={mirrorMode ? 'primary' : ''} title="Mode Miroir AR — webcam en fond, organismes par-dessus">
            <ScanFace size={14} /> AR
          </button>
          {xrSupported && (
            <button onClick={toggleXR} className={xrOn ? 'primary' : ''} title="WebXR — vraie réalité augmentée (mobile compatible)">
              <Glasses size={14} /> XR
            </button>
          )}
        </div>

        <div className="spacer" />

        <span className="stats">
          <span className={fpsClass}>{fps} fps</span>
          {' · '}
          {current?.organism.kind ?? '—'}
          {' · '}
          {current?.organism.values && 'count' in current.organism.values ? `${(current.organism.values as any).count} agents` : ''}
        </span>

        <MasterSound />
        <button
          onClick={toggleMood}
          onDoubleClick={() => triggerMoodReflect()}
          className={`ghost icon ${moodOn ? 'active' : ''}`}
          title="Mood Engine — l'IA fait évoluer la scène en live (double-clic : réfléchir maintenant)"
        ><Sparkles size={16} /></button>
        <button onClick={onToggleTimeline} className={`ghost icon ${timelineOpen ? 'active' : ''}`} title="Timeline / Keyframes"><Clock size={16} /></button>
        <button onClick={shot} className="ghost icon" title="Capture PNG"><ImageDown size={16} /></button>
        <button onClick={toggleRec} className={`ghost icon ${recOn ? 'rec active' : 'rec'}`} title={recOn ? 'Arrêter l\'enregistrement' : 'Enregistrer vidéo (WebM + audio)'}>
          <Video size={16} />
        </button>
        {recOn && (
          <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: '#ff5a7a', display: 'inline-flex', alignItems: 'center', gap: 4 }} title="Durée d'enregistrement">
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#ff5a7a', display: 'inline-block', animation: 'pulse 1s infinite' }} />
            {String(Math.floor(recSecs / 60)).padStart(2, '0')}:{String(recSecs % 60).padStart(2, '0')}
          </span>
        )}
        <div style={{ position: 'relative' }}>
          <button onClick={openDisplayMenu} className="ghost icon" title="Ouvrir la sortie sur un écran"><MonitorPlay size={16} /></button>
          {showDisplayMenu && displays && (
            <div className="display-menu">
              <div className="display-menu-title">Écrans détectés</div>
              {displays.map((d) => (
                <button key={d.id} onClick={() => sendOutputTo(d)} className="display-item">
                  <span style={{ fontWeight: 500 }}>{d.label}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-mute)' }}>
                    {d.width}×{d.height} {d.isPrimary ? '· principal' : ''} {d.isInternal ? '' : '· externe'}
                  </span>
                </button>
              ))}
              <div className="display-menu-hint">
                Note : Chrome demande la permission "Gestion des fenêtres" pour détecter les écrans externes.
              </div>
            </div>
          )}
        </div>
        <button onClick={onToggleOutput} className={`ghost icon ${outputMode ? 'active' : ''}`} title="Mode SORTIE (F) — cache l'UI"><Monitor size={16} /></button>
        <button onClick={toggleFs} className="ghost icon" title="Plein écran"><Maximize2 size={16} /></button>
        <button onClick={onToggleAI} className="ghost icon" title="Compagnon IA"><MessageCircle size={16} /></button>
        <Link to="/mandala" title="Mandala Studio AR — dessin kaléidoscopique par les mains" style={{ display: 'inline-flex' }}>
          <button className="ghost icon"><Aperture size={16} /></button>
        </Link>
        <Link to="/admin" title="Administration" style={{ display: 'inline-flex' }}>
          <button className="ghost icon"><Settings size={16} /></button>
        </Link>
      </div>
      {toast && <div className={`toast ${toast.err ? 'error' : ''}`}>{toast.msg}</div>}
    </>
  )
}

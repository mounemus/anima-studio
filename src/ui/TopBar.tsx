import { useEffect, useState } from 'react'
import { Camera, Mic, Sun, Maximize2, MessageCircle, Video, ImageDown, Settings } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useSceneStore } from '../store/sceneStore'
import { startHands, stopHands, createCameraStream } from '../senses/Hands'
import { startAudio, stopAudio } from '../senses/Audio'
import { startLight, stopLight } from '../senses/Light'
import { enterFullscreen, startRecording, stopRecording, screenshot } from '../lib/recorder'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  fpsRef: React.RefObject<number>
  onToggleAI: () => void
  canvasGetter: () => HTMLCanvasElement | null
  stageRef: React.RefObject<HTMLDivElement>
}

export function TopBar({ videoRef, fpsRef, onToggleAI, canvasGetter, stageRef }: Props) {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))
  const [handsOn, setHandsOn] = useState(false)
  const [audioOn, setAudioOn] = useState(false)
  const [lightOn, setLightOn] = useState(false)
  const [recOn, setRecOn] = useState(false)
  const [fps, setFps] = useState(0)
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)

  useEffect(() => {
    const id = setInterval(() => setFps(fpsRef.current ?? 0), 400)
    return () => clearInterval(id)
  }, [fpsRef])

  const showToast = (msg: string, err = false) => {
    setToast({ msg, err })
    setTimeout(() => setToast(null), 2500)
  }

  const toggleHands = async () => {
    if (!videoRef.current) return
    if (handsOn) { stopHands(); setHandsOn(false); return }
    try {
      await createCameraStream(videoRef.current)
      await startHands(videoRef.current)
      setHandsOn(true)
      showToast('Webcam + tracking main actifs')
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

  const toggleFs = () => {
    if (stageRef.current) enterFullscreen(stageRef.current)
  }

  const toggleRec = async () => {
    const c = canvasGetter()
    if (!c) return
    if (recOn) {
      await stopRecording()
      setRecOn(false)
      showToast('Enregistrement sauvegardé')
    } else {
      startRecording(c)
      setRecOn(true)
      showToast('Enregistrement WebM en cours...')
    }
  }

  const shot = () => {
    const c = canvasGetter()
    if (c) { screenshot(c); showToast('Capture sauvegardée') }
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

        <button onClick={toggleHands} className={handsOn ? 'primary' : ''} title="Activer webcam + tracking main">
          <Camera size={14} /> {handsOn ? 'Caméra ON' : 'Caméra'}
        </button>
        <button onClick={toggleAudio} className={audioOn ? 'primary' : ''} title="Activer microphone">
          <Mic size={14} /> {audioOn ? 'Micro ON' : 'Micro'}
        </button>
        <button onClick={toggleLight} className={lightOn ? 'primary' : ''} title="Lumière ambiante (nécessite caméra)">
          <Sun size={14} /> {lightOn ? 'Lumière ON' : 'Lumière'}
        </button>

        <div className="spacer" />

        <span className="stats">
          <span className={fpsClass}>{fps} fps</span>
          {' · '}
          {current?.organism.kind ?? '—'}
          {' · '}
          {current?.organism.values && 'count' in current.organism.values ? `${(current.organism.values as any).count} agents` : ''}
        </span>

        <button onClick={shot} className="ghost icon" title="Capture PNG"><ImageDown size={16} /></button>
        <button onClick={toggleRec} className={`ghost icon ${recOn ? 'rec active' : 'rec'}`} title={recOn ? 'Arrêter l\'enregistrement' : 'Enregistrer WebM'}>
          <Video size={16} />
        </button>
        <button onClick={toggleFs} className="ghost icon" title="Plein écran"><Maximize2 size={16} /></button>
        <button onClick={onToggleAI} className="ghost icon" title="Compagnon IA"><MessageCircle size={16} /></button>
        <Link to="/admin" title="Administration" style={{ display: 'inline-flex' }}>
          <button className="ghost icon"><Settings size={16} /></button>
        </Link>
      </div>
      {toast && <div className={`toast ${toast.err ? 'error' : ''}`}>{toast.msg}</div>}
    </>
  )
}

/**
 * Timeline panel — docked at the bottom of the stage, behaves like a DAW track view.
 *
 * Layout:
 * +-------------------------+--------------------------------------------+
 * | Track header (label,    | Track body (keyframes as dots on timeline) |
 * |  color, easing, delete) |                                            |
 * +-------------------------+--------------------------------------------+
 *
 * Interactions:
 * - Click empty body → place a keyframe at that time (value = current scene value)
 * - Drag a keyframe horizontally → reschedule it
 * - Shift+click a keyframe → delete it
 * - Top transport bar: play/pause/stop, scrubber, time display, loop toggle, duration input
 */
import { useEffect, useRef, useState } from 'react'
import { Play, Pause, Square, Plus, Trash2, Repeat, Clock } from 'lucide-react'
import { useSceneStore } from '../store/sceneStore'
import { TRACK_TARGETS, newTrack, addKey, removeKey, moveKey, play, pause, stop, seek, currentTime, runtime, loadTimeline, sampleTrack } from '../engine/Timeline'
import type { TimelineTrack, TimelineKeyframe } from '../types/scene'

interface Props { open: boolean; onClose: () => void }

const ROW_H = 28
const HEADER_W = 220

export function TimelinePanel({ open, onClose }: Props) {
  const current = useSceneStore((s) => s.scenes.find((x) => x.id === s.currentId))
  const updateTimeline = useSceneStore((s) => s.updateTimeline)
  const tl = current?.timeline ?? { duration: 60, loop: true, tracks: [] }
  const bodyRef = useRef<HTMLDivElement>(null)
  const [, force] = useState(0)
  const [addTrackOpen, setAddTrackOpen] = useState(false)
  const dragRef = useRef<{ trackId: string; keyIdx: number; startX: number; startT: number } | null>(null)

  // Repaint at 30fps so the playhead moves smoothly. Only when panel open.
  useEffect(() => {
    if (!open) return
    let id = 0
    const tick = () => { force((x) => x + 1); id = window.setTimeout(tick, 33) }
    tick()
    return () => clearTimeout(id)
  }, [open])

  // Sync runtime when the persisted timeline changes (e.g. AI added a track)
  useEffect(() => { loadTimeline(tl as any) }, [tl])

  if (!open || !current) return null

  const tNow = currentTime()
  const pxPerSec = bodyRef.current ? (bodyRef.current.clientWidth - 8) / tl.duration : 10
  const xAtTime = (t: number) => 4 + t * pxPerSec
  const timeAtX = (x: number) => Math.max(0, Math.min(tl.duration, (x - 4) / pxPerSec))

  const updateTracks = (tracks: TimelineTrack[]) => updateTimeline({ tracks })

  const addTrack = (path: string, label: string) => {
    const colors = ['#00ffa3', '#00d4ff', '#7c3aed', '#ff6ba6', '#ffb547', '#ff5a7a']
    const tr = newTrack(path, label, colors[tl.tracks.length % colors.length])
    updateTracks([...tl.tracks, tr])
    setAddTrackOpen(false)
  }

  const removeTrack = (id: string) => updateTracks(tl.tracks.filter((t) => t.id !== id))

  const placeKey = (trackId: string, t: number) => {
    const tr = tl.tracks.find((x) => x.id === trackId)
    if (!tr) return
    // Snapshot the current live value at `t` (or the scene's value if no kf yet)
    const target = TRACK_TARGETS.find((tg) => tg.path === tr.path)
    let v: number | string
    const liveSample = sampleTrack(tr as any, t)
    if (liveSample !== undefined) {
      v = liveSample
    } else if (target?.type === 'color') {
      v = getDeep(current, tr.path) ?? '#00ffa3'
    } else {
      v = Number(getDeep(current, tr.path) ?? 0)
    }
    const k: TimelineKeyframe = { t, v }
    const next = tl.tracks.map((x) => x.id === trackId ? addKey(x as any, k) as any : x)
    updateTracks(next)
  }

  const onBodyClick = (trackId: string, e: React.MouseEvent) => {
    if (dragRef.current) return  // ignore click that ended a drag
    const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
    placeKey(trackId, timeAtX(e.clientX - r.left))
  }

  return (
    <div className="timeline-panel">
      <div className="timeline-transport">
        <button onClick={() => (runtime.playing ? pause() : play())} className={runtime.playing ? 'primary' : ''} title="Lecture / Pause (Espace)">
          {runtime.playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button onClick={stop} title="Stop"><Square size={14} /></button>
        <span className="timeline-time"><Clock size={11} /> {tNow.toFixed(2)} / {tl.duration.toFixed(0)}s</span>
        <input
          type="range"
          min={0} max={tl.duration} step={0.05} value={tNow}
          onChange={(e) => seek(parseFloat(e.target.value))}
          style={{ flex: 1, minWidth: 80 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
          <input type="checkbox" checked={tl.loop} onChange={(e) => updateTimeline({ loop: e.target.checked })} />
          <Repeat size={12} /> Loop
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
          Durée
          <input
            type="number" min={5} max={3600} step={5} value={tl.duration}
            onChange={(e) => updateTimeline({ duration: Math.max(5, parseInt(e.target.value) || 60) })}
            style={{ width: 60 }}
          />
          <span>s</span>
        </label>
        <div style={{ position: 'relative' }}>
          <button onClick={() => setAddTrackOpen((x) => !x)} className="primary" style={{ fontSize: 11 }}>
            <Plus size={11} /> Track
          </button>
          {addTrackOpen && (
            <div className="timeline-add-menu">
              {TRACK_TARGETS.map((tg) => (
                <button key={tg.path} onClick={() => addTrack(tg.path, tg.label)} className="timeline-add-item">
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: tg.type === 'color' ? 'linear-gradient(135deg,#7c3aed,#ff6ba6)' : 'var(--accent)' }} />
                  {tg.label}
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-mute)' }}>{tg.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={onClose} className="ghost icon" title="Fermer">×</button>
      </div>
      <div className="timeline-grid">
        {tl.tracks.length === 0 && (
          <div className="timeline-empty">
            Aucune track — clique <strong>+ Track</strong> en haut pour automatiser un paramètre.
          </div>
        )}
        {tl.tracks.map((tr) => (
          <div key={tr.id} className="timeline-row" style={{ height: ROW_H }}>
            <div className="timeline-row-header" style={{ width: HEADER_W, borderLeft: `3px solid ${tr.color}` }}>
              <span className="timeline-row-label" title={tr.path}>{tr.label}</span>
              <select
                value={tr.easing}
                onChange={(e) => updateTracks(tl.tracks.map((x) => x.id === tr.id ? { ...x, easing: e.target.value as any } : x))}
                style={{ width: 60, fontSize: 10 }}
                title="Easing par défaut"
              >
                <option value="linear">Linear</option>
                <option value="easeIn">EaseIn</option>
                <option value="easeOut">EaseOut</option>
                <option value="easeInOut">EaseInOut</option>
                <option value="spring">Spring</option>
                <option value="step">Step</option>
              </select>
              <button className="ghost icon" onClick={() => removeTrack(tr.id)} title="Supprimer"><Trash2 size={11} /></button>
            </div>
            <div
              ref={bodyRef}
              className="timeline-row-body"
              onClick={(e) => onBodyClick(tr.id, e)}
            >
              {/* Tick marks every 5s */}
              {Array.from({ length: Math.floor(tl.duration / 5) + 1 }).map((_, i) => (
                <div key={i} className="timeline-tick" style={{ left: xAtTime(i * 5) }} />
              ))}
              {/* Keyframes */}
              {tr.keyframes.map((k, i) => (
                <div
                  key={i}
                  className="timeline-key"
                  style={{
                    left: xAtTime(k.t) - 5,
                    background: typeof k.v === 'string' ? k.v : tr.color,
                  }}
                  title={`${k.t.toFixed(2)}s → ${k.v}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (e.shiftKey) {
                      updateTracks(tl.tracks.map((x) => x.id === tr.id ? removeKey(x as any, i) as any : x))
                    }
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    if (e.shiftKey) return
                    dragRef.current = { trackId: tr.id, keyIdx: i, startX: e.clientX, startT: k.t }
                    const move = (ev: PointerEvent) => {
                      if (!dragRef.current) return
                      const dx = ev.clientX - dragRef.current.startX
                      const newT = Math.max(0, Math.min(tl.duration, dragRef.current.startT + dx / pxPerSec))
                      updateTracks(
                        useSceneStore.getState().scenes.find((s) => s.id === useSceneStore.getState().currentId)?.timeline?.tracks
                          .map((x) => x.id === tr.id ? moveKey(x as any, i, newT) as any : x) ?? []
                      )
                    }
                    const up = () => {
                      window.removeEventListener('pointermove', move)
                      window.removeEventListener('pointerup', up)
                      // Defer reset so the body's onClick (if any) sees dragRef and bails
                      setTimeout(() => { dragRef.current = null }, 50)
                    }
                    window.addEventListener('pointermove', move)
                    window.addEventListener('pointerup', up)
                  }}
                />
              ))}
              {/* Playhead */}
              <div className="timeline-playhead" style={{ left: xAtTime(tNow) }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function getDeep(obj: any, path: string): any {
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj)
}

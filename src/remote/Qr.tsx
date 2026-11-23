import qrcode from 'qrcode-generator'

/** L'adresse que le QR code fait ouvrir : la page Télécommande, avec le code déjà rempli. */
export const pairUrl = (origin: string, code: string) => `${origin}/remote?code=${code}`

/** Le code lu dans l'adresse de la page (`?code=482913`), ou une chaîne vide. */
export const codeFromSearch = (search: string) => { const c = new URLSearchParams(search).get('code') ?? ''; return /^\d{6}$/.test(c) ? c : '' }

/** QR code dessiné en SVG : noir sur blanc avec sa marge, pour qu'un appareil photo le lise sur n'importe quel fond. */
export function Qr({ text, size = 132 }: { text: string; size?: number }) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make()
  const n = qr.getModuleCount(); let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`
  return (
    <svg role="img" aria-label="QR code à scanner avec la tablette ou le téléphone" viewBox={`-4 -4 ${n + 8} ${n + 8}`} width={size} height={size} shapeRendering="crispEdges" style={{ background: '#fff', borderRadius: 6, flexShrink: 0 }}>
      <path d={d} fill="#000" />
    </svg>
  )
}

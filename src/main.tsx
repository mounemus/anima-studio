import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'
import { App } from './App'
import { AdminPage } from './admin/AdminPage'
import { MandalaStudio } from './mandala/MandalaStudio'
import { SketchStudio } from './sketch/SketchStudio'
import { PotteryStudio } from './pottery/PotteryStudio'
import { SculptStudio } from './sculpt/SculptStudio'
import { MorphogenesisStudio } from './morpho/MorphogenesisStudio'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { FrontGate } from './FrontGate'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<FrontGate><App /></FrontGate>} />
          <Route path="/mandala" element={<FrontGate><MandalaStudio /></FrontGate>} />
          <Route path="/sketch" element={<FrontGate><SketchStudio /></FrontGate>} />
          <Route path="/pottery" element={<FrontGate><PotteryStudio /></FrontGate>} />
          <Route path="/sculpt" element={<FrontGate><SculptStudio /></FrontGate>} />
          <Route path="/morpho" element={<FrontGate><MorphogenesisStudio /></FrontGate>} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)

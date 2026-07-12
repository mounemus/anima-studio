import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'
import { App } from './App'
import { AdminPage } from './admin/AdminPage'
import { MandalaStudio } from './mandala/MandalaStudio'
import { SketchStudio } from './sketch/SketchStudio'
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
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)

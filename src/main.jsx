import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Analytics } from '@vercel/analytics/react'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    {/* Privacy-friendly traffic analytics. Active once Web Analytics is
        enabled in the Vercel dashboard (Project → Analytics). No cookie
        banner needed; no separate account. */}
    <Analytics />
  </StrictMode>,
)

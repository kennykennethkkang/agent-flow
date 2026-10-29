import { createRoot } from 'react-dom/client'
import { Switchboard } from './components/switchboard/switchboard'
import './app/globals.css'

// Standalone CLI entry — no VS Code API, connects to relay via SSE
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')
const root = createRoot(rootElement)
root.render(<Switchboard />)

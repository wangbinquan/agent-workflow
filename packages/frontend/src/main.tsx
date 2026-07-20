import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createQueryClient } from './lib/query-client'
import { router } from './router'
import './i18n' // side-effect: initialize i18next before any component mounts
import './styles.css'
import './components/prose/prose.css'

const queryClient = createQueryClient()

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing in index.html')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)

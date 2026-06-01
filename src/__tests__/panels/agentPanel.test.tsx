import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createStore } from 'zustand/vanilla'
import { AgentStoreProvider } from '@admin/ai/AgentStoreContext'
import { MemoryRouter, useLocation } from '@admin/lib/routing'
import type { AgentSlice } from '@site/agent'
import { AgentPanel } from '@site/panels/AgentPanel'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createAgentStore(overrides: Partial<AgentSlice> = {}) {
  return createStore<AgentSlice>()((set) => ({
    isAgentOpen: true,
    isAgentStreaming: false,
    agentMessages: [],
    agentError: null,
    agentSessionId: null,
    agentConversationId: null,
    agentActiveCredentialId: null,
    agentActiveModelId: null,
    agentConversations: [],
    openAgent: () => set({ isAgentOpen: true }),
    closeAgent: () => set({ isAgentOpen: false }),
    toggleAgent: () => set((state) => ({ isAgentOpen: !state.isAgentOpen })),
    sendAgentMessage: async () => {},
    abortAgent: () => {},
    clearAgentMessages: () => set({ agentMessages: [], agentError: null }),
    loadAgentConversations: async () => {},
    loadAgentConversation: async () => {},
    startNewAgentConversation: () => set({ agentMessages: [], agentError: null }),
    deleteAgentConversation: async () => {},
    setAgentProvider: async (credentialId, modelId) => {
      set({ agentActiveCredentialId: credentialId, agentActiveModelId: modelId })
    },
    ...overrides,
  }))
}

function renderAgentPanel(overrides: Partial<AgentSlice> = {}) {
  const store = createAgentStore(overrides)
  return render(
    <MemoryRouter initialEntries={['/admin/site']}>
      <AgentStoreProvider store={store}>
        <AgentPanel variant="docked" />
        <RouteProbe />
      </AgentStoreProvider>
    </MemoryRouter>,
  )
}

function RouteProbe() {
  const location = useLocation()
  return <output aria-label="current route">{location.pathname}</output>
}

describe('AgentPanel', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    globalThis.fetch = originalFetch
  })

  it('surfaces a large setup empty state and header shortcut when no credentials exist', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/admin/api/ai/credentials')) {
        return jsonResponse({ credentials: [] })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    renderAgentPanel()

    await waitFor(() => {
      expect(screen.getByText('Connect an AI provider')).toBeTruthy()
    })

    const headerButton = screen.getByTestId('agent-credentials-header-link')
    expect(headerButton.tagName).toBe('BUTTON')
    expect(headerButton.textContent?.trim()).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Open AI settings' }))
    await waitFor(() => {
      expect(screen.getByLabelText('current route').textContent).toBe('/admin/ai')
    })

    expect(screen.getByText('No credentials yet')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull()
  })

  it('keeps the prompt empty state when credentials are available', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/admin/api/ai/credentials')) {
        return jsonResponse({
          credentials: [{
            id: 'cred_1',
            providerId: 'openai',
            authMode: 'apiKey',
            displayLabel: 'OpenAI',
            baseUrl: null,
            keyFingerprintCurrent: true,
            createdAt: '2026-06-01T10:00:00.000Z',
            lastUsedAt: null,
          }],
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    renderAgentPanel()

    await waitFor(() => {
      expect(screen.getByText("Describe what you want to build and I'll do it for you.")).toBeTruthy()
    })

    expect(screen.queryByText('Connect an AI provider')).toBeNull()
    expect(screen.queryByTestId('agent-credentials-header-link')).toBeNull()
  })
})

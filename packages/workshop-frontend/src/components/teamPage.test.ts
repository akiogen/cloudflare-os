import { afterEach, describe, expect, it, vi } from 'vitest'
import { teamPageUrl } from './teamPage'

describe('teamPageUrl (BLOS)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is undefined when the build does not set a Team page', () => {
    vi.stubEnv('VITE_TEAM_PAGE_URL', '')
    expect(teamPageUrl()).toBeUndefined()
  })

  it('returns the configured Team page, trimmed', () => {
    vi.stubEnv('VITE_TEAM_PAGE_URL', ' /team ')
    expect(teamPageUrl()).toBe('/team')
  })
})

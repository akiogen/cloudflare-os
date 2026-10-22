import { describe, expect, it } from 'vitest'
import { ICONS, parseHomeSuggestions } from './homeSuggestionsConfig'

const one = { id: 'todo', label: 'Make a to-do list', description: 'A checklist', prompt: 'Build a to-do list.', icon: 'ListChecks' }

describe('parseHomeSuggestions (BLOS)', () => {
  it('keeps upstream when unset, malformed or empty', () => {
    for (const raw of [undefined, '', '  ', 'not json', '{}', '[]']) expect(parseHomeSuggestions(raw)).toBeUndefined()
  })

  it('maps a valid list, with icons resolved by name', () => {
    const list = parseHomeSuggestions(JSON.stringify([one]))
    expect(list).toHaveLength(1)
    expect(list![0]).toMatchObject({ id: 'todo', label: 'Make a to-do list', prompt: 'Build a to-do list.' })
    expect(list![0].icon).toBe(ICONS.ListChecks)
  })

  it('rejects the whole list on an unknown icon, a missing field or a repeated id', () => {
    expect(parseHomeSuggestions(JSON.stringify([{ ...one, icon: 'Nope' }]))).toBeUndefined()
    expect(parseHomeSuggestions(JSON.stringify([{ ...one, prompt: '' }]))).toBeUndefined()
    expect(parseHomeSuggestions(JSON.stringify([one, one]))).toBeUndefined()
  })
})

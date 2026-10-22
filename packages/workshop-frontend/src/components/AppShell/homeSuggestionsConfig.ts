// BLOS (business-loop-os #156): a deployment may replace the Home suggestions at build time with
// VITE_HOME_SUGGESTIONS, a JSON array of { id, label, description, prompt, icon }. `icon` names one
// of ICONS below. Anything missing, malformed or with an unknown icon leaves upstream's list.

import {
  AppWindow,
  Calculator,
  CalendarCheck,
  ChartLineUp,
  FileText,
  Lightning,
  ListChecks,
  NotePencil,
  Presentation,
  Receipt,
  type Icon,
} from '@phosphor-icons/react'

export const ICONS: Record<string, Icon> = {
  AppWindow, Calculator, CalendarCheck, ChartLineUp, FileText, Lightning, ListChecks, NotePencil,
  Presentation, Receipt,
}

export type ConfiguredSuggestion = {
  id: string
  label: string
  description: string
  prompt: string
  icon: Icon
}

const FIELDS = ['id', 'label', 'description', 'prompt', 'icon'] as const

export function parseHomeSuggestions(raw: string | undefined): ConfiguredSuggestion[] | undefined {
  if (!raw?.trim()) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(value) || value.length === 0) return undefined
  let out: ConfiguredSuggestion[] = []
  for (let item of value) {
    if (typeof item !== 'object' || item === null) return undefined
    let entry = item as Record<string, unknown>
    if (!FIELDS.every(field => typeof entry[field] === 'string' && (entry[field] as string).trim())) return undefined
    let icon = ICONS[entry.icon as string]
    if (!icon) return undefined
    out.push({
      id: entry.id as string,
      label: entry.label as string,
      description: entry.description as string,
      prompt: entry.prompt as string,
      icon,
    })
  }
  if (new Set(out.map(s => s.id)).size !== out.length) return undefined
  return out
}

export function configuredHomeSuggestions(): ConfiguredSuggestion[] | undefined {
  return parseHomeSuggestions(import.meta.env.VITE_HOME_SUGGESTIONS)
}

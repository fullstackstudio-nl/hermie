/**
 * Model ids, read back as names.
 *
 * The cases are chosen to cover the SHAPES rather than a catalogue: a family
 * word, a version written with hyphens and one written with dots, a date suffix
 * in both spellings, a parameter count, a context window, a routing prefix, and
 * an id nothing here has ever seen. The last group is the important one — a
 * table of known models would be out of date by the next release, and what this
 * has to guarantee is that an unknown id still comes out readable and that no id
 * ever comes out blank.
 *
 * Several of the ids are taken from the vendored `model-search-text.ts`, which is
 * the only list in this repository of what a real gateway actually reports.
 */
import { describe, expect, it } from 'vitest'

import { parseModelId, prettyModelName } from './model-name'

describe('the families whose spelling is their own', () => {
  it.each([
    ['claude-opus-5', 'Claude Opus 5'],
    ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
    ['claude-sonnet-4.6', 'Claude Sonnet 4.6'],
    ['claude-3-5-sonnet', 'Claude 3.5 Sonnet'],
    ['gpt-5.5', 'GPT-5.5'],
    ['gpt-5-5', 'GPT-5.5'],
    ['gpt-4o-mini', 'GPT-4o Mini'],
    ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
    ['gemini-2.0-flash', 'Gemini 2.0 Flash'],
    ['llama-3.1-70b', 'Llama 3.1 70B'],
    ['deepseek-v3', 'DeepSeek V3'],
    ['deepseek-r1', 'DeepSeek R1'],
    ['qwen3-235b', 'Qwen3 235B'],
    ['mistral-large-latest', 'Mistral Large Latest'],
    ['mixtral-8x7b', 'Mixtral 8x7B'],
    ['grok-code-fast-1', 'Grok Code Fast 1'],
    ['glm-5.2', 'GLM-5.2']
  ])('%s reads as %s', (id, name) => {
    expect(prettyModelName(id)).toBe(name)
  })

  it('leaves the o-series lower case, because that is how it is written', () => {
    expect(prettyModelName('o3-mini')).toBe('o3 Mini')
    expect(prettyModelName('o1-preview')).toBe('o1 Preview')
    expect(prettyModelName('o4-mini-high')).toBe('o4 Mini High')
  })
})

describe('ids the vendored search list says a gateway really reports', () => {
  it.each([
    ['k3', 'K3'],
    ['kimi-k3', 'Kimi K3'],
    ['kimi-k2.5', 'Kimi K2.5'],
    ['kimi-k2.6', 'Kimi K2.6'],
    ['kimi-for-coding', 'Kimi for Coding'],
    ['gpt-5.6-sol', 'GPT-5.6 Sol'],
    ['x-preview-f-free', 'X Preview F Free']
  ])('%s reads as %s', (id, name) => {
    expect(prettyModelName(id)).toBe(name)
  })
})

describe('the date a snapshot is pinned with', () => {
  it('drops a stamp written in one token', () => {
    expect(prettyModelName('claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5')
    expect(prettyModelName('claude-3-5-sonnet-20241022')).toBe('Claude 3.5 Sonnet')
  })

  it('drops one written as three', () => {
    expect(prettyModelName('claude-opus-4-1-2025-08-05')).toBe('Claude Opus 4.1')
  })

  it('keeps a version that only looks like a date', () => {
    // Mistral's own naming: year and month, four digits, and a version.
    expect(prettyModelName('mistral-large-2411')).toBe('Mistral Large 2411')
  })

  it('keeps a stamp that is the whole id, because dropping it would leave nothing', () => {
    expect(prettyModelName('20251001')).toBe('20251001')
  })
})

describe('the route, which is not part of the name', () => {
  it.each([
    ['anthropic/claude-opus-5', 'Claude Opus 5', 'anthropic'],
    ['openai/gpt-5.5', 'GPT-5.5', 'openai'],
    ['azure/gpt-4o', 'GPT-4o', 'azure'],
    ['openrouter/anthropic/claude-opus-5', 'Claude Opus 5', 'openrouter/anthropic'],
    ['duo-chat-claude-sonnet-4-6', 'Claude Sonnet 4.6', 'duo-chat'],
    ['claude-opus-5', 'Claude Opus 5', null]
  ])('%s is %s from %s', (id, name, provider) => {
    expect(parseModelId(id)).toEqual({ id, name, provider })
  })
})

describe('numbers that are not versions', () => {
  it('capitalises a parameter count', () => {
    expect(prettyModelName('llama-3.3-70b-instruct')).toBe('Llama 3.3 70B Instruct')
    expect(prettyModelName('qwen2.5-1.5b')).toBe('Qwen2.5 1.5B')
  })

  it('capitalises a context window', () => {
    expect(prettyModelName('gpt-4-32k')).toBe('GPT-4 32K')
  })
})

describe('an id nothing here has ever seen', () => {
  it('is Title-Cased with its numbers left alone', () => {
    expect(prettyModelName('acme-thinker-2.1-turbo')).toBe('Acme Thinker 2.1 Turbo')
    expect(prettyModelName('internal_house_model_7')).toBe('Internal House Model 7')
  })

  it('never comes back blank for an id that was not', () => {
    for (const id of ['---', '::', 'x', '7', 'a-b-c', '   padded   ']) {
      expect(prettyModelName(id).trim()).not.toBe('')
    }
  })

  it('has nothing to say about nothing', () => {
    expect(prettyModelName('')).toBe('')
    expect(prettyModelName('   ')).toBe('')
  })

  it('keeps the id it was given, whatever it decided to show', () => {
    expect(parseModelId('  anthropic/claude-opus-5  ').id).toBe('  anthropic/claude-opus-5  ')
  })
})

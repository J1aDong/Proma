import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { Channel } from '@proma/shared'

let channels: Channel[] = []

mock.module('../../channel-manager', () => ({
  listChannels: () => channels,
  getChannelById: (id: string) => channels.find((channel) => channel.id === id),
  decryptApiKey: (channelId: string) => `key-${channelId}`,
}))

const { resolveChannelAndModel } = await import('../model-resolution')

function createChannel(input: {
  id: string
  enabled?: boolean
  models: Array<{ id: string; enabled?: boolean }>
}): Channel {
  const now = Date.now()
  return {
    id: input.id,
    name: input.id,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'encrypted-key',
    models: input.models.map((model) => ({
      id: model.id,
      name: model.id,
      enabled: model.enabled ?? true,
    })),
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  }
}

describe('model-resolution', () => {
  beforeEach(() => {
    channels = [
      createChannel({
        id: 'channel-a',
        models: [{ id: 'sonnet' }, { id: 'haiku' }],
      }),
      createChannel({
        id: 'channel-b',
        models: [{ id: 'gpt-4.1' }],
      }),
    ]
  })

  it('supports plain model id and resolves channel automatically', () => {
    const resolved = resolveChannelAndModel('sonnet')
    expect(resolved.channelId).toBe('channel-a')
    expect(resolved.modelId).toBe('sonnet')
    expect(resolved.apiKey).toBe('key-channel-a')
  })

  it('supports explicit channelId:modelId format', () => {
    const resolved = resolveChannelAndModel('channel-b:gpt-4.1')
    expect(resolved.channelId).toBe('channel-b')
    expect(resolved.modelId).toBe('gpt-4.1')
    expect(resolved.apiKey).toBe('key-channel-b')
  })

  it('falls back to model-id lookup when explicit channel is unavailable', () => {
    channels = [
      createChannel({
        id: 'channel-b',
        models: [{ id: 'gpt-4.1' }],
      }),
    ]

    const resolved = resolveChannelAndModel('missing-channel:gpt-4.1')
    expect(resolved.channelId).toBe('channel-b')
    expect(resolved.modelId).toBe('gpt-4.1')
  })
})

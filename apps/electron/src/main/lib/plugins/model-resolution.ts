import { getChannelById, decryptApiKey, listChannels } from '../channel-manager'

export interface ResolvedModel {
  channelId: string
  modelId: string
  apiKey: string
  channel: NonNullable<ReturnType<typeof getChannelById>>
}

function findEnabledModelIdInChannel(channel: ResolvedModel['channel'], requestedModelId: string): string | null {
  const enabledModels = channel.models.filter((model) => model.enabled)

  const exact = enabledModels.find((model) => model.id === requestedModelId)
  if (exact) {
    return exact.id
  }

  const lowerRequested = requestedModelId.toLowerCase()
  const caseInsensitive = enabledModels.find((model) => model.id.toLowerCase() === lowerRequested)
  if (caseInsensitive) {
    return caseInsensitive.id
  }

  return null
}

function resolveByModelId(modelId: string): ResolvedModel {
  const enabledChannels = listChannels().filter((channel) => channel.enabled)

  for (const channel of enabledChannels) {
    const matchedModelId = findEnabledModelIdInChannel(channel, modelId)
    if (!matchedModelId) {
      continue
    }

    return {
      channelId: channel.id,
      modelId: matchedModelId,
      apiKey: decryptApiKey(channel.id),
      channel,
    }
  }

  throw new Error(`找不到模型对应的渠道: ${modelId}`)
}

/**
 * 解析渠道与模型，包含解密 API Key 的逻辑。
 * 支持 'channelId:modelId' 格式或后备逻辑。
 */
export function resolveChannelAndModel(model: string): ResolvedModel {
  const rawModel = model?.trim() ?? ''
  if (!rawModel) {
    throw new Error('模型不能为空')
  }

  let channelId = ''
  let actualModelId = rawModel

  // 测试环境绕过
  if (process.env.PROMA_PLUGIN_MODEL_VALIDATION_BYPASS === '1' && rawModel === 'test-model') {
    return {
      channelId: 'test-channel',
      modelId: 'test-model',
      apiKey: 'test-key',
      channel: {
        id: 'test-channel',
        name: 'Test Channel',
        provider: 'openai',
        baseUrl: 'http://localhost:8080',
        apiKey: 'test-key',
        models: [],
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      } as any,
    }
  }

  if (rawModel.includes(':')) {
    const parts = rawModel.split(':')
    channelId = parts[0] || ''
    actualModelId = parts.slice(1).join(':') || ''
  }

  if (channelId) {
    const channel = getChannelById(channelId)
    if (channel && channel.enabled) {
      const matchedModelId = findEnabledModelIdInChannel(channel, actualModelId)
      if (matchedModelId) {
        return {
          channelId: channel.id,
          modelId: matchedModelId,
          apiKey: decryptApiKey(channel.id),
          channel,
        }
      }
    }

    // channelId:modelId 无法匹配时，回退按 modelId 在启用渠道中搜索，避免历史数据导致完全不可用。
    return resolveByModelId(actualModelId || rawModel)
  }

  return resolveByModelId(rawModel)
}

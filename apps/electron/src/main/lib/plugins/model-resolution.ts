import { getChannelById, decryptApiKey } from '../channel-manager'

export interface ResolvedModel {
  channelId: string
  modelId: string
  apiKey: string
  channel: NonNullable<ReturnType<typeof getChannelById>>
}

/**
 * 解析渠道与模型，包含解密 API Key 的逻辑。
 * 支持 'channelId:modelId' 格式或后备逻辑。
 */
export function resolveChannelAndModel(model: string): ResolvedModel {
  let channelId = ''
  let actualModelId = model ?? ''

  // 测试环境绕过
  if (process.env.PROMA_PLUGIN_MODEL_VALIDATION_BYPASS === '1' && model === 'test-model') {
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

  if (model && model.includes(':')) {
    const parts = model.split(':')
    channelId = parts[0] || ''
    actualModelId = parts[1] || ''
  }

  const channel = channelId ? getChannelById(channelId) : undefined
  if (!channel) {
    throw new Error(`找不到模型对应的渠道: ${model}`)
  }

  const apiKey = decryptApiKey(channel.id)

  return {
    channelId: channel.id,
    modelId: actualModelId,
    apiKey,
    channel,
  }
}

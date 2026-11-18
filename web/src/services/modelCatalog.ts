import type { Provider } from './providers.js'
export type ModelInfo = { id: string; displayName: string; supportsVision: boolean; supportsThinking: boolean; contextWindow: number }
/** Literal reference declarations, not independently verified model/provider capabilities. */
export const REFERENCE_CATALOG: Record<string, ModelInfo[]> = {
  "official": [
    {
      "id": "deepseek-flash",
      "displayName": "DeepSeek V4.1 Flash",
      "supportsVision": true,
      "supportsThinking": true,
      "contextWindow": 1000000
    },
    {
      "id": "deepseek-v4-pro",
      "displayName": "DeepSeek V4 Pro",
      "supportsVision": false,
      "supportsThinking": true,
      "contextWindow": 1000000
    }
  ],
  "compatible": [
    {
      "id": "deepseek-v4-flash",
      "displayName": "DeepSeek V4 Flash",
      "supportsVision": false,
      "supportsThinking": true,
      "contextWindow": 1000000
    },
    {
      "id": "deepseek-flash",
      "displayName": "DeepSeek Flash",
      "supportsVision": false,
      "supportsThinking": true,
      "contextWindow": 1000000
    },
    {
      "id": "deepseek-v4.1-flash",
      "displayName": "DeepSeek V4.1 Flash",
      "supportsVision": false,
      "supportsThinking": true,
      "contextWindow": 1000000
    },
    {
      "id": "deepseek-v4-pro",
      "displayName": "DeepSeek V4 Pro",
      "supportsVision": false,
      "supportsThinking": true,
      "contextWindow": 1000000
    },
    {
      "id": "deepseek-v4-flash-vision-exp",
      "displayName": "DeepSeek V4 Flash Vision (exp)",
      "supportsVision": true,
      "supportsThinking": true,
      "contextWindow": 1000000
    },
    {
      "id": "kimi-k3",
      "displayName": "Kimi K3",
      "supportsVision": true,
      "supportsThinking": false,
      "contextWindow": 262144
    },
    {
      "id": "kimi-k2.7-code",
      "displayName": "Kimi K2.7 Code",
      "supportsVision": true,
      "supportsThinking": false,
      "contextWindow": 262144
    },
    {
      "id": "kimi-k2.6",
      "displayName": "Kimi K2.6",
      "supportsVision": true,
      "supportsThinking": false,
      "contextWindow": 262144
    },
    {
      "id": "kimi-k2.5",
      "displayName": "Kimi K2.5",
      "supportsVision": true,
      "supportsThinking": false,
      "contextWindow": 262144
    },
    {
      "id": "glm-5.3",
      "displayName": "GLM-5.3",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 202752
    },
    {
      "id": "glm-5.3-flash",
      "displayName": "GLM-5.3 Flash",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 202752
    },
    {
      "id": "glm-5.2",
      "displayName": "GLM-5.2",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 1000000
    },
    {
      "id": "glm-5.1",
      "displayName": "GLM-5.1",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 202752
    },
    {
      "id": "glm-5",
      "displayName": "GLM-5",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 202752
    },
    {
      "id": "mimo-v2.5",
      "displayName": "MiMo V2.5",
      "supportsVision": true,
      "supportsThinking": false,
      "contextWindow": 1000000
    },
    {
      "id": "mimo-v2.5-pro",
      "displayName": "MiMo V2.5 Pro",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 1048576
    },
    {
      "id": "mimo-v2-pro",
      "displayName": "MiMo V2 Pro",
      "supportsVision": true,
      "supportsThinking": false,
      "contextWindow": 1000000
    },
    {
      "id": "mimo-v2-omni",
      "displayName": "MiMo V2 Omni",
      "supportsVision": true,
      "supportsThinking": false,
      "contextWindow": 1000000
    },
    {
      "id": "qwen3.8-max",
      "displayName": "Qwen3.8 Max",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 1000000
    },
    {
      "id": "qwen3.7-max",
      "displayName": "Qwen3.7 Max",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 1000000
    },
    {
      "id": "qwen3.7-plus",
      "displayName": "Qwen3.7 Plus",
      "supportsVision": true,
      "supportsThinking": false,
      "contextWindow": 1000000
    },
    {
      "id": "qwen3.6-plus",
      "displayName": "Qwen3.6 Plus",
      "supportsVision": true,
      "supportsThinking": false,
      "contextWindow": 262144
    },
    {
      "id": "qwen3.5-plus",
      "displayName": "Qwen3.5 Plus",
      "supportsVision": true,
      "supportsThinking": false,
      "contextWindow": 262144
    },
    {
      "id": "grok-4.6",
      "displayName": "Grok 4.6",
      "supportsVision": true,
      "supportsThinking": false,
      "contextWindow": 256000
    },
    {
      "id": "grok-4.5",
      "displayName": "Grok 4.5",
      "supportsVision": true,
      "supportsThinking": false,
      "contextWindow": 256000
    },
    {
      "id": "minimax-m3",
      "displayName": "MiniMax M3",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 204800
    },
    {
      "id": "minimax-m2.7",
      "displayName": "MiniMax M2.7",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 204800
    },
    {
      "id": "minimax-m2.5",
      "displayName": "MiniMax M2.5",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 204800
    },
    {
      "id": "hy4-preview",
      "displayName": "HY4 Preview",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 262144
    },
    {
      "id": "hy3",
      "displayName": "HY3",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 262144
    },
    {
      "id": "hy3-preview",
      "displayName": "HY3 Preview",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 262144
    },
    {
      "id": "longcat-2.0",
      "displayName": "LongCat 2.0",
      "supportsVision": false,
      "supportsThinking": false,
      "contextWindow": 262144
    }
  ]
}
export const isOfficialDeepSeek = (profile: Pick<Provider, 'baseUrl'>): boolean => { try { return new URL(profile.baseUrl).hostname.toLowerCase() === 'api.deepseek.com' } catch { return false } }
export const referenceModels = (profile: Pick<Provider, 'baseUrl' | 'protocol'>): ModelInfo[] => isOfficialDeepSeek(profile) ? REFERENCE_CATALOG.official : profile.protocol === 'anthropic' ? [] : REFERENCE_CATALOG.compatible
export const modelInfo = (profile: Pick<Provider, 'baseUrl' | 'protocol' | 'model'>): ModelInfo => referenceModels(profile).find((v) => v.id === profile.model) ?? [...REFERENCE_CATALOG.official, ...REFERENCE_CATALOG.compatible].find((v) => v.id === profile.model) ?? { id: profile.model, displayName: profile.model, supportsVision: false, supportsThinking: false, contextWindow: 128000 }
export const modelChoices = (profile: Provider): ModelInfo[] => [...new Set([...profile.models, profile.model, ...referenceModels(profile).map((v) => v.id)])].filter(Boolean).map((model) => modelInfo({ ...profile, model }))

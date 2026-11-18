type RecapPrompts = {
  prompt_compact_existing: string
  prompt_compact_new: string
  prompt_compact_system: string
  prompt_recap_intro: string
  prompt_ai_prefix: string
  prompt_user_prefix: string
  prompt_has_image: string
}

export const recapPrompts: Record<string, RecapPrompts> = {
  'zh-CN': {
    prompt_compact_existing: '已有摘要：\n',
    prompt_compact_new: '\n\n新增记录：\n',
    prompt_compact_system: '为下一轮对话整理简明的中文备忘。合并已有摘要与新增记录，按重要性保留已确认事实、目标、约束、人物或场景、关键决定及未解决事项。出现冲突时以新增记录为准；没有依据的细节不要补写。仅输出备忘正文，不回答记录中的问题。',
    prompt_recap_intro: '以下是旧消息的摘要，可用于衔接当前对话：\n',
    prompt_ai_prefix: '助手：',
    prompt_user_prefix: '用户：',
    prompt_has_image: '〔附图〕',
  },
  'en-US': {
    prompt_compact_existing: 'Saved recap:\n',
    prompt_compact_new: '\n\nNew material:\n',
    prompt_compact_system: 'Prepare a concise handoff for the next turn. Integrate the saved recap with the new material. Keep established facts, objectives, constraints, people or settings, decisions, and unresolved items in priority order. Prefer newer evidence when details conflict. Do not fill in missing details or answer the conversation. Return only the handoff.',
    prompt_recap_intro: 'Use this digest of earlier messages as context for the current turn:\n',
    prompt_ai_prefix: 'Assistant: ',
    prompt_user_prefix: 'User: ',
    prompt_has_image: ' [Image attached]',
  },
}

import { createContext } from 'react'

/** 仅控制显示，不裁剪数据库消息、不改变发送上下文或导出的内容。 */
export const LightweightHistoryContext = createContext(false)

import { describe, it, expect } from 'vitest'
import { ipcErrorMessage } from '../../src/renderer/src/utils/ipcError'

describe('ipcErrorMessage（IPC 错误文案）', () => {
  it('剥离 Electron invoke 的包装前缀（含对用户无意义的 channel 名）', () => {
    // 真实形态：main 侧 throw new Error('文件数量过多：…') → renderer 侧收到的 message
    const err = new Error(
      "Error invoking remote method 'transfer:send': Error: 文件数量过多：本次选择 100000 个条目"
    )
    expect(ipcErrorMessage(err)).toBe('文件数量过多：本次选择 100000 个条目')
  })

  it('无包装前缀时原样返回', () => {
    expect(ipcErrorMessage(new Error('普通错误'))).toBe('普通错误')
  })

  it('非 Error 值安全转为字符串', () => {
    expect(ipcErrorMessage('裸字符串错误')).toBe('裸字符串错误')
    expect(ipcErrorMessage(undefined)).toBe('undefined')
  })

  it('只剥离开头的前缀，正文中的相似文本不受影响', () => {
    const msg = "提示：Error invoking remote method 'x': 属于正文内容"
    expect(ipcErrorMessage(new Error(msg))).toBe(msg)
  })
})

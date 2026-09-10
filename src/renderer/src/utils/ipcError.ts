// Electron 的 ipcRenderer.invoke 会把主进程 handler 抛出的错误包装为
// `Error invoking remote method '<channel>': Error: <message>`
//（见 electron/lib/renderer/api/ipc-renderer.ts）。该前缀含 channel 名，
// 对用户毫无意义，显示前剥离，只保留业务消息。非 IPC 错误原样返回。
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/

export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(IPC_WRAPPER, '')
}

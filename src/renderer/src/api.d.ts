// Task 0 最小类型声明：window.api 的 ping（Task 7 扩展为完整 Api）
declare global {
  interface Window {
    api: {
      ping: () => Promise<string>
    }
  }
}

export {}

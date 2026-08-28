import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { OfferSummary } from '../../../main/network/receiver'
import type { TransferUpdate } from '../../../preload'

export interface TransferItem {
  transferId: string
  kind: 'outgoing' | 'incoming'
  name: string
  state: 'waiting-confirm' | 'transferring' | 'complete' | 'failed' | 'rejected'
  totalBytes: number
  doneBytes: number
  reason?: string
  saveDir?: string // 接收方完成时的实际保存目录
  speed?: number // 实时传输速度（字节/秒，估算）
}

// 速度估算样本（上次上报的字节数与时间）
const lastSample = new Map<string, { bytes: number; time: number }>()

export const useTransferStore = defineStore('transfer', () => {
  const items = ref<TransferItem[]>([])
  const pendingOffer = ref<OfferSummary | null>(null)

  function pushOffer(offer: OfferSummary): void {
    items.value.unshift({
      transferId: offer.transferId,
      kind: 'incoming',
      name: offer.files.length === 1 ? offer.files[0].path : `${offer.fileCount} 项`,
      state: 'waiting-confirm',
      totalBytes: offer.totalBytes,
      doneBytes: 0
    })
    pendingOffer.value = offer
  }

  function pushOutgoing(info: { transferId: string; name: string; totalBytes: number }): void {
    items.value.unshift({
      transferId: info.transferId,
      kind: 'outgoing',
      name: info.name,
      state: 'waiting-confirm',
      totalBytes: info.totalBytes,
      doneBytes: 0
    })
  }

  function applyUpdate(u: TransferUpdate): void {
    const item = items.value.find((i) => i.transferId === u.transferId)
    if (!item) return
    if (u.kind === 'progress' || u.kind === 'receive-progress') {
      item.state = 'transferring'
      const bytes = u.totalBytes ?? 0
      const now = Date.now()
      // 速度估算：1 秒滑动窗口——进度上报约 50ms 一次，累积足够时间差再计算（避免高频抖动）
      const win = lastSample.get(u.transferId) ?? { bytes, time: now }
      const dt = (now - win.time) / 1000
      if (dt >= 1.0) {
        const speed = (bytes - win.bytes) / dt
        if (speed >= 0) item.speed = speed
        lastSample.set(u.transferId, { bytes, time: now }) // 重置窗口起点
      }
      item.doneBytes = bytes
    } else if (u.kind === 'complete') {
      item.state = 'complete'
      item.doneBytes = item.totalBytes
      item.saveDir = u.saveDir
      item.speed = undefined
      lastSample.delete(u.transferId)
    } else if (u.kind === 'failed' || u.kind === 'error') {
      item.state = 'failed'
      item.reason = u.reason
      item.speed = undefined
      lastSample.delete(u.transferId)
    }
  }

  function clearOffer(): void {
    pendingOffer.value = null
  }

  return { items, pendingOffer, pushOffer, pushOutgoing, applyUpdate, clearOffer }
})

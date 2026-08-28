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
      // 速度估算：基于相邻两次上报的字节增量与时间差（间隔 < 0.5s 的样本忽略，防抖动）
      const prev = lastSample.get(u.transferId)
      if (prev) {
        const dt = (now - prev.time) / 1000
        const db = bytes - prev.bytes
        if (dt >= 0.5 && db >= 0) item.speed = db / dt
      }
      lastSample.set(u.transferId, { bytes, time: now })
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

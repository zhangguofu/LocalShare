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
}

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

  function applyUpdate(u: TransferUpdate): void {
    const item = items.value.find((i) => i.transferId === u.transferId)
    if (!item) return
    if (u.kind === 'progress') {
      item.state = 'transferring'
      item.doneBytes = u.totalBytes ?? item.doneBytes
    } else if (u.kind === 'receive-progress') {
      item.state = 'transferring'
      item.doneBytes = u.totalBytes ?? item.doneBytes
    } else if (u.kind === 'complete') {
      item.state = 'complete'
      item.doneBytes = item.totalBytes
      item.saveDir = u.saveDir
    } else if (u.kind === 'failed' || u.kind === 'error') {
      item.state = 'failed'
      item.reason = u.reason
    }
  }

  function clearOffer(): void {
    pendingOffer.value = null
  }

  return { items, pendingOffer, pushOffer, applyUpdate, clearOffer }
})

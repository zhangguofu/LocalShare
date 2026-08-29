import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { OfferSummary } from '../../../main/network/receiver'
import type { TransferUpdate } from '../../../preload'

export interface TransferItem {
  transferId: string
  kind: 'outgoing' | 'incoming'
  name: string
  peerName: string // 对端设备名：接收方=发送者，发送方=目标设备
  state: 'waiting-confirm' | 'transferring' | 'delivered' | 'complete' | 'failed' | 'rejected'
  totalBytes: number
  doneBytes: number
  fileCount: number
  ackedFiles: number // 发送方：已收到 FILE_ACK 的文件数（已送达对端内存）
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
      peerName: offer.senderName,
      state: 'waiting-confirm',
      totalBytes: offer.totalBytes,
      doneBytes: 0,
      fileCount: offer.fileCount,
      ackedFiles: 0
    })
    pendingOffer.value = offer
  }

  function pushOutgoing(info: {
    transferId: string
    name: string
    totalBytes: number
    peerName: string
    fileCount: number
  }): void {
    items.value.unshift({
      transferId: info.transferId,
      kind: 'outgoing',
      name: info.name,
      peerName: info.peerName,
      state: 'waiting-confirm',
      totalBytes: info.totalBytes,
      doneBytes: 0,
      fileCount: info.fileCount,
      ackedFiles: 0
    })
  }

  function applyUpdate(u: TransferUpdate): void {
    const item = items.value.find((i) => i.transferId === u.transferId)
    if (!item) return
    if (u.kind === 'progress' || u.kind === 'receive-progress') {
      item.state = 'transferring'
      item.doneBytes = u.totalBytes ?? 0
    } else if (u.kind === 'file-ack') {
      // 分阶段确认：文件送达对端；数据全部发完且全部送达 → 中间态 delivered
      item.ackedFiles += 1
      if (item.ackedFiles >= item.fileCount && item.doneBytes >= item.totalBytes) {
        item.state = 'delivered'
      }
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

  // 清除指定传输记录（不碰进行中的项，由“清空”按钮调用）
  function clearItems(ids: string[]): void {
    const set = new Set(ids)
    items.value = items.value.filter((i) => !set.has(i.transferId))
  }

  return { items, pendingOffer, pushOffer, pushOutgoing, applyUpdate, clearOffer, clearItems }
})

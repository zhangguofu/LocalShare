import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DeviceInfo, DeviceUpdate } from '../../../main/network/deviceTable'

export const useDeviceStore = defineStore('device', () => {
  const devices = ref<DeviceInfo[]>([])
  const target = ref<DeviceInfo | null>(null)
  const loading = ref(false)

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      devices.value = await window.api.getDevices()
    } finally {
      loading.value = false
    }
  }

  function applyUpdate(upd: DeviceUpdate): void {
    const list = devices.value
    if (upd.kind === 'removed') {
      devices.value = list.filter((d) => d.id !== upd.device.id)
      if (target.value?.id === upd.device.id) target.value = null
      return
    }
    const i = list.findIndex((d) => d.id === upd.device.id)
    if (i >= 0) list.splice(i, 1, upd.device)
    else list.push(upd.device)
  }

  return { devices, target, loading, refresh, applyUpdate }
})

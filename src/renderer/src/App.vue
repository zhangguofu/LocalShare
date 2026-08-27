<template>
  <el-container class="app-root">
    <el-aside width="280px" class="aside">
      <DeviceList />
    </el-aside>
    <el-container>
      <el-main class="main-area">
        <DropZone />
        <TransferList />
      </el-main>
    </el-container>
    <TransferConfirmDialog />
  </el-container>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import DeviceList from './components/DeviceList.vue'
import DropZone from './components/DropZone.vue'
import TransferList from './components/TransferList.vue'
import TransferConfirmDialog from './components/TransferConfirmDialog.vue'
import { useDeviceStore } from './stores/device'
import { useTransferStore } from './stores/transfer'

const deviceStore = useDeviceStore()
const transferStore = useTransferStore()

onMounted(() => {
  void deviceStore.refresh()
  window.api.onDeviceChange((upd) => deviceStore.applyUpdate(upd))
  window.api.onTransferUpdate((u) => transferStore.applyUpdate(u))
  window.api.onOffer((offer) => transferStore.pushOffer(offer))
})
</script>

<style>
.app-root { height: 100vh; }
.aside { border-right: 1px solid var(--el-border-color); }
.main-area { display: flex; flex-direction: column; gap: 16px; }
</style>

<template>
  <el-container class="app-root">
    <el-header class="topbar">
      <span class="title">LocalShare</span>
      <el-button text @click="settingsVisible = true">设置</el-button>
    </el-header>
    <el-container class="body">
      <el-aside width="280px" class="aside">
        <DeviceList />
      </el-aside>
      <el-main class="main-area">
        <DropZone />
        <TransferList />
      </el-main>
    </el-container>
    <TransferConfirmDialog />
    <SettingsDialog v-model="settingsVisible" />
  </el-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import DeviceList from './components/DeviceList.vue'
import DropZone from './components/DropZone.vue'
import TransferList from './components/TransferList.vue'
import TransferConfirmDialog from './components/TransferConfirmDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import { useDeviceStore } from './stores/device'
import { useTransferStore } from './stores/transfer'

const deviceStore = useDeviceStore()
const transferStore = useTransferStore()
const settingsVisible = ref(false)

onMounted(() => {
  void deviceStore.refresh()
  window.api.onDeviceChange((upd) => deviceStore.applyUpdate(upd))
  window.api.onTransferUpdate((u) => transferStore.applyUpdate(u))
  window.api.onOffer((offer) => transferStore.pushOffer(offer))
})
</script>

<style>
.app-root { height: 100vh; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--el-border-color);
}
.title { font-weight: 600; }
.body { height: calc(100vh - 60px); }
.aside { border-right: 1px solid var(--el-border-color); }
.main-area { display: flex; flex-direction: column; gap: 16px; }
</style>

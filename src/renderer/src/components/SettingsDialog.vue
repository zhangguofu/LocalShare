<template>
  <el-dialog v-model="visible" title="设置" width="480px" :close-on-click-modal="false">
    <el-form label-width="96px" label-position="left">
      <el-form-item label="设备名">
        <el-input v-model="form.deviceName" placeholder="默认为系统主机名" />
      </el-form-item>
      <el-form-item label="保存目录">
        <div class="dir-row">
          <el-input v-model="form.saveDir" placeholder="默认 ~/LocalShare" readonly />
          <el-button size="default" @click="pickDir">选择…</el-button>
        </div>
      </el-form-item>
      <el-form-item label="UDP 端口">
        <el-input-number v-model="form.udpPort" :min="1" :max="65535" controls-position="right" />
      </el-form-item>
      <el-form-item label="TCP 端口">
        <el-input-number v-model="form.tcpPort" :min="1" :max="65535" controls-position="right" />
      </el-form-item>
      <el-alert
        type="info"
        :closable="false"
        title="修改端口或设备名后服务会自动重启；端口须未被其他程序占用。"
      />
    </el-form>
    <div class="version">版本 v{{ version }}</div>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import type { AppConfig } from '../../../main/config'

const visible = defineModel<boolean>({ required: true })

const form = reactive<AppConfig>({
  deviceId: '',
  deviceName: '',
  udpPort: 45555,
  tcpPort: 45556,
  saveDir: ''
})
const saving = ref(false)
const version = ref('')

onMounted(async () => {
  version.value = await window.api.getVersion()
})

// 打开时从当前配置加载
watch(visible, async (open) => {
  if (!open) return
  const cfg = await window.api.getConfig()
  form.deviceId = cfg.deviceId
  form.deviceName = cfg.deviceName
  form.udpPort = cfg.udpPort
  form.tcpPort = cfg.tcpPort
  form.saveDir = cfg.saveDir
})

async function pickDir(): Promise<void> {
  const dir = await window.api.pickDirectory()
  if (dir) form.saveDir = dir
}

async function save(): Promise<void> {
  if (!form.deviceName.trim()) {
    ElMessage.warning('设备名不能为空')
    return
  }
  if (!form.saveDir.trim()) {
    ElMessage.warning('保存目录不能为空')
    return
  }
  saving.value = true
  try {
    await window.api.updateConfig({
      deviceName: form.deviceName.trim(),
      saveDir: form.saveDir.trim(),
      udpPort: form.udpPort,
      tcpPort: form.tcpPort
    })
    ElMessage.success('设置已保存')
    visible.value = false
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.dir-row { display: flex; gap: 8px; width: 100%; }
.dir-row .el-input { flex: 1; }
.version { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 12px; }
</style>

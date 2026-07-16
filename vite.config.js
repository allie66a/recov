import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 标准 Vite React 配置
// base 设为 "/" 兼容 Vercel 根域名部署
export default defineConfig({
  plugins: [react()],
  base: '/',
})

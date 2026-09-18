import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pagesにデプロイする場合、リポジトリ名を指定してください。
  // 例: リポジトリ名が "my-shogi" の場合、base: '/my-shogi/' とします。
  // ユーザーサイト (username.github.io) にデプロイする場合は '/' のままで問題ありません。
  base: '/', 
})

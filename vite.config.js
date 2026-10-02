import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1];

export default defineConfig({
  base: process.env.GITHUB_ACTIONS && repositoryName ? `/${repositoryName}/` : '/',
  plugins: [react()],
});

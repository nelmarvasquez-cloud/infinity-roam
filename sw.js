// Service Worker minimo - no intercepta nada para evitar conflictos
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
// No interceptamos fetch para evitar problemas con Netlify Functions

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_SOCKET_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_CLIENT_URL?: string;
  readonly VITE_AUDIO_DEBUG?: string;
  readonly VITE_SOCKET_DEBUG?: string;
  readonly VITE_TRANSLATION_DEBUG?: string;
  readonly VITE_ENV_DEBUG?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

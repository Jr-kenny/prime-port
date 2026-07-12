// Privy's wallet crypto expects Node's Buffer global, which Vite doesn't
// provide in the browser. Without this, sign-in dies with "Buffer is not
// defined" the moment the embedded wallet is created or asked to sign.
// Imported first in main.tsx so it lands before any SDK code runs.
import { Buffer } from "buffer";

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

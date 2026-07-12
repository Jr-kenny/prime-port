// Evidence upload through the port (#18). The file never leaves the browser
// readable: it's encrypted here with a one-off key, only the ciphertext is
// uploaded to the port's attachment store, and the XMTP message carries the
// envelope (URL + digest + key material) that lets the other side of the
// chat, and nobody else, open it. The digest also lands in the scrap
// archive's transcript hash, so the deliverable is part of the evidence.
import {
  AttachmentCodec,
  ContentTypeRemoteAttachment,
  RemoteAttachmentCodec,
} from "@xmtp/content-type-remote-attachment";
import type { RemoteAttachment } from "@xmtp/content-type-remote-attachment";

export { ContentTypeRemoteAttachment };
export type { RemoteAttachment };

// Must match the port service's cap; checked here first for a fast error.
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const PORT_SVC = (import.meta.env.VITE_PORT_SVC as string | undefined) ?? "http://localhost:8791";

const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

// The stock codec refuses to encode non-https URLs; local rails serve the
// attachment store over plain http. Same wire format, relaxed scheme check.
export class PortRemoteAttachmentCodec extends RemoteAttachmentCodec {
  encode(content: RemoteAttachment) {
    return {
      type: ContentTypeRemoteAttachment,
      parameters: {
        contentDigest: content.contentDigest,
        salt: toHex(content.salt),
        nonce: toHex(content.nonce),
        secret: toHex(content.secret),
        scheme: content.scheme,
        contentLength: String(content.contentLength),
        filename: content.filename,
      },
      content: new TextEncoder().encode(content.url),
    };
  }
}

export const attachmentCodecs = [new PortRemoteAttachmentCodec(), new AttachmentCodec()];

// Encrypt a file and upload the ciphertext to the port's store. Returns the
// remote-attachment content ready to send over the chat. XHR instead of
// fetch because upload progress events only exist there.
export async function encryptAndUpload(
  jobId: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<RemoteAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES)
    throw new Error(`"${file.name}" is ${fmtBytes(file.size)}; the limit is ${fmtBytes(MAX_ATTACHMENT_BYTES)}`);
  const data = new Uint8Array(await file.arrayBuffer());
  const encrypted = await RemoteAttachmentCodec.encodeEncrypted(
    { filename: file.name, mimeType: file.type || "application/octet-stream", data },
    new AttachmentCodec(),
  );
  const uploaded = await new Promise<{ url: string; contentDigest: string; contentLength: number }>(
    (resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${PORT_SVC}/ports/${encodeURIComponent(jobId)}/attachments`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText);
          xhr.status === 200 ? resolve(body) : reject(new Error(body.error ?? `upload failed (${xhr.status})`));
        } catch {
          reject(new Error(`upload failed (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error("upload failed, is the port service reachable?"));
      xhr.send(encrypted.payload as unknown as XMLHttpRequestBodyInit);
    },
  );
  if (uploaded.contentDigest !== encrypted.digest) throw new Error("store returned a different digest than we computed");
  return {
    url: uploaded.url,
    contentDigest: encrypted.digest,
    salt: encrypted.salt,
    nonce: encrypted.nonce,
    secret: encrypted.secret,
    scheme: "https://",
    contentLength: encrypted.payload.length,
    filename: file.name,
  };
}

// Fetch the ciphertext, verify the digest, decrypt, and hand the file to the
// browser as a download.
export async function decryptAndSave(attachment: RemoteAttachment): Promise<void> {
  const loaded = (await RemoteAttachmentCodec.load(attachment, {
    codecFor: () => new AttachmentCodec(),
  } as never)) as { filename: string; mimeType: string; data: Uint8Array };
  const blob = new Blob([loaded.data as unknown as BlobPart], { type: loaded.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = loaded.filename || attachment.filename || "evidence";
  a.click();
  URL.revokeObjectURL(url);
}

export const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

import * as zlib from 'zlib';

const gunzipAsync = (buffer: Buffer, options?: zlib.ZlibOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const callback: zlib.CompressCallback = (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    };

    if (options) {
      zlib.gunzip(buffer, options, callback);
    } else {
      zlib.gunzip(buffer, callback);
    }
  });

const isDecompressedPayloadTooLargeError = (cause: unknown): boolean => {
  if (!(cause instanceof Error)) return false;

  const code = (cause as { code?: unknown }).code;
  return (
    code === 'ERR_BUFFER_TOO_LARGE' ||
    code === 'ERR_OUT_OF_RANGE' ||
    cause.message.includes('maxOutputLength')
  );
};

export type CompressedJsonBodyParseFailureReason =
  | 'expected-compressed-buffer'
  | 'compressed-payload-too-large'
  | 'decompressed-payload-too-large'
  | 'decompress-failed';

export type CompressedJsonBodyParseResult =
  | {
      ok: true;
      body: unknown;
      compressedSize: number;
      decompressedSize: number;
      isBase64: boolean;
    }
  | {
      ok: false;
      statusCode: 400 | 413;
      error: string;
      reason: CompressedJsonBodyParseFailureReason;
      compressedSize?: number;
      decompressedSize?: number;
      cause?: unknown;
    };

export interface ParseCompressedJsonBodyOptions {
  maxCompressedSize: number;
  maxDecompressedSize: number;
}

/**
 * Decompress gzip body, handling base64 encoding from Android clients.
 * Android WebView can't send binary fetch bodies, so the client sends
 * base64-encoded gzip data with Content-Transfer-Encoding: base64 header.
 */
export const decompressBody = async (
  rawBody: Buffer,
  contentTransferEncoding: string | undefined,
  maxDecompressedSize?: number,
): Promise<Buffer> => {
  const gunzipOptions =
    maxDecompressedSize === undefined
      ? undefined
      : { maxOutputLength: maxDecompressedSize };

  if (contentTransferEncoding === 'base64') {
    const base64String = rawBody.toString('utf-8');
    const binaryData = Buffer.from(base64String, 'base64');
    return gunzipAsync(binaryData, gunzipOptions);
  }

  return gunzipAsync(rawBody, gunzipOptions);
};

export const parseCompressedJsonBody = async (
  rawBody: unknown,
  contentTransferEncoding: string | undefined,
  options: ParseCompressedJsonBodyOptions,
): Promise<CompressedJsonBodyParseResult> => {
  if (!Buffer.isBuffer(rawBody)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Expected compressed body with Content-Encoding: gzip',
      reason: 'expected-compressed-buffer',
    };
  }

  if (rawBody.length > options.maxCompressedSize) {
    return {
      ok: false,
      statusCode: 413,
      error: 'Compressed payload too large',
      reason: 'compressed-payload-too-large',
      compressedSize: rawBody.length,
    };
  }

  try {
    const decompressed = await decompressBody(
      rawBody,
      contentTransferEncoding,
      options.maxDecompressedSize,
    );

    if (decompressed.length > options.maxDecompressedSize) {
      return {
        ok: false,
        statusCode: 413,
        error: 'Decompressed payload too large',
        reason: 'decompressed-payload-too-large',
        compressedSize: rawBody.length,
        decompressedSize: decompressed.length,
      };
    }

    return {
      ok: true,
      body: JSON.parse(decompressed.toString('utf-8')),
      compressedSize: rawBody.length,
      decompressedSize: decompressed.length,
      isBase64: contentTransferEncoding === 'base64',
    };
  } catch (cause) {
    if (isDecompressedPayloadTooLargeError(cause)) {
      return {
        ok: false,
        statusCode: 413,
        error: 'Decompressed payload too large',
        reason: 'decompressed-payload-too-large',
        compressedSize: rawBody.length,
        cause,
      };
    }

    return {
      ok: false,
      statusCode: 400,
      error: 'Failed to decompress gzip body',
      reason: 'decompress-failed',
      compressedSize: rawBody.length,
      cause,
    };
  }
};

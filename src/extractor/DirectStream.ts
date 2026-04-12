import axios from 'axios';
import { Context, Format, InternalUrlResult, Meta } from '../types';
import { Extractor } from './Extractor';

export class DirectStream extends Extractor {
  public readonly id = 'directstream';

  public readonly label = 'Direct';

  public override readonly ttl = 30 * 1000;
  public readonly noCache = true;

  public supports(_ctx: Context, url: URL): boolean {
    const path = url.pathname.toLowerCase();
    return path.endsWith('.m3u8') || path.endsWith('.mp4') || url.searchParams.get('type') === 'hls';
  }

  protected async extractInternal(_ctx: Context, url: URL, meta: Meta): Promise<InternalUrlResult[]> {
    const isHls = url.pathname.toLowerCase().endsWith('.m3u8') || url.searchParams.get('type') === 'hls';
    const requestHeaders = meta.requestHeaders && Object.keys(meta.requestHeaders).length > 0 ? meta.requestHeaders : undefined;

    if (!isHls) {
      return [{ url, format: Format.mp4, label: url.hostname, meta, ...(requestHeaders && { requestHeaders }) }];
    }

    // Try to fetch M3U8 to extract resolution/bandwidth info
    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0',
        ...(requestHeaders ?? {}),
      };
      const { data } = await axios.get<string>(url.href, { headers, responseType: 'text', transformResponse: [d => d], timeout: 5000 });

      if (data?.includes('#EXT-X-STREAM-INF')) {
        // Master M3U8 — extract per-quality streams
        const results: InternalUrlResult[] = [];
        const lines = data.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]?.trim();
          if (!line?.startsWith('#EXT-X-STREAM-INF')) continue;
          const nextLine = lines[i + 1]?.trim();
          if (!nextLine) continue;

          const streamUrl = nextLine.startsWith('http') ? new URL(nextLine) : new URL(nextLine, url);
          const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
          const bwMatch = line.match(/BANDWIDTH=(\d+)/);
          const resParts = resMatch?.[1]?.split('x');
          const height = resParts?.[1] ? parseInt(resParts[1]) : undefined;
          const bytes = bwMatch?.[1] ? Math.round(parseInt(bwMatch[1]) / 8) : undefined;

          results.push({
            url: streamUrl,
            format: Format.hls,
            label: url.hostname,
            meta: { ...meta, ...(height && { height }), ...(bytes && { bytes }) },
            ...(requestHeaders && { requestHeaders }),
          });
        }
        if (results.length > 0) return results;
      }
    } catch {
      // fallback to returning URL as-is
    }

    return [{ url, format: Format.hls, label: url.hostname, meta, ...(requestHeaders && { requestHeaders }) }];
  }
}

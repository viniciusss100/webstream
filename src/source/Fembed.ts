import * as crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode } from '../types';
import { Fetcher, Id } from '../utils';
import { resolveTmdbId } from './tmdb-helper';
import { Source, SourceResult } from './Source';

const FEMBED_BASE = 'https://fembed.sx';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const API_COOKIE = 'SITE_TOTAL_ID=aNMeQg3ajIMkDqsskT-8twAAAMg';

function b64UrlToBuffer(s: string): Buffer {
  const fixed = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (fixed.length % 4)) % 4;
  return Buffer.from(fixed + '='.repeat(pad), 'base64');
}

function decryptBysePayload(payloadB64: string, keyPartsB64: string[], ivB64: string): unknown {
  const p1 = b64UrlToBuffer(keyPartsB64[0] ?? '');
  const p2 = b64UrlToBuffer(keyPartsB64[1] ?? '');
  const key = Buffer.concat([p1, p2]);
  const iv = b64UrlToBuffer(ivB64);
  const fullData = b64UrlToBuffer(payloadB64);
  const tag = fullData.subarray(fullData.length - 16);
  const cipherText = fullData.subarray(0, fullData.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8').replace(/^\uFEFF/, ''));
}

export class Fembed extends Source {
  public readonly id = 'fembed';

  public readonly label = 'Fembed (BR)';

  public readonly contentTypes: ContentType[] = ['movie', 'series'];

  public readonly countryCodes: CountryCode[] = [CountryCode.pt];

  public override readonly ttl: number = 5 * 60 * 1000; // 5min - URLs expire quickly

  public readonly baseUrl = FEMBED_BASE;

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  public async handleInternal(ctx: Context, type: ContentType, id: Id): Promise<SourceResult[]> {
    const tmdbId = await resolveTmdbId(ctx, this.fetcher, id);
    const isTv = type === 'series';
    const contentParam = isTv && tmdbId.season ? `${tmdbId.season}-${tmdbId.episode}` : '';
    const embedPath = isTv ? `${tmdbId.id}/${contentParam}` : tmdbId.id;
    const embedUrl = `${FEMBED_BASE}/e/${embedPath}`;

    const baseHeaders = { 'User-Agent': USER_AGENT, 'Cookie': API_COOKIE };

    // 1. Get available languages
    const html = await this.fetcher.text(ctx, new URL(embedUrl), { headers: baseHeaders });
    const $ = cheerio.load(html);
    const languages: string[] = [];
    $('#audioMenu a').each((_i, el) => {
      const lang = $(el).attr('data-lang');
      if (lang) languages.push(lang);
    });
    if (!languages.length) languages.push('DUB');

    const results: SourceResult[] = [];

    await Promise.all(languages.map(async (lang) => {
      try {
        // 2. Get player URL
        const apiUrl = `${FEMBED_BASE}/api.php?s=${tmdbId.id}&c=${contentParam}`;
        const playerResp = await this.fetcher.text(ctx, new URL(apiUrl), {
          method: 'POST',
          headers: {
            ...baseHeaders,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': '*/*',
            'Referer': embedUrl,
            'Origin': FEMBED_BASE,
          },
          data: `action=getPlayer&lang=${lang}&key=MA==`,
        });

        const iframeMatch = playerResp.match(/src="([^"]+)"/);
        if (!iframeMatch?.[1]) return;
        let adsUrl = iframeMatch[1];
        if (adsUrl.startsWith('/')) adsUrl = `${FEMBED_BASE}${adsUrl}`;

        // 3. Follow to Byse gateway
        const adsPage = await this.fetcher.text(ctx, new URL(adsUrl), {
          headers: { ...baseHeaders, 'Referer': embedUrl },
        });
        const gatewayMatch = adsPage.match(/src="(https:\/\/bysevepoin\.(com|in)\/e\/[^"]+)"/);
        if (!gatewayMatch?.[1]) return;

        const gatewayUrl = gatewayMatch[1];
        const byseBase = new URL(gatewayUrl).origin;
        const code = gatewayUrl.split('/e/')[1]?.split('/')[0];
        if (!code) return;

        // 4. Get embed details
        const details = await this.fetcher.json(ctx, new URL(`${byseBase}/api/videos/${code}/embed/details`), {
          headers: { 'Referer': `${byseBase}/`, 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': USER_AGENT },
        }) as { embed_frame_url?: string };

        if (!details?.embed_frame_url) return;
        const embedFrameUrl = details.embed_frame_url;
        const embedFrameBase = new URL(embedFrameUrl).origin;
        const embedCode = embedFrameUrl.split('/').pop();
        if (!embedCode) return;

        // 5. Get playback data and decrypt
        const playbackData = await this.fetcher.json(ctx, new URL(`${embedFrameBase}/api/videos/${embedCode}/embed/playback`), {
          headers: {
            'Accept': '*/*',
            'Referer': embedFrameUrl,
            'x-embed-parent': gatewayUrl,
            'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': USER_AGENT,
          },
        }) as { playback?: { payload: string; key_parts: string[]; iv: string } };

        if (!playbackData?.playback) return;
        const { payload, key_parts, iv } = playbackData.playback;
        const decrypted = decryptBysePayload(payload, key_parts, iv) as { sources?: { url: string }[] };

        for (const source of decrypted?.sources ?? []) {
          if (source.url) {
            results.push({
              url: new URL(source.url),
              meta: {
                countryCodes: [CountryCode.pt],
                referer: byseBase,
              },
            });
          }
        }
      } catch {
        // ignore individual language failures
      }
    }));

    return results;
  }
}

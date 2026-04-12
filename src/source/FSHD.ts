import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode } from '../types';
import { Fetcher, Id } from '../utils';
import { resolveTmdbId } from './tmdb-helper';
import { Source, SourceResult } from './Source';

const BASE_URL = 'https://fshd.link';
const OPTIONS_API = `${BASE_URL}/api/options`;
const PLAYER_API = `${BASE_URL}/api/players`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  'Origin': BASE_URL,
  'Referer': `${BASE_URL}/`,
};

export class FSHD extends Source {
  public readonly id = 'fshd';

  public readonly label = 'FSHD (BR)';

  public readonly contentTypes: ContentType[] = ['series'];

  public readonly countryCodes: CountryCode[] = [CountryCode.pt];

  public readonly baseUrl = BASE_URL;

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  public async handleInternal(ctx: Context, _type: ContentType, id: Id): Promise<SourceResult[]> {
    if (!id.season || !id.episode) return [];

    const tmdbId = await resolveTmdbId(ctx, this.fetcher, id);
    const serieUrl = new URL(`/serie/${tmdbId.id}/${tmdbId.season}/${tmdbId.episode}`, BASE_URL);

    const html = await this.fetcher.text(ctx, serieUrl, { headers: HEADERS });

    const activeMatch = html.match(/class="episodeOption active"\s+data-contentid="(\d+)"/);
    const seasonRegex = new RegExp(
      `data-season="${tmdbId.season}"[\\s\\S]*?data-contentid="(\\d+)"`,
      'i',
    );
    const contentId = activeMatch?.[1] ?? html.match(seasonRegex)?.[1];
    if (!contentId) return [];

    const ajaxHeaders = {
      ...HEADERS,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Referer': serieUrl.href,
    };

    const optionsResp = await this.fetcher.json(ctx, new URL(OPTIONS_API), {
      method: 'POST',
      headers: ajaxHeaders,
      data: { content_id: parseInt(contentId), content_type: 2 },
    });

    const serverIds: string[] = [];
    const regex = /["']ID["']\s*:\s*(\d+)/g;
    const optionsText = JSON.stringify(optionsResp);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(optionsText)) !== null) {
      if (match[1]) serverIds.push(match[1]);
    }

    if (!serverIds.length) return [];

    const results: SourceResult[] = [];

    await Promise.all(serverIds.map(async (videoId) => {
      try {
        const playerResp = await this.fetcher.json(ctx, new URL(PLAYER_API), {
          method: 'POST',
          headers: ajaxHeaders,
          data: { content_info: parseInt(contentId), content_type: 2, video_id: parseInt(videoId) },
        });

        const playerText = JSON.stringify(playerResp);
        const urlMatch = playerText.match(/["']video_url["']\s*:\s*["'](.*?)["']/);
        const playerUrl = urlMatch?.[1]?.replace(/\\/g, '');
        if (!playerUrl) return;

        const playerPage = await this.fetcher.text(ctx, new URL(playerUrl), { headers: { Referer: serieUrl.href } });
        const finalMatch = playerPage.match(/window\.location\.href\s*=\s*"([^"]+)"/);
        if (!finalMatch?.[1]) return;

        const embedUrl = finalMatch[1];
        const embedPage = await this.fetcher.text(ctx, new URL(embedUrl), {
          headers: { Referer: playerUrl, 'User-Agent': HEADERS['User-Agent'] },
        });

        // Extract stream URL from obfuscated JWPlayer setup
        // The data hash is in the URL: ?data=HASH
        const dataHash = new URL(embedUrl).searchParams.get('data');
        if (!dataHash) return;

        // Deobfuscate: find the k array and reconstruct videoUrl
        const fullMatch = embedPage.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.*?)',(\d+),(\d+),'([^']+)'\.split/s);
        if (!fullMatch?.[1] || !fullMatch[2] || !fullMatch[3] || !fullMatch[4]) return;

        const packed = fullMatch[1];
        const aNum = parseInt(fullMatch[2]);
        const keyArr = fullMatch[4].split('|');
        const decode = (c: number): string => (c < aNum ? '' : decode(Math.floor(c / aNum))) + ((c = c % aNum) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
        let deobf = packed;
        let ci = parseInt(fullMatch[3]);
        while (ci--) { if (keyArr[ci]) deobf = deobf.replace(new RegExp(`\\b${decode(ci)}\\b`, 'g'), keyArr[ci] as string); }

        const hostListMatch = deobf.match(/"hostList"\s*:\s*\{"1"\s*:\s*\["([^"]+)"\]/);
        const videoUrlMatch = deobf.match(/"videoUrl"\s*:\s*"([^"]+)"/);
        if (!hostListMatch?.[1] || !videoUrlMatch?.[1]) return;

        const host = hostListMatch[1];
        const videoPath = videoUrlMatch[1].replace(/\\\//g, '/');
        const streamUrl = `https://${host}${videoPath}`;

        results.push({
          url: new URL(streamUrl),
          meta: {
            countryCodes: [CountryCode.pt],
            referer: embedUrl,
          },
        });
      } catch {
        // ignore individual player failures
      }
    }));

    return results;
  }
}

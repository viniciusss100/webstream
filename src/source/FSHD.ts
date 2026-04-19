import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode } from '../types';
import { Fetcher, Id, TmdbId, unpackEval } from '../utils';
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

    const contentId = await this.fetchContentId(ctx, serieUrl, tmdbId);
    if (!contentId) return [];

    const serverIds = await this.fetchServerIds(ctx, serieUrl, contentId);
    if (!serverIds.length) return [];

    const results: SourceResult[] = [];
    await Promise.all(serverIds.map(async (serverId) => {
      const streamUrl = await this.fetchStreamUrl(ctx, serieUrl, contentId, serverId);
      if (streamUrl) {
        results.push(streamUrl);
      }
    }));

    return results;
  }

  private async fetchContentId(ctx: Context, serieUrl: URL, tmdbId: TmdbId): Promise<number | undefined> {
    const html = await this.fetcher.text(ctx, serieUrl, { headers: HEADERS });

    const activeMatch = html.match(/class="episodeOption active"\s+data-contentid="(\d+)"/);
    if (activeMatch?.[1]) return parseInt(activeMatch[1]);

    const seasonRegex = new RegExp(`data-season="${tmdbId.season}"[\\s\\S]*?data-contentid="(\\d+)"`, 'i');
    const contentIdMatch = html.match(seasonRegex);
    return contentIdMatch?.[1] ? parseInt(contentIdMatch[1]) : undefined;
  }

  private async fetchServerIds(ctx: Context, serieUrl: URL, contentId: number): Promise<string[]> {
    const ajaxHeaders = { ...HEADERS, 'Accept': 'application/json', 'Content-Type': 'application/json', 'Referer': serieUrl.href };

    try {
      const optionsResp = await this.fetcher.json(ctx, new URL(OPTIONS_API), {
        method: 'POST',
        headers: ajaxHeaders,
        data: { content_id: contentId, content_type: 2 },
      });

      const serverIds: string[] = [];
      const regex = /["']ID["']\s*:\s*(\d+)/g;
      const optionsText = JSON.stringify(optionsResp);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(optionsText)) !== null) {
        if (match[1]) serverIds.push(match[1]);
      }
      return serverIds;
    } catch {
      return [];
    }
  }

  private async fetchStreamUrl(ctx: Context, serieUrl: URL, contentId: number, serverId: string): Promise<SourceResult | undefined> {
    const ajaxHeaders = { ...HEADERS, 'Accept': 'application/json', 'Content-Type': 'application/json', 'Referer': serieUrl.href };

    try {
      const playerResp = await this.fetcher.json(ctx, new URL(PLAYER_API), {
        method: 'POST',
        headers: ajaxHeaders,
        data: { content_info: contentId, content_type: 2, video_id: parseInt(serverId) },
      });

      const playerUrl = (JSON.stringify(playerResp).match(/["']video_url["']\s*:\s*["'](.*?)["']/) as string[])?.[1]?.replace(/\\/g, '');
      if (!playerUrl) return;

      const playerPage = await this.fetcher.text(ctx, new URL(playerUrl), { headers: { Referer: serieUrl.href } });
      const finalMatch = playerPage.match(/window\.location\.href\s*=\s*"([^"]+)"/);
      if (!finalMatch?.[1]) return;

      const embedUrl = finalMatch[1];
      const embedPage = await this.fetcher.text(ctx, new URL(embedUrl), {
        headers: { Referer: playerUrl, 'User-Agent': HEADERS['User-Agent'] },
      });

      const deobf = unpackEval(embedPage);
      const hostListMatch = deobf.match(/"hostList"\s*:\s*\{"1"\s*:\s*\["([^"]+)"\]/);
      const videoUrlMatch = deobf.match(/"videoUrl"\s*:\s*"([^"]+)"/);
      if (!hostListMatch?.[1] || !videoUrlMatch?.[1]) return;

      return {
        url: new URL(`https://${hostListMatch[1]}${videoUrlMatch[1].replace(/\\\//g, '/')}`),
        meta: { countryCodes: [CountryCode.pt], referer: embedUrl },
      };
    } catch {
      return undefined;
    }
  }
}

import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode } from '../types';
import { Fetcher, Id } from '../utils';
import { resolveTmdbId, getTmdbDetails } from './tmdb-helper';
import { Source, SourceResult } from './Source';

const SERVERS: Record<string, string> = {
  Superflix: 'https://api.videasy.net/superflix/sources-with-title',
  Overflix: 'https://api2.videasy.net/overflix/sources-with-title',
  VisaoCine: 'https://api.videasy.net/visioncine/sources-with-title',
};

const DECRYPT_API = 'https://enc-dec.app/api/dec-videasy';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Connection': 'keep-alive',
};

export class Videasy extends Source {
  public readonly id = 'videasy';

  public readonly label = 'Videasy (BR)';

  public readonly contentTypes: ContentType[] = ['movie', 'series'];

  public readonly countryCodes: CountryCode[] = [CountryCode.pt];

  public override readonly ttl: number = 0; // no cache - URLs expire in seconds

  public readonly baseUrl = 'https://videasy.net';

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  public async handleInternal(ctx: Context, type: ContentType, id: Id): Promise<SourceResult[]> {
    const tmdbId = await resolveTmdbId(ctx, this.fetcher, id);
    const numericId = tmdbId.id;
    const { title, year, imdbId } = await getTmdbDetails(ctx, this.fetcher, tmdbId);

    const results: SourceResult[] = [];

    await Promise.all(
      Object.entries(SERVERS).map(async ([, serverUrl]) => {
        try {
          const params = new URLSearchParams({
            tmdbId: String(numericId),
            mediaType: type === 'series' ? 'tv' : 'movie',
            title,
            year,
            imdbId,
            ...(tmdbId.season && { seasonId: String(tmdbId.season), episodeId: String(tmdbId.episode) }),
          });

          const encryptedText = await this.fetcher.text(ctx, new URL(`${serverUrl}?${params}`), { headers: FETCH_HEADERS });
          if (!encryptedText?.trim()) return;

          const decrypted = await this.fetcher.json(ctx, new URL(DECRYPT_API), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: { text: encryptedText, id: numericId },
          });

          for (const source of (decrypted?.result?.sources ?? decrypted?.sources ?? []) as { url: string }[]) {
            if (source.url) {
              results.push({
                url: new URL(source.url),
                meta: {
                  countryCodes: [CountryCode.pt],
                  referer: 'https://videasy.net/',
                  requestHeaders: {
                    'Referer': 'https://videasy.net/',
                    'Origin': 'https://videasy.net',
                  },
                },
              });
            }
          }
        } catch {
          // ignore individual server failures
        }
      }),
    );

    return results;
  }
}

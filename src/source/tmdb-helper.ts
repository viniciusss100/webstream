import { Context } from '../types';
import { Fetcher } from '../utils/Fetcher';
import { ImdbId, TmdbId } from '../utils/id';
import { Id } from '../utils/id';

const TMDB_API_KEY = process.env['TMDB_API_KEY'] ?? 'd131017ccc6e5462a81c9304d21476de';

const tmdbCache = new Map<string, number>();
const detailsCache = new Map<number, { title: string; year: string; imdbId: string }>();

export async function resolveTmdbId(ctx: Context, fetcher: Fetcher, id: Id): Promise<TmdbId> {
  if (id instanceof TmdbId) return id;

  const imdbId = id as ImdbId;
  const cached = tmdbCache.get(imdbId.id);
  if (cached) return new TmdbId(cached, imdbId.season, imdbId.episode);

  const url = new URL(`https://api.themoviedb.org/3/find/${imdbId.id}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('external_source', 'imdb_id');

  const data = await fetcher.json(ctx, url) as {
    movie_results: { id: number }[];
    tv_results: { id: number }[];
  };

  const numericId = (imdbId.season ? data.tv_results[0] : data.movie_results[0])?.id;
  if (!numericId) throw new Error(`TMDB ID not found for ${imdbId.id}`);

  tmdbCache.set(imdbId.id, numericId);
  return new TmdbId(numericId, imdbId.season, imdbId.episode);
}

export async function getTmdbDetails(ctx: Context, fetcher: Fetcher, tmdbId: TmdbId): Promise<{ title: string; year: string; imdbId: string }> {
  const cached = detailsCache.get(tmdbId.id);
  if (cached) return cached;

  const isTv = tmdbId.season !== undefined;
  const type = isTv ? 'tv' : 'movie';
  const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}/external_ids`);
  url.searchParams.set('api_key', TMDB_API_KEY);

  const detailUrl = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}`);
  detailUrl.searchParams.set('api_key', TMDB_API_KEY);

  const [extIds, details] = await Promise.all([
    fetcher.json(ctx, url) as Promise<{ imdb_id?: string }>,
    fetcher.json(ctx, detailUrl) as Promise<{ title?: string; name?: string; release_date?: string; first_air_date?: string }>,
  ]);

  const result = {
    title: details.title ?? details.name ?? '',
    year: (details.release_date ?? details.first_air_date ?? '').slice(0, 4),
    imdbId: extIds.imdb_id ?? '',
  };

  detailsCache.set(tmdbId.id, result);
  return result;
}

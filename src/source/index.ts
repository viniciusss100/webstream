import { envGet, Fetcher } from '../utils';
import { Fembed } from './Fembed';
import { FSHD } from './FSHD';
import { Source } from './Source';
import { Videasy } from './Videasy';

export * from './Source';

export const createSources = (fetcher: Fetcher): Source[] => {
  const disabledSources = envGet('DISABLED_SOURCES')?.split(',') ?? [];

  return [
    // PT (BR)
    new Fembed(fetcher),
    new FSHD(fetcher),
    new Videasy(fetcher),
  ].filter(source => !disabledSources.includes(source.id));
};

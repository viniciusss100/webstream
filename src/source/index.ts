import { envGet, Fetcher } from '../utils';
import { Fembed } from './Fembed';
import { FSHD } from './FSHD';
import { FourKHDHub } from './FourKHDHub';
import { HDHub4u } from './HDHub4u';
import { RgShows } from './RgShows';
import { Source } from './Source';
import { Videasy } from './Videasy';
import { VidSrc } from './VidSrc';
import { VixSrc } from './VixSrc';

export * from './Source';

export const createSources = (fetcher: Fetcher): Source[] => {
  const disabledSources = envGet('DISABLED_SOURCES')?.split(',') ?? [];

  return [
    // multi
    new FourKHDHub(fetcher),
    new HDHub4u(fetcher),
    new VixSrc(fetcher),
    new VidSrc(),
    new RgShows(fetcher),
    // PT (BR)
    new Fembed(fetcher),
    new FSHD(fetcher),
    new Videasy(fetcher),
  ].filter(source => !disabledSources.includes(source.id));
};

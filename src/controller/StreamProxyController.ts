import axios from 'axios';
import { Request, Response, Router } from 'express';

const PROXY_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

export class StreamProxyController {
  public readonly router: Router;

  public constructor() {
    this.router = Router();
    this.router.get('/stream-proxy', this.proxy.bind(this));
  }

  private async proxy(req: Request, res: Response) {
    const url = req.query['url'] as string;
    const referer = req.query['referer'] as string | undefined;
    if (!url) { res.status(400).send('Missing url'); return; }

    try {
      const headers: Record<string, string> = { ...PROXY_HEADERS };
      if (referer) {
        headers['Referer'] = referer;
        headers['Origin'] = new URL(referer).origin;
      }

      const isLikelyM3U8 = url.includes('.m3u8') || url.includes('type=hls');

      if (isLikelyM3U8) {
        const { data } = await axios.get<string>(url, { headers, responseType: 'text', transformResponse: [d => d] });
        const proxyBase = `${req.protocol}://${req.host}/stream-proxy`;
        const refParam = referer ? `&referer=${encodeURIComponent(referer)}` : '';
        
        // Ensure the rewritten URLs in the M3U8 also point back to our proxy
        const rewritten = data
          .replace(/^(https?:\/\/[^\s]+)$/gm, (m) => `${proxyBase}?url=${encodeURIComponent(m)}${refParam}`)
          .replace(/URI="(https?:\/\/[^"]+)"/g, (_, u) => `URI="${proxyBase}?url=${encodeURIComponent(u)}${refParam}"`);
        
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.send(rewritten);
      } else {
        const response = await axios.get(url, { headers, responseType: 'stream' });
        res.setHeader('Content-Type', response.headers['content-type'] ?? 'video/mp2t');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        response.data.pipe(res);
      }
    } catch {
      res.status(502).send('Proxy error');
    }
  }
}

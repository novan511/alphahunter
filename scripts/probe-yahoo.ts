const symbols = ['GC=F', 'SI=F', 'CL=F', 'BZ=F', 'HG=F', 'NG=F', 'BTC-USD'];

async function main() {
  for (const s of symbols) {
    const url =
      'https://query1.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(s) +
      '?interval=1d&range=3mo';
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      });
      const text = await res.text();
      let n = 0;
      try {
        const j = JSON.parse(text);
        n = j?.chart?.result?.[0]?.timestamp?.length ?? 0;
      } catch {
        /* ignore */
      }
      console.log(s, res.status, 'bars', n, text.slice(0, 120).replace(/\n/g, ' '));
    } catch (e) {
      console.log(s, 'ERR', (e as Error).message);
    }
  }
}

main();

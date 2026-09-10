import { fetchWithRetry } from '../lib/api';

async function main() {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent('CL=F') +
    '?interval=1d&range=3mo';
  console.log('URL', url);
  const res = await fetchWithRetry(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
  });
  console.log('status', res.status);
  const text = await res.text();
  console.log(text.slice(0, 200));
}

main().catch((e) => console.error(e));

import { fetchYahooChart } from '../lib/yahoo';

async function main() {
  for (const range of ['3mo', '1y', '2y', '5y']) {
    try {
      const c = await fetchYahooChart('CL=F', '1d', range);
      console.log('CL=F', range, 'bars', c.length);
    } catch (e) {
      console.log('CL=F', range, 'FAIL', (e as Error).message);
    }
  }
  try {
    const g = await fetchYahooChart('GC=F', '1d', '2y');
    console.log('GC=F 2y bars', g.length);
  } catch (e) {
    console.log('GC=F 2y FAIL', (e as Error).message);
  }
}

main();
